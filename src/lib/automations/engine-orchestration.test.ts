import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-utils/fake-db'

const h = vi.hoisted(() => ({
  db: null as unknown,
  engineSendText: vi.fn(),
  engineSendMedia: vi.fn(),
  startFlowForContact: vi.fn(),
  sendTelegram: vi.fn(),
}))

vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('./meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm' })),
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: h.engineSendMedia }))
vi.mock('@/lib/flows/engine', () => ({ startFlowForContact: h.startFlowForContact }))
vi.mock('@/lib/telegram/send', async (orig) => ({
  ...(await orig<typeof import('@/lib/telegram/send')>()),
  sendTelegramNotification: h.sendTelegram,
}))
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: vi.fn(async () => true) }))
vi.mock('@/lib/contacts/tag-write', () => ({ addContactTagIfAbsent: vi.fn(async () => false) }))
vi.mock('./ai-classification', () => ({
  classifyAutomationMessage: vi.fn(),
  classificationTakesYesBranch: vi.fn(),
  classificationVars: vi.fn(),
}))

import {
  MAX_BUSINESS_EVENT_CHAIN_DEPTH,
  runAutomationsForTrigger,
  type AutomationContext,
} from './engine'

const ACCOUNT = 'acc-1'

function seed(
  automations: Record<string, unknown>[],
  steps: Record<string, unknown>[],
): FakeDb {
  return createFakeDb(
    {
      contacts: [{ id: 'contact-1', account_id: ACCOUNT }],
      automations,
      automation_steps: steps,
      automation_logs: [],
      automation_pending_executions: [],
      business_events: [],
    },
    { rpc: { increment_automation_execution_count: () => null } },
  )
}

const automation = (over: Record<string, unknown> = {}) => ({
  id: 'auto-1',
  account_id: ACCOUNT,
  user_id: 'user-1',
  name: 'A',
  trigger_type: 'new_message_received',
  trigger_config: {},
  is_active: true,
  ...over,
})

const step = (over: Record<string, unknown>) => ({
  id: `step-${Math.random()}`,
  automation_id: 'auto-1',
  parent_step_id: null,
  branch: null,
  position: 0,
  step_config: {},
  ...over,
})

const ctx: AutomationContext = { message_text: 'hello', conversation_id: 'conv-1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wamid.out' })
  h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: 'wamid.out' })
  h.startFlowForContact.mockResolvedValue({ consumed: true, flow_run_id: 'run-1' })
  h.sendTelegram.mockResolvedValue(1)
})

async function dispatch(
  triggerType: Parameters<typeof runAutomationsForTrigger>[0]['triggerType'],
  context: AutomationContext = ctx,
) {
  return runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType,
    contactId: 'contact-1',
    context,
  })
}

