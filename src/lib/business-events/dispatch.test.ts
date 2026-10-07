import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeDb } from '@/test-utils/fake-db'

const h = vi.hoisted(() => ({ runAutomationsForTrigger: vi.fn() }))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))

import {
  MAX_BUSINESS_EVENT_ATTEMPTS,
  businessEventRetryDelayMs,
  drainBusinessEvents,
} from './dispatch'

const asClient = (db: unknown) => db as SupabaseClient
const past = (ms = 1000) => new Date(Date.now() - ms).toISOString()

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    account_id: 'acc-1',
    user_id: 'u-1',
    contact_id: 'c-1',
    conversation_id: 'conv-1',
    event_type: 'human_handoff_requested',
    source: 'test',
    payload: { reason: 'r' },
    created_at: past(5000),
    dispatch_status: 'pending',
    dispatch_attempts: 0,
    dispatch_after: past(),
    locked_at: null,
    dispatched_at: null,
    last_error: null,
    chain_depth: 0,
    ...over,
  }
}

const OK = { matched: 1, succeeded: 1, failed: 0, skipped: 0, customer_facing_attempted: false }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.runAutomationsForTrigger.mockResolvedValue(OK)
})

describe('drainBusinessEvents — durable outbox', () => {
  it('pending -> running -> dispatched, passing event identity + depth to automations', async () => {
    const db = createFakeDb({ business_events: [event({ chain_depth: 2 })] })
    const res = await drainBusinessEvents(asClient(db))
    expect(res).toMatchObject({ processed: 1, failed: 0, dead: 0 })
    expect(db.tables.business_events[0]).toMatchObject({
      dispatch_status: 'dispatched',
      dispatch_attempts: 1,
      locked_at: null,
      last_error: null,
    })
    expect(db.tables.business_events[0].dispatched_at).toBeTruthy()
    expect(h.runAutomationsForTrigger).toHaveBeenCalledWith({
      accountId: 'acc-1',
      triggerType: 'business_event',
      contactId: 'c-1',
      context: expect.objectContaining({
        business_event_id: 'ev-1',
        business_event_type: 'human_handoff_requested',
        business_event_depth: 2,
      }),
    })
  })

  it('does not touch events that are already dispatched or not yet due', async () => {
    const db = createFakeDb({
      business_events: [
        event({ id: 'done', dispatch_status: 'dispatched' }),
        event({ id: 'later', dispatch_after: new Date(Date.now() + 60_000).toISOString() }),
      ],
    })
    const res = await drainBusinessEvents(asClient(db))
    expect(res.processed).toBe(0)
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('schedules an exponential retry when any automation failed', async () => {
    h.runAutomationsForTrigger.mockResolvedValue({ ...OK, failed: 1 })
    const db = createFakeDb({ business_events: [event()] })
    const before = Date.now()
    const res = await drainBusinessEvents(asClient(db))
    expect(res).toMatchObject({ processed: 0, failed: 1, dead: 0 })
    const row = db.tables.business_events[0]
    expect(row).toMatchObject({ dispatch_status: 'pending', dispatch_attempts: 1, locked_at: null })
    expect(String(row.last_error)).toContain('failed=1')
    expect(new Date(row.dispatch_after as string).getTime()).toBeGreaterThanOrEqual(
      before + businessEventRetryDelayMs(1) - 50,
    )
    expect(businessEventRetryDelayMs(3)).toBeGreaterThan(businessEventRetryDelayMs(2))
  })

  it('dead-letters after the maximum number of attempts and stops retrying', async () => {
    h.runAutomationsForTrigger.mockRejectedValue(new Error('downstream down'))
    const db = createFakeDb({
      business_events: [event({ dispatch_attempts: MAX_BUSINESS_EVENT_ATTEMPTS - 1 })],
    })
    const res = await drainBusinessEvents(asClient(db))
    expect(res).toMatchObject({ failed: 1, dead: 1 })
    expect(db.tables.business_events[0]).toMatchObject({
      dispatch_status: 'dead',
      last_error: 'downstream down',
    })
    h.runAutomationsForTrigger.mockClear()
    await drainBusinessEvents(asClient(db))
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('recovers a stale running event (worker died after claiming it)', async () => {
    const db = createFakeDb({
      business_events: [
        event({ dispatch_status: 'running', locked_at: past(10 * 60_000), dispatch_attempts: 1 }),
      ],
    })
    const res = await drainBusinessEvents(asClient(db))
    expect(res.recovered).toBe(1)
    expect(res.processed).toBe(1)
    expect(db.tables.business_events[0].dispatch_status).toBe('dispatched')
  })

  it('recovers a running event that has no lease timestamp (legacy row)', async () => {
    const db = createFakeDb({
      business_events: [event({ dispatch_status: 'running', locked_at: null })],
    })
    expect((await drainBusinessEvents(asClient(db))).recovered).toBe(1)
  })

  it('leaves a freshly-leased running event alone', async () => {
    const db = createFakeDb({
      business_events: [event({ dispatch_status: 'running', locked_at: past(1000) })],
    })
    const res = await drainBusinessEvents(asClient(db))
    expect(res).toMatchObject({ recovered: 0, processed: 0 })
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
  })

  it('dead-letters an event that keeps killing its worker', async () => {
    const db = createFakeDb({
      business_events: [
        event({
          dispatch_status: 'running',
          locked_at: past(10 * 60_000),
          dispatch_attempts: MAX_BUSINESS_EVENT_ATTEMPTS,
        }),
      ],
    })
    const res = await drainBusinessEvents(asClient(db))
    expect(res).toMatchObject({ dead: 1, recovered: 0, processed: 0 })
    expect(db.tables.business_events[0].dispatch_status).toBe('dead')
  })

  it('two workers cannot both claim the same event', async () => {
    const db = createFakeDb({ business_events: [event()] })
    await Promise.all([drainBusinessEvents(asClient(db)), drainBusinessEvents(asClient(db))])
    expect(h.runAutomationsForTrigger).toHaveBeenCalledTimes(1)
  })

  it('migration 057 marks pre-existing events delivered so deployment never replays history', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/migrations/057_orchestration_hardening.sql', 'utf8')
    const backfill = sql.indexOf("SET dispatch_status = 'dispatched'")
    const addColumn = sql.indexOf('ADD COLUMN IF NOT EXISTS dispatch_status')
    expect(addColumn).toBeGreaterThan(-1)
    expect(backfill).toBeGreaterThan(addColumn)
    // New rows (after the migration) must still start pending.
    expect(sql).toMatch(/dispatch_status TEXT NOT NULL DEFAULT 'pending'/)
    expect(sql).toMatch(/WHERE dispatch_status = 'pending'\s+AND dispatch_attempts = 0\s+AND dispatched_at IS NULL/)
  })
})
