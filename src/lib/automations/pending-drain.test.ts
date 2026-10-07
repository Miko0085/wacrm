import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeDb } from '@/test-utils/fake-db'

const h = vi.hoisted(() => ({ resumePendingExecution: vi.fn() }))
vi.mock('@/lib/automations/engine', () => ({ resumePendingExecution: h.resumePendingExecution }))

import {
  MAX_PENDING_EXECUTION_ATTEMPTS,
  drainPendingExecutions,
} from './pending-drain'

const past = (ms = 1000) => new Date(Date.now() - ms).toISOString()
const asClient = (db: unknown) => db as SupabaseClient

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    automation_id: 'auto-1',
    account_id: 'acc-1',
    user_id: 'u-1',
    contact_id: 'c-1',
    log_id: 'log-1',
    parent_step_id: null,
    branch: null,
    next_step_position: 1,
    context: { conversation_id: 'conv-1' },
    status: 'pending',
    run_at: past(),
    locked_at: null,
    attempt_count: 0,
    last_error: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.resumePendingExecution.mockResolvedValue(undefined)
})

describe('drainPendingExecutions', () => {
  it('claims a due wait (pending -> running with a lease) and resumes it', async () => {
    const db = createFakeDb({ automation_pending_executions: [row()] })
    h.resumePendingExecution.mockImplementation(async () => {
      // Observed mid-flight: the row is leased, not still "pending".
      expect(db.tables.automation_pending_executions[0]).toMatchObject({
        status: 'running',
        attempt_count: 1,
      })
      expect(db.tables.automation_pending_executions[0].locked_at).toBeTruthy()
    })
    const res = await drainPendingExecutions(asClient(db))
    expect(res.processed).toBe(1)
    expect(h.resumePendingExecution).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-1', next_step_position: 1 }),
    )
  })

  it('does not resume waits that are not due, or already finished', async () => {
    const db = createFakeDb({
      automation_pending_executions: [
        row({ id: 'future', run_at: new Date(Date.now() + 60_000).toISOString() }),
        row({ id: 'done', status: 'done' }),
        row({ id: 'dead', status: 'dead' }),
      ],
    })
    await drainPendingExecutions(asClient(db))
    expect(h.resumePendingExecution).not.toHaveBeenCalled()
  })

  it('CRASH RECOVERY: a wait stuck in running past its lease is re-queued and resumed', async () => {
    const db = createFakeDb({
      automation_pending_executions: [
        row({ status: 'running', locked_at: past(10 * 60_000), attempt_count: 1 }),
      ],
    })
    const res = await drainPendingExecutions(asClient(db))
    expect(res).toMatchObject({ recovered: 1, processed: 1 })
    expect(h.resumePendingExecution).toHaveBeenCalledTimes(1)
  })

  it('recovers a legacy running wait that predates the lease column', async () => {
    const db = createFakeDb({
      automation_pending_executions: [row({ status: 'running', locked_at: null })],
    })
    expect((await drainPendingExecutions(asClient(db))).recovered).toBe(1)
  })

  it('does not take over a wait whose lease is still fresh', async () => {
    const db = createFakeDb({
      automation_pending_executions: [row({ status: 'running', locked_at: past(1000) })],
    })
    const res = await drainPendingExecutions(asClient(db))
    expect(res).toMatchObject({ recovered: 0, processed: 0 })
    expect(h.resumePendingExecution).not.toHaveBeenCalled()
  })

  it('dead-letters a wait that has crashed its worker too many times', async () => {
    const db = createFakeDb({
      automation_pending_executions: [
        row({
          status: 'running',
          locked_at: past(10 * 60_000),
          attempt_count: MAX_PENDING_EXECUTION_ATTEMPTS,
        }),
      ],
    })
    const res = await drainPendingExecutions(asClient(db))
    expect(res).toMatchObject({ dead: 1, recovered: 0, processed: 0 })
    expect(db.tables.automation_pending_executions[0]).toMatchObject({ status: 'dead' })
    expect(String(db.tables.automation_pending_executions[0].last_error)).toContain('dead-letter')
    expect(h.resumePendingExecution).not.toHaveBeenCalled()
  })

  it('a resume that throws is isolated: row is marked failed with the error, others still run', async () => {
    const db = createFakeDb({
      automation_pending_executions: [row({ id: 'bad' }), row({ id: 'good', run_at: past(500) })],
    })
    h.resumePendingExecution.mockImplementation(async (p: { id: string }) => {
      if (p.id === 'bad') throw new Error('kaboom')
    })
    const res = await drainPendingExecutions(asClient(db))
    expect(res).toMatchObject({ processed: 1, failed: 1 })
    const bad = db.tables.automation_pending_executions.find((r) => r.id === 'bad')!
    expect(bad).toMatchObject({ status: 'failed', locked_at: null, last_error: 'kaboom' })
  })

  it('two overlapping ticks cannot resume the same wait twice', async () => {
    const db = createFakeDb({ automation_pending_executions: [row()] })
    await Promise.all([drainPendingExecutions(asClient(db)), drainPendingExecutions(asClient(db))])
    expect(h.resumePendingExecution).toHaveBeenCalledTimes(1)
  })

  it('honours the start deadline', async () => {
    const db = createFakeDb({ automation_pending_executions: [row()] })
    const res = await drainPendingExecutions(asClient(db), { deadline: Date.now() - 1 })
    expect(res).toMatchObject({ processed: 0, skipped: 1 })
    expect(db.tables.automation_pending_executions[0].status).toBe('pending')
  })
})