describe('AutomationDispatchResult.customer_facing_attempted', () => {
  it('is true when a send_message step ran', async () => {
    h.db = seed([automation()], [step({ step_type: 'send_message', step_config: { text: 'hi' } })])
    const res = await dispatch('new_message_received')
    expect(res).toMatchObject({ matched: 1, succeeded: 1, customer_facing_attempted: true })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('is false for CRM/notification-only automations (add_tag, webhook, telegram, emit event)', async () => {
    h.db = seed(
      [automation()],
      [
        step({ id: 's1', position: 0, step_type: 'add_tag', step_config: { tag_id: 't1' } }),
        step({ id: 's2', position: 1, step_type: 'send_telegram', step_config: { connection_id: 'tg', message: 'x' } }),
        step({ id: 's3', position: 2, step_type: 'emit_business_event', step_config: { event_type: 'lead_seen' } }),
        step({ id: 's4', position: 3, step_type: 'send_webhook', step_config: { url: 'https://example.com/h' } }),
      ],
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })))
    const res = await dispatch('new_message_received')
    vi.unstubAllGlobals()
    expect(res).toMatchObject({ matched: 1, customer_facing_attempted: false })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('is true for start_flow (a Flow will answer the customer)', async () => {
    h.db = seed([automation()], [step({ step_type: 'start_flow', step_config: { flow_id: 'flow-1' } })])
    const res = await dispatch('new_message_received')
    expect(res.customer_facing_attempted).toBe(true)
    expect(h.startFlowForContact).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, flowId: 'flow-1', contactId: 'contact-1' }),
    )
  })

  it('stays true when the send itself FAILS, so AI does not double-answer', async () => {
    h.engineSendText.mockRejectedValue(new Error('Meta 131047'))
    h.db = seed([automation()], [step({ step_type: 'send_message', step_config: { text: 'hi' } })])
    const res = await dispatch('new_message_received')
    expect(res).toMatchObject({ matched: 1, failed: 1, customer_facing_attempted: true })
  })

  it('is false when the automation fails BEFORE reaching a customer-facing step', async () => {
    h.db = seed(
      [automation()],
      [
        step({ id: 's1', position: 0, step_type: 'send_telegram', step_config: {} }), // missing connection_id -> throws
        step({ id: 's2', position: 1, step_type: 'send_message', step_config: { text: 'never reached' } }),
      ],
    )
    const res = await dispatch('new_message_received')
    expect(res).toMatchObject({ failed: 1, customer_facing_attempted: false })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('is false when nothing matches the trigger', async () => {
    h.db = seed(
      [automation({ trigger_type: 'keyword_match', trigger_config: { keywords: ['price'], match_type: 'contains' } })],
      [step({ step_type: 'send_message', step_config: { text: 'hi' } })],
    )
    const res = await dispatch('keyword_match', { message_text: 'hello' })
    expect(res).toMatchObject({ matched: 0, customer_facing_attempted: false })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('counts a reply parked behind a wait step as deterministic (scheduled response)', async () => {
    h.db = seed(
      [automation()],
      [
        step({ id: 's1', position: 0, step_type: 'wait', step_config: { amount: 5, unit: 'minutes' } }),
        step({ id: 's2', position: 1, step_type: 'send_message', step_config: { text: 'later' } }),
      ],
    )
    const res = await dispatch('new_message_received')
    expect(res.customer_facing_attempted).toBe(true)
    expect((h.db as FakeDb).tables.automation_pending_executions).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('a wait with only CRM steps behind it does not mute AI', async () => {
    h.db = seed(
      [automation()],
      [
        step({ id: 's1', position: 0, step_type: 'wait', step_config: { amount: 5, unit: 'minutes' } }),
        step({ id: 's2', position: 1, step_type: 'add_tag', step_config: { tag_id: 't' } }),
      ],
    )
    const res = await dispatch('new_message_received')
    expect(res.customer_facing_attempted).toBe(false)
  })
})

describe('emit_business_event — chain depth loop protection', () => {
  const emitStep = () =>
    step({
      step_type: 'emit_business_event',
      step_config: { event_type: 'ping', payload_template: '{"n":1}' },
    })

  it('a root automation emits depth 0 and stores no chain depth', async () => {
    h.db = seed([automation()], [emitStep()])
    await dispatch('new_message_received')
    const events = (h.db as FakeDb).tables.business_events
    expect(events).toHaveLength(1)
    expect(events[0].chain_depth ?? 0).toBe(0)
  })

  it('propagates depth + 1 when triggered by a business event', async () => {
    h.db = seed([automation({ trigger_type: 'business_event', trigger_config: { event_types: ['ping'] } })], [emitStep()])
    await dispatch('business_event', {
      business_event_id: 'ev-3',
      business_event_type: 'ping',
      business_event_payload: {},
      business_event_depth: 3,
    })
    const events = (h.db as FakeDb).tables.business_events
    expect(events).toHaveLength(1)
    expect(events[0].chain_depth).toBe(4)
  })

  it('X -> X self-loop is cut at the depth limit without failing the automation', async () => {
    h.db = seed([automation({ trigger_type: 'business_event', trigger_config: { event_types: ['ping'] } })], [emitStep()])
    const res = await dispatch('business_event', {
      business_event_id: 'ev-8',
      business_event_type: 'ping',
      business_event_payload: {},
      business_event_depth: MAX_BUSINESS_EVENT_CHAIN_DEPTH,
    })
    expect((h.db as FakeDb).tables.business_events).toHaveLength(0)
    // Suppressed, not failed: a failure would make the outbox retry the event
    // until it dead-letters, re-running everything else on it.
    expect(res).toMatchObject({ matched: 1, succeeded: 1, failed: 0 })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('chain depth'))
  })

  it('a chain simulated end to end terminates (X -> Y -> X ...)', async () => {
    h.db = seed(
      [
        automation({ id: 'a-x', trigger_type: 'business_event', trigger_config: { event_types: ['x'] } }),
        automation({ id: 'a-y', trigger_type: 'business_event', trigger_config: { event_types: ['y'] } }),
      ],
      [
        step({ id: 'sx', automation_id: 'a-x', step_type: 'emit_business_event', step_config: { event_type: 'y' } }),
        step({ id: 'sy', automation_id: 'a-y', step_type: 'emit_business_event', step_config: { event_type: 'x' } }),
      ],
    )
    const fake = h.db as FakeDb
    // Behave like the outbox worker: dispatch every new event until none are left.
    let type = 'x'
    let depth = 0
    let hops = 0
    for (; hops < 100; hops += 1) {
      await dispatch('business_event', {
        business_event_id: `ev-${hops}`,
        business_event_type: type,
        business_event_payload: {},
        business_event_depth: depth,
      })
      const emitted = fake.tables.business_events.at(-1)
      if (!emitted || emitted.chain_depth === undefined || Number(emitted.chain_depth) <= depth) break
      type = String(emitted.event_type)
      depth = Number(emitted.chain_depth)
      fake.tables.business_events.length = 0
    }
    expect(hops).toBeLessThanOrEqual(MAX_BUSINESS_EVENT_CHAIN_DEPTH + 1)
  })
})

describe('send_telegram step — customer text can never inject markup', () => {
  const tgStep = (cfg: Record<string, unknown>) =>
    step({
      step_type: 'send_telegram',
      step_config: { connection_id: 'tg-1', message: 'Reason: {{event.reason}}', ...cfg },
    })
  const eventCtx: AutomationContext = {
    business_event_id: 'ev-1',
    business_event_type: 'human_handoff_requested',
    business_event_payload: { reason: '<b>Call me</b> & *now*' },
  }
  const triggerEvent = { trigger_type: 'business_event', trigger_config: { event_types: ['human_handoff_requested'] } }

  it('defaults to plain text (parseMode null) and sends the value verbatim', async () => {
    h.db = seed([automation(triggerEvent)], [tgStep({})])
    await dispatch('business_event', eventCtx)
    expect(h.sendTelegram).toHaveBeenCalledWith(
      expect.objectContaining({ parseMode: null, text: 'Reason: <b>Call me</b> & *now*' }),
    )
  })

  it('HTML mode escapes interpolated values but not the author template', async () => {
    h.db = seed([automation(triggerEvent)], [tgStep({ parse_mode: 'HTML', message: '<b>Handoff</b>: {{event.reason}}' })])
    await dispatch('business_event', eventCtx)
    expect(h.sendTelegram).toHaveBeenCalledWith(
      expect.objectContaining({
        parseMode: 'HTML',
        text: '<b>Handoff</b>: &lt;b&gt;Call me&lt;/b&gt; &amp; *now*',
      }),
    )
  })

  it('MarkdownV2 mode escapes reserved characters in values', async () => {
    h.db = seed([automation(triggerEvent)], [tgStep({ parse_mode: 'MarkdownV2' })])
    await dispatch('business_event', eventCtx)
    expect(h.sendTelegram.mock.calls[0][0].text).toBe('Reason: <b\\>Call me</b\\> & \\*now\\*')
  })
})
