import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidStatusTransition, handleStatusUpdate } from './inbound-pipeline'

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
  function mockDb(recipientRow: { id: string; status: string } | null) {
    const updates: { table: string; row: Record<string, unknown> }[] = []
    const db = {
      from(table: string) {
        return {
          update: (row: Record<string, unknown>) => {
            updates.push({ table, row })
            return { eq: () => Promise.resolve({ error: null }) }
          },
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                table === 'broadcast_recipients'
                  ? { data: recipientRow, error: null }
                  : { data: null, error: null },
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }
      },
    } as unknown as SupabaseClient
    return { db, updates }
  }

  it('mirrors a forward status transition onto broadcast_recipients', async () => {
    const { db, updates } = mockDb({ id: 'r1', status: 'sent' })
    await handleStatusUpdate(db, { providerMessageId: 'wamid.1', status: 'delivered', timestampMs: 1700000000000 })
    const recipientUpdate = updates.find((u) => u.table === 'broadcast_recipients')
    expect(recipientUpdate?.row.status).toBe('delivered')
    expect(recipientUpdate?.row.delivered_at).toBeDefined()
  })

  it('does not write broadcast_recipients on a backward/out-of-order transition', async () => {
    const { db, updates } = mockDb({ id: 'r1', status: 'read' })
    await handleStatusUpdate(db, { providerMessageId: 'wamid.1', status: 'delivered', timestampMs: 1700000000000 })
    const recipientUpdate = updates.find((u) => u.table === 'broadcast_recipients')
    expect(recipientUpdate).toBeUndefined()
  })

  it('always mirrors onto messages.status regardless of the recipient-row guard', async () => {
    const { db, updates } = mockDb(null)
    await handleStatusUpdate(db, { providerMessageId: 'wamid.1', status: 'read', timestampMs: 1700000000000 })
    const messageUpdate = updates.find((u) => u.table === 'messages')
    expect(messageUpdate?.row.status).toBe('read')
  })
})
