// Pure planning code for scripts/seed-nika-orchestration.mjs.
//
// No I/O and no process.exit here, so it can be unit-tested (see
// src/lib/automations/nika-seed-plan.test.ts) and validated against the real
// Flow validator and the real template interpolator before anything is written.

/**
 * Managed-object markers. They live in the object's `description` so no schema
 * change is needed. The seed only ever updates an object that carries its
 * marker; sharing a NAME is never enough.
 */
export const MARKERS = {
  flow: '[NIKA_MANAGED:flow_property_selection_v1]',
  selection: '[NIKA_MANAGED:auto_selection_reply_v1]',
  call: '[NIKA_MANAGED:auto_call_request_v1]',
  telegram: '[NIKA_MANAGED:auto_handoff_telegram_v1]',
  webhook: '[NIKA_MANAGED:auto_handoff_webhook_v1]',
}

export const NAMES = {
  flow: 'Nika — Property Selection Qualification',
  selection: 'Nika — Selection Reply → Qualification Flow',
  call: 'Nika — Call Request → Human Handoff',
  telegram: 'Nika — Human Handoff → Telegram',
  webhook: 'Nika — Human Handoff → External Webhook',
}

/** The pre-existing production automation this seed must never touch. */
export const PROTECTED_AUTOMATION_NAMES = ['Cold WhatsApp — Positive Lead → amoCRM']

export function withMarker(description, marker) {
  const base = String(description || '').trim()
  return base.includes(marker) ? base : `${base} ${marker}`.trim()
}

const splitList = (value, fallback) =>
  (value || fallback)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

/** @param {Record<string, string | undefined>} [env] @returns {any[]} */
export function buildFlowNodes(env = process.env) {
  const mediaUrl = (env.NIKA_SELECTION_MEDIA_URL || '').trim()
  const mediaType = ['image', 'video', 'document'].includes(env.NIKA_SELECTION_MEDIA_TYPE)
    ? env.NIKA_SELECTION_MEDIA_TYPE
    : 'document'
  const firstNode = mediaUrl ? 'send_selection' : 'selection_intro'

  const nodes = [
    {
      node_key: 'start',
      node_type: 'start',
      config: { next_node_key: firstNode },
      position_x: 0,
      position_y: 0,
    },
  ]

  if (mediaUrl) {
    nodes.push({
      node_key: 'send_selection',
      node_type: 'send_media',
      config: {
        media_type: mediaType,
        media_url: mediaUrl,
        caption: env.NIKA_SELECTION_MEDIA_CAPTION || '',
        filename: env.NIKA_SELECTION_MEDIA_FILENAME || '',
        next_node_key: 'ask_purpose',
      },
      position_x: 0,
      position_y: 120,
    })
  } else {
    nodes.push({
      node_key: 'selection_intro',
      node_type: 'send_message',
      config: {
        text:
          env.NIKA_SELECTION_INTRO_MESSAGE ||
          'Thank you. I’ll ask a few quick questions so our specialist can prepare the most relevant options.',
        next_node_key: 'ask_purpose',
      },
      position_x: 0,
      position_y: 120,
    })
  }

  nodes.push(
    {
      node_key: 'ask_purpose',
      node_type: 'collect_input',
      config: {
        prompt_text:
          env.NIKA_PURPOSE_QUESTION ||
          'Are you looking for a property for investment or personal use?',
        var_key: 'purpose_answer',
        next_node_key: 'decide_purpose',
      },
      position_x: 0,
      position_y: 240,
    },
    {
      node_key: 'decide_purpose',
      node_type: 'ai_decision',
      config: {
        instruction:
          'Interpret the customer reply in the current real-estate conversation. Extract qualification data. If the customer asks an expert, legal, tax, financing, yield, availability, contract, or other case-specific question, set requires_human=true. Do not invent information.',
        input_var: 'last_customer_message',
        context_messages: 8,
        next_node_key: 'purpose_handoff_check',
      },
      position_x: 0,
      position_y: 360,
    },
    {
      node_key: 'purpose_handoff_check',
      node_type: 'condition',
      config: {
        subject: 'var',
        subject_key: 'ai_requires_human',
        operator: 'equals',
        value: 'true',
        true_next: 'handoff',
        false_next: 'ask_budget',
      },
      position_x: 0,
      position_y: 480,
    },
    {
      node_key: 'ask_budget',
      node_type: 'collect_input',
      config: {
        prompt_text:
          env.NIKA_BUDGET_QUESTION ||
          'What budget range are you considering?',
        var_key: 'budget_answer',
        next_node_key: 'decide_budget',
      },
      position_x: 0,
      position_y: 600,
    },
    {
      node_key: 'decide_budget',
      node_type: 'ai_decision',
      config: {
        instruction:
          'Interpret the customer reply. Extract budget, currency, financing and any other explicit qualification data. If the reply contains a specialist question or asks for a human, set requires_human=true. Never invent missing facts.',
        input_var: 'last_customer_message',
        context_messages: 10,
        next_node_key: 'budget_handoff_check',
      },
      position_x: 0,
      position_y: 720,
    },
    {
      node_key: 'budget_handoff_check',
      node_type: 'condition',
      config: {
        subject: 'var',
        subject_key: 'ai_requires_human',
        operator: 'equals',
        value: 'true',
        true_next: 'handoff',
        false_next: 'ask_timeline',
      },
      position_x: 0,
      position_y: 840,
    },
    {
      node_key: 'ask_timeline',
      node_type: 'collect_input',
      config: {
        prompt_text:
          env.NIKA_TIMELINE_QUESTION ||
          'When are you planning to make a decision or purchase?',
        var_key: 'timeline_answer',
        next_node_key: 'decide_timeline',
      },
      position_x: 0,
      position_y: 960,
    },
    {
      node_key: 'decide_timeline',
      node_type: 'ai_decision',
      config: {
        instruction:
          'Interpret the customer reply and extract the explicit purchase timeline and other qualification facts. Flag human-required or specialist questions. Do not invent data.',
        input_var: 'last_customer_message',
        context_messages: 12,
        next_node_key: 'handoff',
      },
      position_x: 0,
      position_y: 1080,
    },
    {
      node_key: 'handoff',
      node_type: 'handoff',
      config: {
        note:
          'Qualified WhatsApp lead. Purpose answer={{vars.purpose_answer}}; budget answer={{vars.budget_answer}}; timeline answer={{vars.timeline_answer}}. Latest AI summary={{vars.ai_summary}}',
      },
      position_x: 0,
      position_y: 1200,
    },
  )

  return nodes
}


