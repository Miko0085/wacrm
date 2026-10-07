import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-utils/fake-db'

const h = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid.x' })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.x' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'wamid.x' })),
}))
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: vi.fn() }))
vi.mock('@/lib/contacts/tag-write', () => ({ removeContactTag: vi.fn() }))
vi.mock('@/lib/business-events/record', () => ({ recordBusinessEvent: vi.fn(async () => ({ id: 'ev' })) }))

import { startFlowForContact } from './engine'

const ACC = 'acc-1'

const goodNodes = (flowId: string) => [
  { id: `${flowId}-n1`, flow_id: flowId, node_key: 'start', node_type: 'start', config: { next_node_key: 'ask' } },
  {
    id: `${flowId}-n2`,
    flow_id: flowId,
    node_key: 'ask',
    node_type: 'collect_input',
    config: { prompt_text: 'What is your budget?', var_key: 'budget', next_node_key: 'end' },
  },
  { id: `${flowId}-n3`, flow_id: flowId, node_key: 'end', node_type: 'end', config: {} },
]

function world(over: { flows?: Record<string, unknown>[]; nodes?: Record<string, unknown>[]; runs?: Record<string, unknown>[] } = {}): FakeDb {
  const db = createFakeDb({
    flows: over.flows ?? [
      {
        id: 'flow-1',
        account_id: ACC,
        user_id: 'u-1',
        name: 'Qualification',
        status: 'active',
        trigger_type: 'manual',
        trigger_config: {},
        entry_node_id: 'start',
        fallback_policy: {},
      },
    ],
    flow_nodes: over.nodes ?? goodNodes('flow-1'),
    flow_runs: over.runs ?? [],
    flow_run_events: [],
    contacts: [
      { id: 'contact-1', account_id: ACC },
      { id: 'contact-other-tenant', account_id: 'acc-2' },
    ],
    conversations: [
      { id: 'conv-1', account_id: ACC, contact_id: 'contact-1' },
      { id: 'conv-other-contact', account_id: ACC, contact_id: 'contact-2' },
      { id: 'conv-other-tenant', account_id: 'acc-2', contact_id: 'contact-other-tenant' },
    ],
  })
  h.db = db
  return db
}

const start = (over: Partial<Parameters<typeof startFlowForContact>[0]> = {}) =>
  startFlowForContact({
    accountId: ACC,
    flowId: 'flow-1',
    contactId: 'contact-1',
    conversationId: 'conv-1',
    ...over,
  })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('startFlowForContact — safety guards', () => {
  it('starts an active, valid flow for a contact/conversation that belong together', async () => {
    const db = world()
    const res = await start()
    expect(res.consumed).toBe(true)
    expect(db.tables.flow_runs).toHaveLength(1)
    expect(db.tables.flow_runs[0]).toMatchObject({
      flow_id: 'flow-1',
      account_id: ACC,
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
    })
  })

  it.each(['draft', 'archived'])('rejects a %s flow', async (status) => {
    const db = world({
      flows: [
        {
          id: 'flow-1', account_id: ACC, user_id: 'u', name: 'F', status,
          trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start', fallback_policy: {},
        },
      ],
    })
    await expect(start()).rejects.toThrow('Only active flows can be started')
    expect(db.tables.flow_runs).toHaveLength(0)
  })

  it('rejects a flow that belongs to another account', async () => {
    const db = world()
    await expect(start({ accountId: 'acc-2' })).rejects.toThrow('Flow not found in this account')
    expect(db.tables.flow_runs).toHaveLength(0)
  })

  it("rejects a contact from another tenant, even when the flow and conversation id are valid", async () => {
    const db = world()
    await expect(start({ contactId: 'contact-other-tenant' })).rejects.toThrow('Contact not found in this account')
    expect(db.tables.flow_runs).toHaveLength(0)
  })

  it('rejects a conversation from another tenant', async () => {
    const db = world()
    await expect(start({ conversationId: 'conv-other-tenant' })).rejects.toThrow(/Conversation not found/)
    expect(db.tables.flow_runs).toHaveLength(0)
  })

  it("rejects a conversation that belongs to a different contact of the same account", async () => {
    const db = world()
    await expect(start({ conversationId: 'conv-other-contact' })).rejects.toThrow(/Conversation not found/)
    expect(db.tables.flow_runs).toHaveLength(0)
  })

  it('rejects an unknown conversation id', async () => {
    world()
    await expect(start({ conversationId: 'nope' })).rejects.toThrow(/Conversation not found/)
  })

  it('does not create a second run when the contact already has an active one', async () => {
    const db = world({
      runs: [
        {
          id: 'run-existing', flow_id: 'flow-1', account_id: ACC, contact_id: 'contact-1',
          conversation_id: 'conv-1', status: 'active', started_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    const res = await start()
    expect(res).toMatchObject({ consumed: true, flow_run_id: 'run-existing', outcome: 'duplicate_inbound_ignored' })
    expect(db.tables.flow_runs).toHaveLength(1)
  })

  it('refuses to start a flow whose graph contains an auto-advancing cycle', async () => {
    const db = world({
      nodes: [
        { id: 'a', flow_id: 'flow-1', node_key: 'start', node_type: 'start', config: { next_node_key: 'a' } },
        { id: 'b', flow_id: 'flow-1', node_key: 'a', node_type: 'send_message', config: { text: 'hi', next_node_key: 'b' } },
        { id: 'c', flow_id: 'flow-1', node_key: 'b', node_type: 'condition', config: { subject: 'var', subject_key: 'x', operator: 'equals', value: '1', true_next: 'a', false_next: 'end' } },
        { id: 'd', flow_id: 'flow-1', node_key: 'end', node_type: 'end', config: {} },
      ],
    })
    await expect(start()).rejects.toThrow(/Auto-advancing cycle/)
    expect(db.tables.flow_runs).toHaveLength(0)
  })

  it('refuses a flow whose entry node is missing', async () => {
    const db = world({ nodes: goodNodes('flow-1').slice(1) })
    await expect(start()).rejects.toThrow(/cannot be started/)
    expect(db.tables.flow_runs).toHaveLength(0)
  })
})
