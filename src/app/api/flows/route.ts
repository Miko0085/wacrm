import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getFlowTemplate } from '@/lib/flows/templates'

/**
 * GET /api/flows — list the caller's flows.
 * POST /api/flows — create a new (draft) flow.
 *
 * Available to every authenticated user. The previous per-account
 * beta gate was removed when Flows went to soft-GA; the UI still
 * shows a "Beta" label so users know the surface is young, but the
 * routes themselves are open.
 */

export async function GET() {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (error) {
    return toErrorResponse(error)
  }

  const { data, error } = await ctx.supabase
    .from('flows')
    .select('*')
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ flows: data ?? [] })
}

export async function POST(request: Request) {
  // Creating a flow is a write — the RLS flows_insert policy requires
  // `agent`, but this route inserts via the service-role client which
  // bypasses RLS, so the role must be enforced here.
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { userId, accountId } = ctx

  // Resolve the caller's account_id — `flows.account_id` is NOT NULL
  // post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client below bypasses RLS.
  const body = (await request.json().catch(() => null)) as
    | {
        name?: string
        description?: string | null
        trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config?: Record<string, unknown>
        /**
         * If set, clone the matching template's name + trigger +
         * entry_node_id + nodes[] into a fresh draft for this user.
         * `name` from the body overrides the template default if
         * provided.
         */
        template_slug?: string
      }
    | null
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // -------- Template clone path --------
  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug)
    if (!template) {
      return NextResponse.json(
        { error: `Unknown template_slug "${body.template_slug}"` },
        { status: 400 },
      )
    }
    const { data: flow, error: flowErr } = await admin
      .from('flows')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: body.name?.trim() || template.name,
        description: template.description,
        status: 'draft',
        trigger_type: template.trigger_type,
        trigger_config: template.trigger_config,
        entry_node_id: template.entry_node_id,
      })
      .select()
      .single()
    if (flowErr || !flow) {
      return NextResponse.json(
        { error: flowErr?.message ?? 'flow insert failed' },
        { status: 500 },
      )
    }
    if (template.nodes.length > 0) {
      const { error: nodesErr } = await admin.from('flow_nodes').insert(
        template.nodes.map((n) => ({
          flow_id: flow.id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        })),
      )
      if (nodesErr) {
        // Roll back the parent flow so a half-cloned template doesn't
        // sit as an empty draft. CASCADE on flow_id removes the
        // (probably zero) nodes too.
        await admin.from('flows').delete().eq('id', flow.id)
        return NextResponse.json(
          { error: nodesErr.message },
          { status: 500 },
        )
      }
    }
    return NextResponse.json({ flow }, { status: 201 })
  }

  // -------- Plain (empty) create path --------
  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const trigger_type = body.trigger_type ?? 'keyword'

  const { data, error } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      trigger_type,
      trigger_config: body.trigger_config ?? {},
    })
    .select()
    .single()
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'insert failed' },
      { status: 500 },
    )
  }
  return NextResponse.json({ flow: data }, { status: 201 })
}
