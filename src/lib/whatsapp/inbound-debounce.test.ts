import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeDb } from '@/test-utils/fake-db'

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: h.dispatchInboundToAiReply }))

import {
  MAX_DEBOUNCE_ATTEMPTS,
  debounceRetryDelayMs,
  drainInboundDebounceJobs,
  processDebouncedInboundTurn,
  queueInboundTextTurn,
  type InboundDebounceJob,
} from './inbound-debounce'

const asClient = (db: unknown) => db as SupabaseClient

const past = (ms = 1000) => new Date(Date.now() - ms).toISOString()

function job(overrides: Partial<InboundDebounceJob> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    account_id: 'acc-1',
    user_id: 'user-1',
    contact_id: 'contact-1',
    conversation_id: 'conv-1',
    message_ids: ['wamid.1'],
    text_parts: ['hello'],
    is_first_inbound: false,
    version: 1,
    status: 'pending',
    run_at: past(),
    locked_at: null,
    attempt_count: 0,
    last_error: null,
    ...overrides,
  }
}

const NO_DISPATCH = {
  matched: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  customer_facing_attempted: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.runAutomationsForTrigger.mockResolvedValue(NO_DISPATCH)
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
})

describe('queueInboundTextTurn', () => {
  it('delegates aggregation to the atomic RPC and clamps the delay', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'job-9', error: null })
    const id = await queueInboundTextTurn({
      db: { rpc } as unknown as SupabaseClient,
      accountId: 'acc-1',
      userId: 'user-1',
      contactId: 'c-1',
      conversationId: 'conv-1',
      providerMessageId: 'wamid.7',
      text: 'hi',
      isFirstInbound: true,
      delaySeconds: 10_000,
    })
    expect(id).toBe('job-9')
    expect(rpc).toHaveBeenCalledWith(
      'queue_inbound_debounce',
      expect.objectContaining({
        p_account_id: 'acc-1',
        p_conversation_id: 'conv-1',
        p_message_id: 'wamid.7',
        p_text: 'hi',
        p_delay_seconds: 300,
      }),
    )
  })

  it('throws when the RPC fails so the pipeline can fall back to immediate dispatch', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error('down') })
    await expect(
      queueInboundTextTurn({
        db: { rpc } as unknown as SupabaseClient,
        accountId: 'a',
        userId: 'u',
        contactId: 'c',
        conversationId: 'v',
        providerMessageId: 'm',
        text: 't',
        isFirstInbound: false,
      }),
    ).rejects.toThrow('down')
  })
})

