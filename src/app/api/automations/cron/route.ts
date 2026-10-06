import { timingSafeEqual } from 'node:crypto'
import { after } from 'next/server'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume'
import { drainInboundDebounceJobs } from '@/lib/whatsapp/inbound-debounce'
import {
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core'

export const maxDuration = 300

/**
 * Shared scheduler tick.
 *
 * Existing responsibility:
 * - resume due automation_pending_executions rows.
 *
 * Broadcast scheduling responsibility:
 * - claim broadcasts whose status='scheduled' and scheduled_at <= now();
 * - reuse the existing server-side broadcast resume/delivery pipeline;
 * - acknowledge quickly while the fan-out continues in after().
 *
 * The same x-cron-secret / AUTOMATION_CRON_SECRET protects both jobs,
 * so the deployment does not need a second scheduler/pinger.
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
  const nowIso = new Date().toISOString()

  const { data: dueAutomations, error: automationError } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(50)

  if (automationError) {
    return NextResponse.json({ error: automationError.message }, { status: 500 })
  }

  let processed = 0
  for (const row of dueAutomations ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (!claim) continue

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
    processed++
  }

  const debounceResult = await drainInboundDebounceJobs(admin, 50).catch((error) => {
    console.error(
      '[inbound-debounce] cron drain failed:',
      error instanceof Error ? error.message : error,
    )
    return { processed: 0, failed: 1 }
  })

  const { data: dueBroadcasts, error: broadcastError } = await admin
    .from('broadcasts')
    .select('id, account_id, scheduled_at')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(20)

  if (broadcastError) {
    return NextResponse.json(
      {
        error: broadcastError.message,
        processed,
        debounced_inbound: debounceResult.processed,
        debounce_failed: debounceResult.failed,
      },
      { status: 500 },
    )
  }

  let scheduledBroadcasts = 0

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
      scheduledBroadcasts++

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

  return NextResponse.json({
    processed,
    debounced_inbound: debounceResult.processed,
    debounce_failed: debounceResult.failed,
    scheduled_broadcasts: scheduledBroadcasts,
  })
}
