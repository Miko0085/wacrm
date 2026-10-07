import { timingSafeEqual } from 'node:crypto'
import { after } from 'next/server'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { drainPendingExecutions } from '@/lib/automations/pending-drain'
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume'
import { drainInboundDebounceJobs } from '@/lib/whatsapp/inbound-debounce'
import { drainBusinessEvents } from '@/lib/business-events/dispatch'
import { collectQueueStats, runOrchestrationRetention } from '@/lib/ops/orchestration-ops'
import {
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core'

export const maxDuration = 300

/**
 * Time budget for STARTING new work. Jobs already running are allowed to
 * finish (their leases cover a hard platform kill), so this is deliberately
 * well under maxDuration to leave room for one slow LLM-backed job.
 */
const CRON_START_BUDGET_MS = 180_000

const EMPTY_DRAIN = { processed: 0, failed: 0, recovered: 0, dead: 0, skipped: 0 }

/** A category that throws must never take the others down with it. */
async function settle<T extends object>(
  label: string,
  fallback: T,
  work: () => Promise<T>,
): Promise<T & { error?: true }> {
  try {
    return await work()
  } catch (error) {
    console.error(
      `[cron] ${label} failed:`,
      error instanceof Error ? error.message : error,
    )
    return { ...fallback, error: true }
  }
}

/**
 * Shared scheduler tick.
 *
 * Categories (each independent, each with bounded concurrency and the same
 * start deadline — a slow one cannot starve or block the rest):
 * - resume due automation_pending_executions (wait steps);
 * - drain inbound debounce jobs (Flow/Automation/AI decisioning);
 * - drain durable business events;
 * - claim + deliver scheduled broadcasts;
 * - retention cleanup of finished operational rows.
 *
 * The same x-cron-secret / AUTOMATION_CRON_SECRET protects all of them, so
 * the deployment does not need a second scheduler/pinger. The response
 * carries counts only — never message text or payloads.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const startedAt = Date.now()
  const deadline = startedAt + CRON_START_BUDGET_MS

  const [waits, debounce, events, broadcasts, retention] = await Promise.all([
    settle('automation waits', EMPTY_DRAIN, () =>
      drainPendingExecutions(admin, { limit: 50, concurrency: 5, deadline }),
    ),
    settle('inbound debounce', EMPTY_DRAIN, () =>
      drainInboundDebounceJobs(admin, { limit: 20, concurrency: 3, deadline }),
    ),
    settle('business events', EMPTY_DRAIN, () =>
      drainBusinessEvents(admin, { limit: 20, concurrency: 4, deadline }),
    ),
    settle('scheduled broadcasts', { started: 0 }, () =>
      startScheduledBroadcasts(admin),
    ),
    settle(
      'retention',
      {
        business_events_dispatched: 0,
        business_events_dead: 0,
        inbound_debounce_dead: 0,
        automation_pending_done: 0,
      },
      () => runOrchestrationRetention(admin),
    ),
  ])

  const queues = await collectQueueStats(admin).catch(() => null)
  const durationMs = Date.now() - startedAt

  // Counts only: no customer text, tokens or payloads ever reach this line.
  console.info(
    `[cron] tick ${durationMs}ms waits=${waits.processed}/${waits.failed}f/${waits.recovered}r/${waits.dead}d/${waits.skipped}s ` +
      `debounce=${debounce.processed}/${debounce.failed}f/${debounce.recovered}r/${debounce.dead}d/${debounce.skipped}s ` +
      `events=${events.processed}/${events.failed}f/${events.recovered}r/${events.dead}d/${events.skipped}s ` +
      `broadcasts=${broadcasts.started} queues=${JSON.stringify(queues)}`,
  )

  const failedCategories = [waits, debounce, events, broadcasts, retention].filter(
    (r) => 'error' in r && r.error,
  ).length

  return NextResponse.json(
    {
      // Legacy keys — dashboards/alerts may already read these.
      processed: waits.processed,
      debounced_inbound: debounce.processed,
      debounce_failed: debounce.failed,
      debounce_recovered: debounce.recovered,
      debounce_dead: debounce.dead,
      business_events: events.processed,
      business_event_failed: events.failed,
      business_event_recovered: events.recovered,
      business_event_dead: events.dead,
      scheduled_broadcasts: broadcasts.started,
      // Added in 058 hardening.
      waits,
      debounce_skipped: debounce.skipped,
      business_event_skipped: events.skipped,
      retention,
      queues,
      duration_ms: durationMs,
      failed_categories: failedCategories,
    },
    // A fully-failed tick should be visible to the scheduler/monitor.
    { status: failedCategories >= 3 ? 500 : 200 },
  )
}

async function startScheduledBroadcasts(
  admin: ReturnType<typeof supabaseAdmin>,
): Promise<{ started: number }> {
  const nowIso = new Date().toISOString()
  const { data: dueBroadcasts, error: broadcastError } = await admin
    .from('broadcasts')
    .select('id, account_id, scheduled_at')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(20)

  if (broadcastError) throw broadcastError

  let started = 0

  for (const row of dueBroadcasts ?? []) {
    const id = row.id as string
    const accountId = row.account_id as string

    const claimed = await claimBroadcastDelivery(admin, accountId, id)
    if (!claimed) continue

    try {
      const { plan, remaining } = await planBroadcastResume(
        admin,
        accountId,
        id,
        'pending',
      )

      await markBroadcastSending(admin, id)
      started++

      after(async () => {
        try {
          await deliverBroadcast(admin, plan)

          // planBroadcastResume caps one delivery pass. If a scheduled
          // audience is larger, put the still-pending campaign back on
          // the scheduler so the next cron tick continues automatically.
          if (remaining > 0) {
            await admin
              .from('broadcasts')
              .update({
                status: 'scheduled',
                scheduled_at: new Date().toISOString(),
              })
              .eq('id', id)
              .eq('status', 'sending')
          }
        } catch (error) {
          console.error(
            '[broadcast-scheduler] delivery failed:',
            error instanceof Error ? error.message : error,
          )
          await finalizeBroadcastStatus(admin, id).catch(() => {})
        } finally {
          await releaseBroadcastDelivery(admin, id)
        }
      })
    } catch (error) {
      console.error(
        '[broadcast-scheduler] failed to start scheduled broadcast:',
        id,
        error instanceof Error ? error.message : error,
      )
      await releaseBroadcastDelivery(admin, id)
    }
  }

  return { started }
}
