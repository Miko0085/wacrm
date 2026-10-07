import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidStatusTransition, handleStatusUpdate, applyStopKeywordIfMatched } from './inbound-pipeline'

vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }))

describe('isValidStatusTransition', () => {
  it('allows forward moves along the ladder', () => {
    expect(isValidStatusTransition('pending', 'sent')).toBe(true)
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidStatusTransition('delivered', 'read')).toBe(true)
    expect(isValidStatusTransition('read', 'replied')).toBe(true)
  })

  it('refuses backward moves — a late "delivered" after "read" must not regress the recipient', () => {
    expect(isValidStatusTransition('read', 'delivered')).toBe(false)
    expect(isValidStatusTransition('delivered', 'sent')).toBe(false)
    expect(isValidStatusTransition('replied', 'read')).toBe(false)
  })

  it('accepts failed only from pending or sent', () => {
    expect(isValidStatusTransition('pending', 'failed')).toBe(true)
    expect(isValidStatusTransition('sent', 'failed')).toBe(true)
  })

  it('refuses failed once the recipient has been delivered/read/replied — an out-of-order Gupshup callback must not overwrite success', () => {
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
    expect(isValidStatusTransition('read', 'failed')).toBe(false)
    expect(isValidStatusTransition('replied', 'failed')).toBe(false)
  })

  it('treats failed as terminal — nothing transitions out of it', () => {
    expect(isValidStatusTransition('failed', 'sent')).toBe(false)
    expect(isValidStatusTransition('failed', 'delivered')).toBe(false)
  })

  it('accepts an unknown current status as a fresh start (defensive default)', () => {
    expect(isValidStatusTransition('some-unmigrated-value', 'sent')).toBe(true)
  })

  it('refuses an unrecognized incoming status', () => {
    expect(isValidStatusTransition('pending', 'bogus')).toBe(false)
  })
})

describe('handleStatusUpdate', () => {
  function mockDb(args: {
    messages?: Array<{ id: string; conversation_id: string; status: string }>
    recipients?: Array<{ id: string; status: string }>
  } = {}) {
    const updates: { table: string; row: Record<string, unknown>; id?: string }[] = []

    const db = {
      from(table: string) {
        const state: { updateRow?: Record<string, unknown> } = {}
        const chain: Record<string, unknown> = {}

        chain.select = () => chain
        chain.update = (row: Record<string, unknown>) => {
          state.updateRow = row
          return chain
        }
        chain.eq = (field: string, value: unknown) => {
          if (state.updateRow && field === 'id') {
            updates.push({ table, row: state.updateRow, id: String(value) })
          }
          return chain
        }
        chain.order = () => chain
        chain.limit = () => chain
        chain.then = (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          const value =
            table === 'messages'
              ? { data: args.messages ?? [], error: null }
              : table === 'broadcast_recipients'
                ? { data: args.recipients ?? [], error: null }
                : { data: [], error: null }
          return Promise.resolve(value).then(onFulfilled, onRejected)
        }

        return chain
      },
    } as unknown as SupabaseClient

    return { db, updates }
  }

  it('mirrors only account-resolved message and recipient rows', async () => {
    const { db, updates } = mockDb({
      messages: [{ id: 'm1', conversation_id: 'conv-1', status: 'sent' }],
      recipients: [{ id: 'r1', status: 'sent' }],
    })

    await handleStatusUpdate(db, 'acc-1', {
      providerMessageId: 'wamid.1',
      status: 'delivered',
      timestampMs: 1700000000000,
    })

    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'messages', id: 'm1', row: { status: 'delivered' } }),
        expect.objectContaining({
          table: 'broadcast_recipients',
          id: 'r1',
          row: expect.objectContaining({ status: 'delivered', delivered_at: expect.any(String) }),
        }),
      ]),
    )
  })

  it('does not regress out-of-order message or recipient statuses', async () => {
    const { db, updates } = mockDb({
      messages: [{ id: 'm1', conversation_id: 'conv-1', status: 'read' }],
      recipients: [{ id: 'r1', status: 'read' }],
    })

    await handleStatusUpdate(db, 'acc-1', {
      providerMessageId: 'wamid.1',
      status: 'delivered',
      timestampMs: 1700000000000,
    })

    expect(updates).toHaveLength(0)
  })
})

describe('applyStopKeywordIfMatched (system-default STOP, requirement #39)', () => {
  function mockContactsDb() {
    const updates: Record<string, unknown>[] = []
    const db = {
      from: () => ({
        update: (row: Record<string, unknown>) => {
          updates.push(row)
          return { eq: () => ({ eq: async () => ({ error: null }) }) }
        },
      }),
    } as unknown as SupabaseClient
    return { db, updates }
  }

  it.each(['stop', 'STOP', ' Stop ', 'unsubscribe', 'remove', 'стоп', 'отписка', 'не пишите', 'НЕ ПИШИТЕ'])(
    'opts a contact out on an exact (trimmed, case-insensitive) match: %j',
    async (text) => {
      const { db, updates } = mockContactsDb()
      await applyStopKeywordIfMatched(db, 'acc-1', 'c1', text)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({ wa_marketing_status: 'OPTED_OUT', wa_consent_source: 'stop_keyword' })
    },
  )

  it('does not fire on a sentence that merely contains a keyword as a substring', async () => {
    const { db, updates } = mockContactsDb()
    await applyStopKeywordIfMatched(db, 'acc-1', 'c1', "please don't stop the shipment")
    expect(updates).toHaveLength(0)
  })

  it('does not fire on unrelated text or null/empty content', async () => {
    const { db, updates } = mockContactsDb()
    await applyStopKeywordIfMatched(db, 'acc-1', 'c1', 'hello there')
    await applyStopKeywordIfMatched(db, 'acc-1', 'c1', null)
    await applyStopKeywordIfMatched(db, 'acc-1', 'c1', '')
    expect(updates).toHaveLength(0)
  })
})
