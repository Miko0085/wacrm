import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

export interface PendingBusinessEvent {
  id: string
  account_id: string
  user_id: string | null
  contact_id: string | null
  conversation_id: string | null
  event_type: string
  source: string
  payload: Record<string, unknown> | null
  dispatch_status: 'pending' | 'running' | 'dispatched' | 'dead'
  dispatch_attempts: number
  dispatch_after: string
  locked_at: string | null
}

const BUSINESS_EVENT_LEASE_MS = 5 * 60_000
const MAX_BUSINESS_EVENT_ATTEMPTS = 8

export function businessEventRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(30 * 60_000, 15_000 * 2 ** (safeAttempt - 1))
}

/**
 * Drain durable business events using an at-least-once delivery model.
 *
 * A worker crash after downstream side effects but before marking the event
 * dispatched can cause a retry. Integrations consuming event.id should treat it
 * as an idempotency key.
 */
export async function drainBusinessEvents(
  db: SupabaseClient,
  limit = 20,
): Promise<{ processed: number; failed: number; recovered: number; dead: number }> {
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const staleBefore = new Date(now - BUSINESS_EVENT_LEASE_MS).toISOString()

  const { data: staleRows, error: staleError } = await db
    .from('business_events')
    .select('id')
    .eq('dispatch_status', 'running')
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .limit(limit)

  if (staleError) throw staleError

  let recovered = 0
  for (const stale of staleRows ?? []) {
    const { data: revived, error: reviveError } = await db
      .from('business_events')
      .update({
        dispatch_status: 'pending',
        locked_at: null,
        dispatch_after: nowIso,
        last_error: 'worker lease expired; recovered by scheduler',
      })
      .eq('id', stale.id)
      .eq('dispatch_status', 'running')
      .select('id')
      .maybeSingle()
    if (!reviveError && revived) recovered += 1
  }

  const { data: rows, error } = await db
    .from('business_events')
    .select('*')
    .eq('dispatch_status', 'pending')
    .lte('dispatch_after', nowIso)
    .order('dispatch_after', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error) throw error

  let processed = 0
  let failed = 0
  let dead = 0

  for (const raw of rows ?? []) {
    const row = raw as PendingBusinessEvent
    const nextAttempt = (row.dispatch_attempts ?? 0) + 1
    const { data: claimed, error: claimError } = await db
      .from('business_events')
      .update({
        dispatch_status: 'running',
        locked_at: new Date().toISOString(),
        dispatch_attempts: nextAttempt,
      })
      .eq('id', row.id)
      .eq('dispatch_status', 'pending')
      .select('*')
      .maybeSingle()

    if (claimError || !claimed) continue

    const event = claimed as PendingBusinessEvent
    try {
      const dispatch = await runAutomationsForTrigger({
        accountId: event.account_id,
        triggerType: 'business_event',
        contactId: event.contact_id,
        context: {
          conversation_id: event.conversation_id ?? undefined,
          business_event_id: event.id,
          business_event_type: event.event_type,
          business_event_payload: event.payload ?? {},
        },
      })

      if (dispatch.failed > 0) {
        throw new Error(
          `business event automations failed: matched=${dispatch.matched} failed=${dispatch.failed}`,
        )
      }

      const { error: doneError } = await db
        .from('business_events')
        .update({
          dispatch_status: 'dispatched',
          dispatched_at: new Date().toISOString(),
          locked_at: null,
          last_error: null,
        })
        .eq('id', event.id)
        .eq('dispatch_status', 'running')

      if (doneError) throw doneError
      processed += 1
    } catch (err) {
      failed += 1
      const terminal = nextAttempt >= MAX_BUSINESS_EVENT_ATTEMPTS
      if (terminal) dead += 1
      const message = err instanceof Error ? err.message : String(err)
      console.error('[business-events] dispatch failed:', event.id, message)

      await db
        .from('business_events')
        .update({
          dispatch_status: terminal ? 'dead' : 'pending',
          locked_at: null,
          dispatch_after: new Date(Date.now() + businessEventRetryDelayMs(nextAttempt)).toISOString(),
          last_error: message,
        })
        .eq('id', event.id)
        .eq('dispatch_status', 'running')
    }
  }

  return { processed, failed, recovered, dead }
}
