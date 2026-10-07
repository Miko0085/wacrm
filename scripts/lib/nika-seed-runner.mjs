// Orchestrates the Nika seed against an injected Supabase-like client, so the
// whole decision tree (dry run, conflicts, --adopt-existing, active runs,
// idempotent re-apply) is unit-testable without a database. The CLI wrapper is
// scripts/seed-nika-orchestration.mjs.

import {
  NAMES,
  PROTECTED_AUTOMATION_NAMES,
  assertFlowGraphSane,
  buildAutomationSpecs,
  buildFlowSpec,
  flattenSteps,
  withMarker,
} from './nika-seed-plan.mjs'

export class SeedConflictError extends Error {
  constructor(conflicts) {
    super('seed conflict: managed names exist without the managed marker')
    this.name = 'SeedConflictError'
    this.conflicts = conflicts
  }
}

/** Secrets (webhook URL path/query, headers) must never reach the console. */
export function redact(value) {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (key === 'headers' && v && typeof v === 'object') {
        return Object.fromEntries(Object.keys(v).map((k) => [k, '[redacted]']))
      }
      if (key === 'url' && typeof v === 'string') {
        try {
          return `${new URL(v).origin}/[redacted]`
        } catch {
          return '[redacted]'
        }
      }
      return v
    }),
  )
}

const ACTION = { managed: 'UPDATE', conflict: 'CONFLICT', new: 'CREATE' }

/**
 * @typedef {object} SeedOptions
 * @property {any} db supabase-js compatible client (service role)
 * @property {string} accountId
 * @property {boolean} apply false = dry run, performs no writes at all
 * @property {boolean} [adopt] stamp the marker onto same-name unmarked objects
 * @property {Record<string, string | undefined>} [env]
 * @property {(msg: string) => void} [log]
 *
 * @param {SeedOptions} options
 * @returns {Promise<{applied: boolean, conflicts: any[], flowId?: string, automationIds?: Record<string, string>}>}
 */
