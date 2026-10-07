import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeDb } from '@/test-utils/fake-db'
import { handleStatusUpdate } from './inbound-pipeline'

const dispatchWebhookEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent }))

const SAME_PROVIDER_ID = 'wamid.SHARED'

function twoTenants() {
  return createFakeDb(
    {
      conversations: [
        { id: 'conv-A', account_id: 'acc-A' },
        { id: 'conv-B', account_id: 'acc-B' },
      ],
      messages: [
        { id: 'msg-A', conversation_id: 'conv-A', message_id: SAME_PROVIDER_ID, status: 'sent' },
        { id: 'msg-B', conversation_id: 'conv-B', message_id: SAME_PROVIDER_ID, status: 'sent' },
      ],
      broadcasts: [
        { id: 'bc-A', account_id: 'acc-A' },
        { id: 'bc-B', account_id: 'acc-B' },
      ],
      broadcast_recipients: [
        { id: 'rec-A', broadcast_id: 'bc-A', whatsapp_message_id: SAME_PROVIDER_ID, status: 'sent', created_at: 1 },
        { id: 'rec-B', broadcast_id: 'bc-B', whatsapp_message_id: SAME_PROVIDER_ID, status: 'sent', created_at: 1 },
      ],
    },
    {
      relations: {
        messages: { conversations: { fk: 'conversation_id', table: 'conversations' } },
        broadcast_recipients: { broadcasts: { fk: 'broadcast_id', table: 'broadcasts' } },
      },
    },
  )
}

const event = (status: 'delivered' | 'read' | 'failed') => ({
  providerMessageId: SAME_PROVIDER_ID,
  status,
  timestampMs: 1_700_000_000_000,
})

describe('handleStatusUpdate — tenant isolation when two accounts share a provider message id', () => {
  it("a callback for account A changes only A's message and broadcast recipient", async () => {
    const db = twoTenants()
    await handleStatusUpdate(db as unknown as SupabaseClient, 'acc-A', event('delivered'))

    const msg = (id: string) => db.tables.messages.find((m) => m.id === id)!
    const rec = (id: string) => db.tables.broadcast_recipients.find((r) => r.id === id)!
    expect(msg('msg-A').status).toBe('delivered')
    expect(msg('msg-B').status).toBe('sent')
    expect(rec('rec-A')).toMatchObject({ status: 'delivered', delivered_at: expect.any(String) })
    expect(rec('rec-B').status).toBe('sent')
    expect(rec('rec-B').delivered_at).toBeUndefined()
  })

  it("a callback for account B changes only B's rows", async () => {
    const db = twoTenants()
    await handleStatusUpdate(db as unknown as SupabaseClient, 'acc-B', event('read'))
    expect(db.tables.messages.find((m) => m.id === 'msg-B')!.status).toBe('read')
    expect(db.tables.messages.find((m) => m.id === 'msg-A')!.status).toBe('sent')
    expect(db.tables.broadcast_recipients.find((r) => r.id === 'rec-A')!.status).toBe('sent')
  })

  it('an unknown account touches nothing and emits no public webhook', async () => {
    dispatchWebhookEvent.mockClear()
    const db = twoTenants()
    await handleStatusUpdate(db as unknown as SupabaseClient, 'acc-ZZZ', event('failed'))
    expect(db.tables.messages.every((m) => m.status === 'sent')).toBe(true)
    expect(db.tables.broadcast_recipients.every((r) => r.status === 'sent')).toBe(true)
    expect(dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it("fans out the public webhook only for the callback's own account, with its own conversation", async () => {
    dispatchWebhookEvent.mockClear()
    const db = twoTenants()
    await handleStatusUpdate(db as unknown as SupabaseClient, 'acc-A', event('delivered'))
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acc-A',
      'message.status_updated',
      expect.objectContaining({ conversation_id: 'conv-A' }),
    )
  })
})