/** @param {Record<string, string | undefined>} [env] @returns {{marker: string, row: any, nodes: any[]}} */
export function buildFlowSpec(env = process.env) {
  return {
    marker: MARKERS.flow,
    row: {
      name: NAMES.flow,
      description: withMarker(
        'Managed Nika stateful qualification flow. Handles delayed replies, AI Decision, expert-question handoff, and business-event handoff.',
        MARKERS.flow,
      ),
      status: 'active',
      trigger_type: 'manual',
      trigger_config: {},
      entry_node_id: 'start',
      fallback_policy: {
        on_unknown_reply: 'reprompt',
        max_reprompts: 2,
        on_timeout_hours: 24,
        on_exhaust: 'handoff',
      },
    },
    nodes: buildFlowNodes(env),
  }
}

/**
 * Templates that embed customer/event text inside JSON use {{json.*}}, which
 * JSON-encodes the value (quotes, newlines, unicode) — raw {{event.reason}}
 * inside a JSON string breaks the document as soon as a quote appears.
 */
export const WEBHOOK_BODY_TEMPLATE =
  '{"event_id":{{json.event.id}},"event_type":{{json.event.type}},"contact_id":{{json.contact.id}},"conversation_id":{{json.conversation.id}},"reason":{{json.event.reason}},"summary":{{json.event.summary}}}'

export const TELEGRAM_MESSAGE_TEMPLATE =
  '🚨 WACRM human handoff\nEvent: {{event.id}}\nContact: {{contact.id}}\nConversation: {{conversation.id}}\nReason: {{event.reason}}\nSummary: {{event.summary}}'

/**
 * Automations in apply order. `flowId` is only known after the flow upsert, so
 * it is injected; `telegramConnectionId` may be null (automation stays inactive).
 */
/**
 * @param {{env?: Record<string, string | undefined>, flowId: string, telegramConnectionId: string | null}} o
 * @returns {Array<{key: string, marker: string, row: any, steps: any[]}>}
 */