describe('drainInboundDebounceJobs', () => {
  it('processes a due job once and deletes exactly that version', async () => {
    const db = createFakeDb({ inbound_debounce_jobs: [job({ text_parts: ['a', 'b'] })] })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res).toMatchObject({ processed: 1, failed: 0, dead: 0, recovered: 0 })
    expect(db.tables.inbound_debounce_jobs).toHaveLength(0)
    expect(h.dispatchInboundToFlows.mock.calls[0][0].message.text).toBe('a\nb')
  })

  it('ignores jobs that are not due yet', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const db = createFakeDb({ inbound_debounce_jobs: [job({ run_at: future })] })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res.processed).toBe(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(db.tables.inbound_debounce_jobs).toHaveLength(1)
  })

  it('RACE: a newer version that arrives mid-processing survives the old worker finishing', async () => {
    const db = createFakeDb({ inbound_debounce_jobs: [job()] })
    // While the worker holds version 1, a new customer message runs the RPC:
    // version -> 2, status -> pending, only the new text, lease cleared.
    h.dispatchInboundToFlows.mockImplementation(async () => {
      Object.assign(db.tables.inbound_debounce_jobs[0], {
        version: 2,
        status: 'pending',
        text_parts: ['newer message'],
        locked_at: null,
        attempt_count: 0,
        last_error: null,
        run_at: new Date(Date.now() + 35_000).toISOString(),
      })
      return { consumed: false }
    })

    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res.processed).toBe(1)
    // The DELETE was scoped to version 1, so version 2 is intact.
    expect(db.tables.inbound_debounce_jobs).toHaveLength(1)
    expect(db.tables.inbound_debounce_jobs[0]).toMatchObject({
      version: 2,
      status: 'pending',
      text_parts: ['newer message'],
    })
  })

  it('RACE: a failure of the superseded worker does not clobber the newer version', async () => {
    const db = createFakeDb({ inbound_debounce_jobs: [job()] })
    h.dispatchInboundToFlows.mockImplementation(async () => {
      Object.assign(db.tables.inbound_debounce_jobs[0], { version: 2, status: 'pending' })
      throw new Error('llm timeout')
    })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res.failed).toBe(1)
    expect(db.tables.inbound_debounce_jobs[0]).toMatchObject({ version: 2, status: 'pending', last_error: null })
  })

  it('retries a failed job with exponential backoff and records the error', async () => {
    const db = createFakeDb({ inbound_debounce_jobs: [job()] })
    h.dispatchInboundToFlows.mockRejectedValue(new Error('provider 500'))
    const before = Date.now()
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res).toMatchObject({ processed: 0, failed: 1, dead: 0 })
    const row = db.tables.inbound_debounce_jobs[0]
    expect(row).toMatchObject({ status: 'pending', attempt_count: 1, locked_at: null, last_error: 'provider 500' })
    expect(new Date(row.run_at as string).getTime()).toBeGreaterThanOrEqual(before + debounceRetryDelayMs(1) - 50)
  })

  it('moves a job to dead after the attempt budget is spent', async () => {
    const db = createFakeDb({
      inbound_debounce_jobs: [job({ attempt_count: MAX_DEBOUNCE_ATTEMPTS - 1 })],
    })
    h.dispatchInboundToFlows.mockRejectedValue(new Error('still broken'))
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res).toMatchObject({ failed: 1, dead: 1 })
    expect(db.tables.inbound_debounce_jobs[0]).toMatchObject({ status: 'dead', last_error: 'still broken' })

    // A dead job is never picked up again by the drain.
    h.dispatchInboundToFlows.mockClear()
    await drainInboundDebounceJobs(asClient(db))
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('recovers a running job whose lease expired (worker crashed)', async () => {
    const db = createFakeDb({
      inbound_debounce_jobs: [
        job({ status: 'running', locked_at: past(10 * 60_000), attempt_count: 1 }),
      ],
    })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res.recovered).toBe(1)
    // Recovered to pending, then picked up in the same tick.
    expect(res.processed).toBe(1)
    expect(db.tables.inbound_debounce_jobs).toHaveLength(0)
  })

  it('recovers a legacy running job that has no lease timestamp', async () => {
    const db = createFakeDb({
      inbound_debounce_jobs: [job({ status: 'running', locked_at: null })],
    })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res.recovered).toBe(1)
  })

  it('does not steal a running job whose lease is still fresh', async () => {
    const db = createFakeDb({
      inbound_debounce_jobs: [job({ status: 'running', locked_at: past(5_000) })],
    })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res).toMatchObject({ recovered: 0, processed: 0 })
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('dead-letters a job that keeps crashing the worker instead of looping forever', async () => {
    const db = createFakeDb({
      inbound_debounce_jobs: [
        job({ status: 'running', locked_at: past(10 * 60_000), attempt_count: MAX_DEBOUNCE_ATTEMPTS }),
      ],
    })
    const res = await drainInboundDebounceJobs(asClient(db))
    expect(res).toMatchObject({ dead: 1, recovered: 0, processed: 0 })
    expect(db.tables.inbound_debounce_jobs[0].status).toBe('dead')
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
  })

  it('bounds concurrency and reports jobs skipped when the time budget is gone', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      job({ id: `job-${i}`, conversation_id: `conv-${i}` }),
    )
    const db = createFakeDb({ inbound_debounce_jobs: rows })
    let active = 0
    let peak = 0
    h.dispatchInboundToFlows.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 2))
      active -= 1
      return { consumed: false }
    })
    const res = await drainInboundDebounceJobs(asClient(db), { concurrency: 2 })
    expect(res.processed).toBe(6)
    expect(peak).toBeLessThanOrEqual(2)

    const db2 = createFakeDb({ inbound_debounce_jobs: [job()] })
    const expired = await drainInboundDebounceJobs(asClient(db2), { deadline: Date.now() - 1 })
    expect(expired).toMatchObject({ processed: 0, skipped: 1 })
    expect(db2.tables.inbound_debounce_jobs[0].status).toBe('pending')
  })

  it('does not write message text to the error log', async () => {
    const db = createFakeDb({ inbound_debounce_jobs: [job({ text_parts: ['my secret iban 123'] })] })
    h.dispatchInboundToFlows.mockRejectedValue(new Error('boom'))
    await drainInboundDebounceJobs(asClient(db))
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)
    expect(logged).not.toContain('secret iban')
  })
})

