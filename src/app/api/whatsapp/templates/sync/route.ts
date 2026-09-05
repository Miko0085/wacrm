import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { resolveWhatsAppProvider } from '@/lib/whatsapp/providers/resolve'
import { ProviderError } from '@/lib/whatsapp/providers/types'

/**
 * Sync message templates from the account's WhatsApp provider (Meta or
 * Gupshup — see resolveWhatsAppProvider) into the local
 * message_templates table.
 *
 * The local catalog stores the upstream status enum verbatim (APPROVED /
 * PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION)
 * so the edit / resubmit / delete flows can distinguish recoverable
 * states (PAUSED) from terminal ones (DISABLED) and so webhook events
 * land 1:1 without a translation table. Gupshup's own template statuses
 * are normalized into this same enum by the Gupshup provider (see
 * gupshup-status-map.ts).
 *
 * Locally-created templates (no upstream counterpart) are NOT deleted —
 * they remain visible so the user can notice drift and clean up.
 */
export async function POST() {
  try {
    // Syncing rewrites the account-wide template catalog, which is
    // settings-class data: `canEditSettings` and the message_templates
    // insert/update RLS policies (migration 017) both require 'admin'.
    // Resolving account_id off the profile only proved membership.
    const { supabase, accountId, userId } = await requireRole('admin')

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    let templates: Awaited<ReturnType<ReturnType<typeof resolveWhatsAppProvider>['listTemplates']>>['templates']
    let truncated = false
    try {
      const provider = resolveWhatsAppProvider(config)
      const result = await provider.listTemplates()
      templates = result.templates
      truncated = result.truncated
    } catch (err) {
      if (err instanceof ProviderError) {
        return NextResponse.json({ error: err.message }, { status: err.httpStatus ?? 502 })
      }
      throw err
    }

    let inserted = 0
    let updated = 0
    const errors: { name: string; language: string; message: string }[] = []
    const idColumn = config.provider === 'gupshup' ? 'gupshup_template_id' : 'meta_template_id'

    for (const t of templates) {
      const row = {
        // Account tenancy + user audit, same split as the submit
        // route. account_id is NOT NULL on message_templates
        // post-017, so an INSERT without it errors.
        account_id: accountId,
        user_id: userId,
        provider: config.provider ?? 'meta',
        name: t.name,
        category: t.category,
        language: t.language,
        header_type: t.headerType,
        header_content: t.headerContent,
        body_text: t.bodyText,
        footer_text: t.footerText,
        buttons: t.buttons,
        status: t.status,
        quality_score: t.qualityScore,
        [idColumn]: t.providerTemplateId,
        updated_at: new Date().toISOString(),
      }

      const { data: existing, error: lookupErr } = await supabase
        .from('message_templates')
        .select('id')
        .eq('account_id', accountId)
        .eq('name', t.name)
        .eq('language', t.language)
        .maybeSingle()

      if (lookupErr) {
        errors.push({
          name: t.name,
          language: t.language,
          message: lookupErr.message,
        })
        continue
      }

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('message_templates')
          .update(row)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({
            name: t.name,
            language: t.language,
            message: updErr.message,
          })
        } else {
          updated++
        }
      } else {
        const { error: insErr } = await supabase
          .from('message_templates')
          .insert(row)
        if (insErr) {
          errors.push({
            name: t.name,
            language: t.language,
            message: insErr.message,
          })
        } else {
          inserted++
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: templates.length,
      inserted,
      updated,
      errors,
      truncated,
    })
  } catch (error) {
    // Auth failures map to 401/403 rather than being folded into the
    // generic 500 below, which surfaces `error.message` as a sync failure.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync templates',
      },
      { status: 500 },
    )
  }
}
