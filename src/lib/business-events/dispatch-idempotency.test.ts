import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeDb, type FakeDb } from '@/test-utils/fake-db'

// REAL automation engine + fake database: proves the retry contract end to end.
const h = vi.hoisted(() => ({ db: null as unknown, sendTelegram: vi.fn() }))

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: vi.fn(),
  engineSendTemplate: vi.fn(),
  engineSendInteractive: vi.fn(),
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: vi.fn() }))
vi.mock('@/lib/telegram/send', () => ({ sendTelegramNotification: h.sendTelegram }))
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: vi.fn(async () => true) }))
vi.mock('@/lib/contacts/tag-write', () => ({ addContactTagIfAbsent: vi.fn() }))
vi.mock('@/lib/automations/ai-classification', () => ({
  classifyAutomationMessage: vi.fn(),
  classificationTakesYesBranch: vi.fn(),
  classificationVars: vi.fn(),
}))

import { drainBusinessEvents } from './dispatch'

const past = (ms = 1000) => new Date(Date.now() - ms).toISOString()

function setup(): FakeDb {
  const db = createFakeDb(
    {
      contacts: [{ id: 'c-1', account_id: 'acc-1' }],
      business_events: [
        {
          id: 'ev-1',
          account_id: 'acc-1',
          user_id: 'u-1',
          contact_id: 'c-1',
          conversation_id: 'conv-1',
          event_type: 'human_handoff_requested',
          source: 't',
          payload: { reason: 'x' },
          created_at: past(5000),
          dispatch_status: 'pending',
          dispatch_attempts: 0,
          dispatch_after: past(),
          locked_at: null,
          chain_depth: 0,
        },
      ],
      automations: [
        {
          id: 'auto-webhook-ok',
          account_id: 'acc-1',
          user_id: 'u-1',
          trigger_type: 'business_event',
          trigger_config: { event_types: ['human_handoff_requested'] },
          is_active: true,
          created_at: past(9000),
        },
        {
          id: 'auto-telegram',
          account_id: 'acc-1',
          user_id: 'u-1',
          trigger_type: 'business_event',
          trigger_config: { event_types: ['human_handoff_requested'] },
          is_active: true,
          created_at: past(8000),
        },
      ],
      automation_steps: [
        // First automation: add nothing risky; counted through its log rows.
        { id: 'st-1', automation_id: 'auto-webhook-ok', parent_step_id: null, position: 0, step_type: 'close_conversation', step_config: {} },
        // Second automation: Telegram notification (fails until fixed).
        {
          id: 'st-2',
          automation_id: 'auto-telegram',
          parent_step_id: null,
          position: 0,
          step_type: 'send_telegram',
          step_config: { connection_id: 'tg-1', message: 'handoff {{event.reason}}' },
        },
      ],
      automation_logs: [],
      automation_pending_executions: [],
      conversations: [{ id: 'conv-1', account_id: 'acc-1', contact_id: 'c-1', status: 'open' }],
    },
    { rpc: { increment_automation_execution_count: () => null } },
  )
  h.db = db
  return db
}

const runs = (db: FakeDb, automationId: string) =>
  db.tables.automation_logs.filter((l) => l.automation_id === automationId)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('business event retry never repeats an automation that already succeeded', () => {
  it('1st automation succeeds, 2nd fails -> event retries -> only the 2nd runs again', async () => {
    const db = setup()
    h.sendTelegram.mockRejectedValue(new Error('Telegram 502'))

    // Attempt 1: automation #1 OK, #2 fails -> event goes back to pending.
    let res = await drainBusinessEvents(db as unknown as SupabaseClient)
    expect(res).toMatchObject({ failed: 1, processed: 0 })
    expect(db.tables.business_events[0]).toMatchObject({ dispatch_status: 'pending', dispatch_attempts: 1 })
    expect(runs(db, 'auto-webhook-ok')).toHaveLength(1)
    expect(runs(db, 'auto-webhook-ok')[0].status).toBe('success')
    expect(runs(db, 'auto-telegram')).toHaveLength(1)
    expect(runs(db, 'auto-telegram')[0].status).toBe('failed')
    expect(runs(db, 'auto-webhook-ok')[0].business_event_id).toBe('ev-1')

    // Attempt 2 (after backoff): still failing. #1 must NOT run again.
    db.tables.business_events[0].dispatch_after = past()
    res = await drainBusinessEvents(db as unknown as SupabaseClient)
    expect(res.failed).toBe(1)
    expect(runs(db, 'auto-webhook-ok')).toHaveLength(1) // unchanged
    expect(runs(db, 'auto-telegram')).toHaveLength(2) // retried

    // Attempt 3: Telegram recovers. Event completes; #1 STILL ran exactly once.
    h.sendTelegram.mockResolvedValue(77)
    db.tables.business_events[0].dispatch_after = past()
    res = await drainBusinessEvents(db as unknown as SupabaseClient)
    expect(res).toMatchObject({ processed: 1, failed: 0 })
    expect(db.tables.business_events[0].dispatch_status).toBe('dispatched')
    expect(runs(db, 'auto-webhook-ok')).toHaveLength(1)
    expect(runs(db, 'auto-telegram')).toHaveLength(3)
    expect(runs(db, 'auto-telegram')[2].status).toBe('success')
    expect(h.sendTelegram).toHaveBeenCalledTimes(3)
  })

  it('a crash after side effects but before "dispatched" replays the event without redoing finished automations', async () => {
    const db = setup()
    h.sendTelegram.mockResolvedValue(1)
    await drainBusinessEvents(db as unknown as SupabaseClient)
    expect(db.tables.business_events[0].dispatch_status).toBe('dispatched')

    // Simulate the worker dying right before it persisted "dispatched".
    Object.assign(db.tables.business_events[0], {
      dispatch_status: 'running',
      locked_at: past(10 * 60_000),
    })
    const res = await drainBusinessEvents(db as unknown as SupabaseClient)
    expect(res.recovered).toBe(1)
    expect(runs(db, 'auto-webhook-ok')).toHaveLength(1)
    expect(runs(db, 'auto-telegram')).toHaveLength(1)
    expect(h.sendTelegram).toHaveBeenCalledTimes(1)
  })
})