describe('processDebouncedInboundTurn — AI suppression follows the ACTUAL automation result', () => {
  const db = {} as SupabaseClient
  const J = job({ is_first_inbound: false }) as unknown as InboundDebounceJob

  it('A) keyword matches + send_message attempted → AI suppressed', async () => {
    h.runAutomationsForTrigger.mockImplementation(async ({ triggerType }) => ({
      ...NO_DISPATCH,
      matched: triggerType === 'keyword_match' ? 1 : 0,
      customer_facing_attempted: triggerType === 'keyword_match',
    }))
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: true }),
    )
  })

  it('B) keyword matches but only add_tag ran → AI allowed', async () => {
    h.runAutomationsForTrigger.mockResolvedValue({ ...NO_DISPATCH, matched: 1, succeeded: 1 })
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: false }),
    )
  })

  it('C) nothing matches → AI allowed', async () => {
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: false }),
    )
  })

  it('D) new_message_received + start_flow attempted → AI suppressed', async () => {
    h.runAutomationsForTrigger.mockImplementation(async ({ triggerType }) => ({
      ...NO_DISPATCH,
      matched: 1,
      customer_facing_attempted: triggerType === 'new_message_received',
    }))
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: true }),
    )
  })

  it('E) responder FAILED after attempting a customer-facing send → still suppressed (no double send)', async () => {
    h.runAutomationsForTrigger.mockResolvedValue({
      ...NO_DISPATCH,
      matched: 1,
      failed: 1,
      customer_facing_attempted: true,
    })
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: true }),
    )
  })

  it('E2) responder failed BEFORE any customer-facing attempt → AI is allowed to answer', async () => {
    h.runAutomationsForTrigger.mockResolvedValue({
      ...NO_DISPATCH,
      matched: 1,
      failed: 1,
      customer_facing_attempted: false,
    })
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: false }),
    )
  })

  it('runs automations before Flow handling, then skips AI if the Flow consumes the turn', async () => {
    h.dispatchInboundToFlows.mockResolvedValue({ consumed: true })
    await processDebouncedInboundTurn(db, J)
    expect(h.runAutomationsForTrigger).toHaveBeenCalled()
    expect(h.dispatchInboundToFlows).toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('does not also run a Flow when an automation attempted a customer-facing response', async () => {
    h.runAutomationsForTrigger.mockImplementation(async ({ triggerType }) => ({
      ...NO_DISPATCH,
      matched: triggerType === 'new_message_received' ? 1 : 0,
      customer_facing_attempted: triggerType === 'new_message_received',
    }))
    await processDebouncedInboundTurn(db, J)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ deterministicResponderHandled: true }),
    )
  })

  it('matches keywords against the MERGED text of the whole burst', async () => {
    const burst = job({ text_parts: ['yes', 'for investment', '2M AED'] }) as unknown as InboundDebounceJob
    await processDebouncedInboundTurn(db, burst)
    const texts = h.runAutomationsForTrigger.mock.calls.map((c) => c[0].context.message_text)
    expect(new Set(texts)).toEqual(new Set(['yes\nfor investment\n2M AED']))
  })

  it('adds first_inbound_message only for the first turn of a conversation', async () => {
    await processDebouncedInboundTurn(db, job({ is_first_inbound: true }) as unknown as InboundDebounceJob)
    expect(h.runAutomationsForTrigger.mock.calls.map((c) => c[0].triggerType)).toEqual([
      'first_inbound_message',
      'new_message_received',
      'keyword_match',
    ])
  })
})
