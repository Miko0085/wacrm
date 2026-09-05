import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  isValidGupshupEnvelope,
  normalizeGupshupInboundMessage,
  normalizeGupshupStatusEvent,
  normalizeGupshupUserEvent,
  type GupshupWebhookEnvelope,
} from '@/lib/whatsapp/providers/gupshup-webhook'
import {
  handleStatusUpdate,
  resolveInboundThread,
  finishProcessingInboundMessage,
} from '@/lib/whatsapp/inbound-pipeline'

// See src/app/api/whatsapp/webhook/route.ts (Meta) for why `after()` +
// a generous maxDuration matter here too — ack Gupshup fast, keep
// processing alive past the response.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * POST /api/whatsapp/gupshup/webhook/[token]
 *
 * Gupshup's inbound webhook. Unlike Meta's, Gupshup callbacks carry no
 * HMAC signature to verify — per Gupshup's own docs, the webhook URL is
 * simply pasted into their dashboard with no signing mechanism offered
 * (see docs/GUPSHUP_INTEGRATION.md, "Webhook security"). The security
 * boundary here is instead:
 *   1. an unguessable, per-account, random 24-byte token in the URL
 *      path (generated once in POST /api/whatsapp/config, never logged
 *      or shown again after save),
 *   2. a rate limit keyed to that token,
 *   3. strict payload-shape validation before any DB write.
 * This is a documented limitation, not a fabricated signature scheme —
 * an operator who suspects their token leaked can regenerate it by
 * disconnecting and reconnecting Gupshup in Settings.
 *
 * Downstream of "verify + parse", this reuses the EXACT SAME shared
 * pipeline (src/lib/whatsapp/inbound-pipeline.ts) the Meta webhook
 * uses — one Inbox, one dedup/status-ladder implementation, one set of
 * flows/automations/AI dispatch rules, regardless of provider.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params
  if (!token || token.length < 16) {
    // Too short to be a real generated token — don't even touch the DB.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const limit = checkRateLimit(`gupshup-webhook:${token}`, RATE_LIMITS.gupshupWebhook)
  if (!limit.success) {
    return rateLimitResponse(limit)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!isValidGupshupEnvelope(body)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id')
    .eq('gupshup_webhook_token', token)
    .eq('provider', 'gupshup')
    .maybeSingle()

  if (configError || !config) {
    // Same 404 whether the token is malformed, unknown, or belongs to
    // an account that's since switched back to Meta — never confirm a
    // token's validity to an unauthenticated caller.
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  after(async () => {
    try {
      await processGupshupWebhook(body as GupshupWebhookEnvelope, config.account_id, config.user_id)
    } catch (error) {
      console.error('[gupshup-webhook] Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processGupshupWebhook(
  envelope: GupshupWebhookEnvelope,
  accountId: string,
  configOwnerUserId: string,
) {
  const db = supabaseAdmin()

  switch (envelope.type) {
    case 'message': {
      const normalized = normalizeGupshupInboundMessage(envelope)
      if (!normalized) {
        console.warn('unsupported_provider_event', {
          provider: 'gupshup',
          event: 'message',
          rawType: (envelope.payload as { type?: string })?.type,
        })
        return
      }
      const thread = await resolveInboundThread(
        db,
        accountId,
        configOwnerUserId,
        normalized.fromPhone,
        normalized.contactName,
      )
      if (!thread) return
      await finishProcessingInboundMessage(db, accountId, configOwnerUserId, thread, normalized)
      return
    }

    case 'message-event': {
      const status = normalizeGupshupStatusEvent(envelope)
      if (!status) {
        console.warn('unsupported_provider_event', {
          provider: 'gupshup',
          event: 'message-event',
          rawType: (envelope.payload as { type?: string })?.type,
        })
        return
      }
      await handleStatusUpdate(db, status)
      return
    }

    case 'user-event': {
      const userEvent = normalizeGupshupUserEvent(envelope)
      if (!userEvent) {
        console.warn('unsupported_provider_event', {
          provider: 'gupshup',
          event: 'user-event',
        })
        return
      }
      await applyUserEvent(db, accountId, userEvent)
      return
    }

    default:
      // Template/account/billing events we don't act on — logged, not
      // silently discarded, per requirement #20.
      console.info('unsupported_provider_event', {
        provider: 'gupshup',
        event: envelope.type,
      })
  }
}

/**
 * Opt-in/opt-out (Gupshup `user-event`) → the shared, provider-
 * independent consent model on `contacts` (migration 040). Matched by
 * digits-only phone (same normalization every other phone lookup in
 * this codebase uses) — creates no contact row if none exists yet
 * (an opt-out from a number we've never talked to has nothing to
 * suppress).
 */
async function applyUserEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  event: { phone: string; type: 'opted-in' | 'opted-out' },
) {
  const normalizedPhone = event.phone.replace(/\D/g, '')
  const nowIso = new Date().toISOString()
  const update =
    event.type === 'opted-out'
      ? { wa_marketing_status: 'OPTED_OUT', wa_opt_out_at: nowIso, wa_consent_source: 'gupshup_user_event' }
      : { wa_marketing_status: 'OPTED_IN', wa_opt_in_at: nowIso, wa_consent_source: 'gupshup_user_event' }

  const { error } = await db
    .from('contacts')
    .update(update)
    .eq('account_id', accountId)
    .eq('phone_normalized', normalizedPhone)

  if (error) {
    console.error('[gupshup-webhook] Failed to apply user-event consent update:', error.message)
  }
}