export async function runSeed({ db, accountId, apply, adopt = false, env = process.env, log = console.log }) {
  const logPlan = (title, body) => {
    log(`\n=== ${title} ===`)
    log(JSON.stringify(redact(body), null, 2))
  }

  async function resolveOwnerUserId() {
    if (env.NIKA_WACRM_OWNER_USER_ID) return env.NIKA_WACRM_OWNER_USER_ID

    // Read-only lookup of the protected automation's owner.
    const { data: existing } = await db
      .from('automations')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('name', PROTECTED_AUTOMATION_NAMES[0])
      .maybeSingle()
    if (existing?.user_id) return existing.user_id

    const { data: member } = await db
      .from('account_memberships')
      .select('user_id, role')
      .eq('account_id', accountId)
      .in('role', ['owner', 'admin'])
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!member?.user_id) {
      throw new Error('Could not resolve an account owner/admin. Set NIKA_WACRM_OWNER_USER_ID.')
    }
    return member.user_id
  }

  /** managed (marker) | conflict (same name, no marker) | new */
  async function locate(table, marker, name) {
    const { data, error } = await db
      .from(table)
      .select('id, name, description')
      .eq('account_id', accountId)
    if (error) throw error
    const rows = data ?? []
    const managed = rows.find((r) => (r.description || '').includes(marker))
    if (managed) return { state: 'managed', row: managed }
    const sameName = rows.find((r) => r.name === name)
    if (sameName) return { state: 'conflict', row: sameName }
    return { state: 'new', row: null }
  }

  async function resolveTelegramConnection() {
    const configuredId = (env.NIKA_TELEGRAM_CONNECTION_ID || '').trim()
    if (configuredId) return configuredId

    const preferredName = (env.NIKA_TELEGRAM_CONNECTION_NAME || '').trim()
    let query = db
      .from('telegram_connections')
      .select('id, name')
      .eq('account_id', accountId)
      .eq('is_active', true)
    if (preferredName) query = query.eq('name', preferredName)

    const { data, error } = await query.order('created_at', { ascending: true }).limit(1)
    if (error) {
      // Migration may not have been applied in dry-run mode yet.
      if (!apply) return null
      throw error
    }
    return data?.[0]?.id ?? null
  }

  async function adoptRow(table, row, marker) {
    const { error } = await db
      .from(table)
      .update({ description: withMarker(row.description, marker) })
      .eq('id', row.id)
      .eq('account_id', accountId)
    if (error) throw error
    log(`Adopted existing ${table} "${row.name}" (${row.id}) under ${marker}`)
  }

  log(apply ? 'MODE: APPLY' : 'MODE: DRY RUN (no writes; pass --apply to write)')
  log(`Account: ${accountId}`)

  const userId = await resolveOwnerUserId()
  log(`Owner user: ${userId}`)

  const flowSpec = buildFlowSpec(env)
  assertFlowGraphSane(flowSpec.nodes, flowSpec.row.entry_node_id)

  const telegramConnectionId = await resolveTelegramConnection()
  const automationSpecs = buildAutomationSpecs({
    env,
    flowId: '<flow-id-after-apply>',
    telegramConnectionId,
  })

  for (const spec of automationSpecs) {
    if (PROTECTED_AUTOMATION_NAMES.includes(spec.row.name)) {
      throw new Error(`Refusing to manage protected automation "${spec.row.name}"`)
    }
  }

  // ---- Preflight: classify every object BEFORE writing anything. ----
  const flowLoc = await locate('flows', flowSpec.marker, NAMES.flow)
  const automationLocs = []
  for (const spec of automationSpecs) {
    automationLocs.push({ spec, loc: await locate('automations', spec.marker, spec.row.name) })
  }

  const conflicts = [
    ...(flowLoc.state === 'conflict' ? [{ kind: 'flow', ...flowLoc.row }] : []),
    ...automationLocs
      .filter((s) => s.loc.state === 'conflict')
      .map((s) => ({ kind: 'automation', ...s.loc.row })),
  ]

  logPlan('FLOW', {
    action: ACTION[flowLoc.state],
    existing_id: flowLoc.row?.id ?? null,
    row: flowSpec.row,
    node_count: flowSpec.nodes.length,
    nodes: flowSpec.nodes,
  })
  for (const { spec, loc } of automationLocs) {
    logPlan(`AUTOMATION ${spec.key}`, {
      action: ACTION[loc.state],
      existing_id: loc.row?.id ?? null,
      row: spec.row,
      steps: spec.steps,
    })
  }

  if (conflicts.length > 0 && !adopt) {
    throw new SeedConflictError(conflicts)
  }

  if (!telegramConnectionId) {
    log(
      '\nTelegram handoff automation is created/updated INACTIVE until a Telegram connection exists. Re-run this seed after connecting a bot.',
    )
  }
  if (!automationSpecs.some((s) => s.key === 'webhook')) {
    log('\nNo NIKA_HANDOFF_WEBHOOK_URL set; external handoff webhook automation was not created.')
  }
  log(
    '\nExisting production automation "Cold WhatsApp — Positive Lead → amoCRM" is intentionally untouched.',
  )

  if (!apply) {
    if (conflicts.length > 0) {
      log('\n(dry run) --adopt-existing would stamp the managed marker on the conflicting objects above.')
    }
    log('\nDry run only. Re-run with --apply to write.')
    return { applied: false, conflicts }
  }

  // ---- Apply. Each RPC is a single transaction. ----
  if (flowLoc.state === 'managed') {
    const { count, error } = await db
      .from('flow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('flow_id', flowLoc.row.id)
      .eq('status', 'active')
    if (error) throw error
    if ((count ?? 0) > 0) {
      throw new Error(
        `Refusing to replace managed flow while ${count} active run(s) exist. Finish/handoff them first.`,
      )
    }
  }

  if (adopt) {
    if (flowLoc.state === 'conflict') await adoptRow('flows', flowLoc.row, flowSpec.marker)
    for (const { spec, loc } of automationLocs) {
      if (loc.state === 'conflict') await adoptRow('automations', loc.row, spec.marker)
    }
  }

  const { data: flowId, error: flowError } = await db.rpc('upsert_managed_flow', {
    p_account_id: accountId,
    p_user_id: userId,
    p_marker: flowSpec.marker,
    p_flow: flowSpec.row,
    p_nodes: flowSpec.nodes,
  })
  if (flowError) throw new Error(`upsert_managed_flow failed: ${flowError.message}`)
  log(`Flow ready: ${flowId}`)

  const ids = {}
  for (const spec of buildAutomationSpecs({ env, flowId, telegramConnectionId })) {
    const { data: id, error } = await db.rpc('upsert_managed_automation', {
      p_account_id: accountId,
      p_user_id: userId,
      p_marker: spec.marker,
      p_automation: spec.row,
      p_steps: flattenSteps(spec.steps),
    })
    if (error) throw new Error(`upsert_managed_automation(${spec.key}) failed: ${error.message}`)
    ids[spec.key] = id
    log(`Automation ready: ${spec.row.name} (${id}) active=${spec.row.is_active}`)
  }

  log('\nSeed applied. Re-running it is safe (idempotent).')
  return { applied: true, flowId, automationIds: ids, conflicts }
}