export function buildAutomationSpecs({ env = process.env, flowId, telegramConnectionId }) {
  const selectionReplyIds = splitList(
    env.NIKA_SELECTION_REPLY_IDS,
    'get_property_selection,get_selection,Получить подборку,Get a selection',
  )
  const callReplyIds = splitList(
    env.NIKA_CALL_REPLY_IDS,
    'request_call,request_callback,Request a call',
  )

  const specs = [
    {
      key: 'selection',
      marker: MARKERS.selection,
      row: {
        name: NAMES.selection,
        description: withMarker(
          'Starts the managed stateful property-selection qualification flow from WhatsApp quick replies.',
          MARKERS.selection,
        ),
        trigger_type: 'interactive_reply',
        trigger_config: { reply_ids: selectionReplyIds },
        is_active: true,
      },
      steps: [
        {
          step_type: 'emit_business_event',
          step_config: {
            event_type: 'selection_requested',
            source: 'whatsapp_quick_reply',
            payload_template: '{"conversation_id":{{json.conversation.id}},"contact_id":{{json.contact.id}}}',
          },
        },
        { step_type: 'start_flow', step_config: { flow_id: flowId } },
      ],
    },
    {
      key: 'call',
      marker: MARKERS.call,
      row: {
        name: NAMES.call,
        description: withMarker(
          'Turns a WhatsApp call-request quick reply into a durable human handoff business event.',
          MARKERS.call,
        ),
        trigger_type: 'interactive_reply',
        trigger_config: { reply_ids: callReplyIds },
        is_active: true,
      },
      steps: [
        {
          step_type: 'emit_business_event',
          step_config: {
            event_type: 'human_handoff_requested',
            source: 'whatsapp_call_request',
            payload_template:
              '{"reason":"request_call","conversation_id":{{json.conversation.id}},"contact_id":{{json.contact.id}}}',
          },
        },
      ],
    },
    {
      key: 'telegram',
      marker: MARKERS.telegram,
      row: {
        name: NAMES.telegram,
        description: withMarker(
          'Notifies the configured Telegram destination when WACRM requests human handoff.',
          MARKERS.telegram,
        ),
        trigger_type: 'business_event',
        trigger_config: { event_types: ['human_handoff_requested'] },
        is_active: Boolean(telegramConnectionId),
      },
      steps: [
        {
          step_type: 'send_telegram',
          step_config: {
            connection_id: telegramConnectionId || '',
            chat_id: '',
            // Plain text: handoff text is customer-influenced.
            parse_mode: null,
            message: TELEGRAM_MESSAGE_TEMPLATE,
          },
        },
      ],
    },
  ]

  const handoffWebhookUrl = (env.NIKA_HANDOFF_WEBHOOK_URL || '').trim()
  if (handoffWebhookUrl) {
    const headers = env.NIKA_HANDOFF_WEBHOOK_HEADERS_JSON
      ? JSON.parse(env.NIKA_HANDOFF_WEBHOOK_HEADERS_JSON)
      : {}
    specs.push({
      key: 'webhook',
      marker: MARKERS.webhook,
      row: {
        name: NAMES.webhook,
        description: withMarker(
          'Forwards durable human handoff business events to an external service.',
          MARKERS.webhook,
        ),
        trigger_type: 'business_event',
        trigger_config: { event_types: ['human_handoff_requested'] },
        is_active: true,
      },
      steps: [
        {
          step_type: 'send_webhook',
          step_config: { url: handoffWebhookUrl, headers, body_template: WEBHOOK_BODY_TEMPLATE },
        },
      ],
    })
  }

  return specs
}

/**
 * Nested step tree -> flat rows for upsert_managed_automation. Parents always
 * precede their children and every row has a fresh UUID.
 */
/** @param {any[]} steps @param {() => string} [newId] @returns {any[]} */
export function flattenSteps(steps, newId = () => crypto.randomUUID()) {
  const rows = []
  const walk = (list, parentId = null, branch = null) => {
    list.forEach((step, position) => {
      const id = newId()
      rows.push({
        id,
        parent_step_id: parentId,
        branch,
        step_type: step.step_type,
        step_config: step.step_config || {},
        position,
      })
      if (step.branches?.yes) walk(step.branches.yes, id, 'yes')
      if (step.branches?.no) walk(step.branches.no, id, 'no')
    })
  }
  walk(steps)
  return rows
}

const AUTO_ADVANCING = new Set(['start', 'send_message', 'send_media', 'condition', 'ai_decision', 'set_tag'])

function outgoing(node) {
  const c = node.config || {}
  if (node.node_type === 'condition') return [c.true_next, c.false_next].filter(Boolean)
  if (node.node_type === 'handoff' || node.node_type === 'end') return []
  return c.next_node_key ? [c.next_node_key] : []
}

/**
 * Cheap structural guard run by the seed before any write: unique keys, entry
 * exists, every edge resolves, no cycle made only of auto-advancing nodes.
 * (The unit tests additionally run the real Flow activation validator.)
 */
/** @param {any[]} nodes @param {string} entry */
export function assertFlowGraphSane(nodes, entry) {
  const byKey = new Map()
  for (const n of nodes) {
    if (byKey.has(n.node_key)) throw new Error(`duplicate node_key ${n.node_key}`)
    byKey.set(n.node_key, n)
  }
  if (!byKey.has(entry)) throw new Error(`entry node ${entry} missing`)
  for (const n of nodes) {
    for (const next of outgoing(n)) {
      if (!byKey.has(next)) throw new Error(`node ${n.node_key} points at missing node ${next}`)
    }
  }
  const state = new Map()
  const visit = (key, path) => {
    const node = byKey.get(key)
    if (!node || !AUTO_ADVANCING.has(node.node_type)) return
    if (state.get(key) === 'done') return
    if (state.get(key) === 'visiting') {
      throw new Error(`auto-advancing cycle: ${[...path, key].join(' -> ')}`)
    }
    state.set(key, 'visiting')
    for (const next of outgoing(node)) visit(next, [...path, key])
    state.set(key, 'done')
  }
  for (const n of nodes) visit(n.node_key, [])
}
