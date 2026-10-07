import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Operational helpers for the orchestration queues. Everything here returns
 * COUNTS only — never rows, message text, tokens or payloads — so the result
 * is always safe to put in a cron response or a log line.
 */
export interface QueueStat {
  pending: number
  dead: number
}

export interface QueueStats {
  business_events: QueueStat
  inbound_debounce: QueueStat
  automation_waits: QueueStat
}

async function countWhere(
  db: SupabaseClient,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
  if (error) return -1 // -1 = unknown; never fail the cron tick over a stat
  return count ?? 0
}

export async function collectQueueStats(db: SupabaseClient): Promise<QueueStats> {
  const [evP, evD, dbP, dbD, wP, wD] = await Promise.all([
    countWhere(db, 'business_events', 'dispatch_status', 'pending'),
    countWhere(db, 'business_events', 'dispatch_status', 'dead'),
    countWhere(db, 'inbound_debounce_jobs', 'status', 'pending'),
    countWhere(db, 'inbound_debounce_jobs', 'status', 'dead'),
    countWhere(db, 'automation_pending_executions', 'status', 'pending'),
    countWhere(db, 'automation_pending_executions', 'status', 'dead'),
  ])
  return {
    business_events: { pending: evP, dead: evD },
    inbound_debounce: { pending: dbP, dead: dbD },
    automation_waits: { pending: wP, dead: wD },
  }
}

export interface RetentionResult {
  business_events_dispatched: number
  business_events_dead: number
  inbound_debounce_dead: number
  automation_pending_done: number
}

export const DEFAULT_RETENTION = {
  dispatchedDays: 30,
  deadEventDays: 90,
  deadDebounceDays: 14,
  batch: 500,
} as const

/** Batched cleanup via the service-role-only SQL helper from migration 058. */
export async function runOrchestrationRetention(
  db: SupabaseClient,
  overrides: Partial<typeof DEFAULT_RETENTION> = {},
): Promise<RetentionResult> {
  const cfg = { ...DEFAULT_RETENTION, ...overrides }
  const { data, error } = await db.rpc('cleanup_orchestration_data', {
    p_dispatched_days: cfg.dispatchedDays,
    p_dead_event_days: cfg.deadEventDays,
    p_dead_debounce_days: cfg.deadDebounceDays,
    p_batch: cfg.batch,
  })
  if (error) throw error
  const row = (data ?? {}) as Partial<RetentionResult>
  return {
    business_events_dispatched: row.business_events_dispatched ?? 0,
    business_events_dead: row.business_events_dead ?? 0,
    inbound_debounce_dead: row.inbound_debounce_dead ?? 0,
    automation_pending_done: row.automation_pending_done ?? 0,
  }
}
