import type { SupabaseClient } from '@supabase/supabase-js'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { runBounded } from '@/lib/ops/pool'

/**
 * Wait-step scheduler (automation_pending_executions) with the same lease /
 * recovery / dead-letter discipline as inbound debounce and business events.
 *
 * pending --claim--> running (locked_at, attempt_count+1)
 *   running --resume ok-->   done
 *   running --resume threw-> failed   (terminal: the steps may already have
 *                                      produced side effects, so a blind
 *                                      replay could double-send)
 *   running --lease expired (worker crashed)--> pending again, or dead once
 *                                      attempt_count reaches the budget.
 */
export const PENDING_EXECUTION_LEASE_MS = 5 * 60_000
export const MAX_PENDING_EXECUTION_ATTEMPTS = 3
const DEFAULT_PENDING_CONCURRENCY = 5

export interface PendingDrainResult {
  processed: number
  failed: number
  recovered: number
  dead: number
  skipped: number
}

export async function drainPendingExecutions(
  db: SupabaseClient,
  opts: { limit?: number; concurrency?: number; deadline?: number } = {},
): Promise<PendingDrainResult> {
  const limit = opts.limit ?? 50
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const staleBefore = new Date(now - PENDING_EXECUTION_LEASE_MS).toISOString()

  const { data: staleRows, error: staleError } = await db
    .from('automation_pending_executions')
    .select('id, attempt_count')
    .eq('status', 'running')
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .limit(limit)
  if (staleError) throw staleError

  let recovered = 0
  let dead = 0
  for (const stale of staleRows ?? []) {
    const exhausted = (stale.attempt_count ?? 0) >= MAX_PENDING_EXECUTION_ATTEMPTS
    const { data: revived, error: reviveError } = await db
      .from('automation_pending_executions')
      .update({
        status: exhausted ? 'dead' : 'pending',
        locked_at: null,
        run_at: nowIso,
        last_error: exhausted
          ? 'worker lease expired repeatedly; moved to dead-letter'
          : 'worker lease expired; recovered by scheduler',
      })
      .eq('id', stale.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle()
    if (!reviveError && revived) {
      if (exhausted) dead += 1
      else recovered += 1
    }
  }

  const { data: due, error } = await db
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(limit)
  if (error) throw error

  let processed = 0
  let failed = 0

  const pool = await runBounded(
    due ?? [],
    opts.concurrency ?? DEFAULT_PENDING_CONCURRENCY,
    async (row: Record<string, unknown>) => {
      const { data: claim } = await db
        .from('automation_pending_executions')
        .update({
          status: 'running',
          locked_at: new Date().toISOString(),
          attempt_count: ((row.attempt_count as number | undefined) ?? 0) + 1,
        })
        .eq('id', row.id as string)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()
      if (!claim) return

      try {
        await resumePendingExecution({
          id: row.id as string,
          automation_id: row.automation_id as string,
          account_id: row.account_id as string,
          user_id: row.user_id as string,
          contact_id: (row.contact_id as string | null) ?? null,
          log_id: (row.log_id as string | null) ?? null,
          parent_step_id: (row.parent_step_id as string | null) ?? null,
          branch: (row.branch as 'yes' | 'no' | null) ?? null,
          next_step_position: row.next_step_position as number,
          context: (row.context as AutomationContext) ?? {},
        })
        processed += 1
      } catch (err) {
        // resumePendingExecution owns its own try/catch; this is belt and
        // braces so one poisoned row can never abort the lane.
        failed += 1
        await db
          .from('automation_pending_executions')
          .update({
            status: 'failed',
            locked_at: null,
            last_error: err instanceof Error ? err.message.slice(0, 500) : String(err),
          })
          .eq('id', row.id as string)
      }
    },
    { deadline: opts.deadline },
  )

  return { processed, failed, recovered, dead, skipped: pool.skipped }
}
