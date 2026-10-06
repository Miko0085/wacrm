#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const ACCOUNT_ID =
  process.env.NIKA_WACRM_ACCOUNT_ID || '6762c55f-cbc9-4185-ad56-fca989006295'
const SUPABASE_URL =
  process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    'Missing SUPABASE_INTERNAL_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
  )
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const managed = {
  flow: 'Nika — Property Selection Qualification',
  selectionAutomation: 'Nika — Selection Reply → Qualification Flow',
  callAutomation: 'Nika — Call Request → Human Handoff',
  telegramAutomation: 'Nika — Human Handoff → Telegram',
}

const splitEnv = (name, fallback) =>
  (process.env[name] || fallback)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)

const selectionReplyIds = splitEnv(
  'NIKA_SELECTION_REPLY_IDS',
  'get_property_selection,get_selection,Получить подборку,Get a selection',
)
const callReplyIds = splitEnv(
  'NIKA_CALL_REPLY_IDS',
  'request_call,request_callback,Request a call',
)

const mediaUrl = (process.env.NIKA_SELECTION_MEDIA_URL || '').trim()
const mediaType = ['image', 'video', 'document'].includes(
  process.env.NIKA_SELECTION_MEDIA_TYPE,
)
  ? process.env.NIKA_SELECTION_MEDIA_TYPE
  : 'document'

function logPlan(title, body) {
  console.log(`\n=== ${title} ===`)
  console.log(JSON.stringify(body, null, 2))
}

async function resolveOwnerUserId() {
  if (process.env.NIKA_WACRM_OWNER_USER_ID) {
    return process.env.NIKA_WACRM_OWNER_USER_ID
  }

  const { data: existing } = await db
    .from('automations')
    .select('user_id')
    .eq('account_id', ACCOUNT_ID)
    .eq('name', 'Cold WhatsApp — Positive Lead → amoCRM')
    .maybeSingle()

  if (existing?.user_id) return existing.user_id

  const { data: member } = await db
    .from('account_memberships')
    .select('user_id, role')
    .eq('account_id', ACCOUNT_ID)
    .in('role', ['owner', 'admin'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!member?.user_id) {
    throw new Error(
      'Could not resolve an account owner/admin. Set NIKA_WACRM_OWNER_USER_ID.',
    )
  }
  return member.user_id
}

function buildFlowNodes() {
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
        caption: process.env.NIKA_SELECTION_MEDIA_CAPTION || '',
        filename: process.env.NIKA_SELECTION_MEDIA_FILENAME || '',
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
          process.env.NIKA_SELECTION_INTRO_MESSAGE ||
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
          process.env.NIKA_PURPOSE_QUESTION ||
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
          process.env.NIKA_BUDGET_QUESTION ||
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
          process.env.NIKA_TIMELINE_QUESTION ||
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
          'Qualified WhatsApp lead. Purpose={{vars.ai_extracted_purpose}}; budget={{vars.ai_extracted_budget}} {{vars.ai_extracted_currency}}; timeline={{vars.ai_extracted_timeline}}. Latest summary={{vars.ai_summary}}',
      },
      position_x: 0,
      position_y: 1200,
    },
  )

  return nodes
}

async function findByName(table, name) {
  const { data, error } = await db
    .from(table)
    .select('*')
    .eq('account_id', ACCOUNT_ID)
    .eq('name', name)
    .maybeSingle()
  if (error) throw error
  return data
}

async function ensureFlow(userId) {
  const nodes = buildFlowNodes()
  const desired = {
    user_id: userId,
    account_id: ACCOUNT_ID,
    name: managed.flow,
    description:
      'Managed Nika stateful qualification flow. Handles delayed replies, AI Decision, expert-question handoff, and business-event handoff.',
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
  }

  const existing = await findByName('flows', managed.flow)
  logPlan(existing ? 'UPDATE FLOW' : 'CREATE FLOW', {
    existing_id: existing?.id ?? null,
    desired,
    nodes,
  })

  if (!APPLY) return existing?.id || '<flow-id-after-apply>'

  let flowId = existing?.id
  if (existing) {
    const { error } = await db.from('flows').update(desired).eq('id', flowId)
    if (error) throw error
  } else {
    const { data, error } = await db
      .from('flows')
      .insert(desired)
      .select('id')
      .single()
    if (error) throw error
    flowId = data.id
  }

  // Replace only nodes belonging to this exact managed flow. No other
  // existing flow or automation is deleted or modified.
  const { error: delError } = await db
    .from('flow_nodes')
    .delete()
    .eq('flow_id', flowId)
  if (delError) throw delError

  const { error: nodesError } = await db.from('flow_nodes').insert(
    nodes.map((node) => ({ ...node, flow_id: flowId })),
  )
  if (nodesError) throw nodesError

  return flowId
}

async function replaceAutomationSteps(automationId, steps) {
  const { error: delError } = await db
    .from('automation_steps')
    .delete()
    .eq('automation_id', automationId)
  if (delError) throw delError

  const rows = []
  const walk = (list, parentId = null, branch = null) => {
    list.forEach((step, position) => {
      const id = crypto.randomUUID()
      rows.push({
        id,
        automation_id: automationId,
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

  if (rows.length) {
    const { error } = await db.from('automation_steps').insert(rows)
    if (error) throw error
  }
}

async function ensureAutomation(userId, spec) {
  const existing = await findByName('automations', spec.name)
  const desired = {
    user_id: userId,
    account_id: ACCOUNT_ID,
    name: spec.name,
    description: spec.description,
    trigger_type: spec.trigger_type,
    trigger_config: spec.trigger_config,
    is_active: spec.is_active,
  }

  logPlan(existing ? 'UPDATE AUTOMATION' : 'CREATE AUTOMATION', {
    existing_id: existing?.id ?? null,
    desired,
    steps: spec.steps,
  })

  if (!APPLY) return existing?.id || '<automation-id-after-apply>'

  let id = existing?.id
  if (existing) {
    const { error } = await db.from('automations').update(desired).eq('id', id)
    if (error) throw error
  } else {
    const { data, error } = await db
      .from('automations')
      .insert(desired)
      .select('id')
      .single()
    if (error) throw error
    id = data.id
  }

  await replaceAutomationSteps(id, spec.steps)
  return id
}

async function resolveTelegramConnection() {
  const configuredId = (process.env.NIKA_TELEGRAM_CONNECTION_ID || '').trim()
  if (configuredId) return configuredId

  const preferredName = (process.env.NIKA_TELEGRAM_CONNECTION_NAME || '').trim()
  let query = db
    .from('telegram_connections')
    .select('id, name')
    .eq('account_id', ACCOUNT_ID)
    .eq('is_active', true)

  if (preferredName) query = query.eq('name', preferredName)

  const { data, error } = await query.order('created_at', { ascending: true }).limit(1)
  if (error) {
    // Migration may not have been applied in dry-run mode yet.
    if (!APPLY) return null
    throw error
  }
  return data?.[0]?.id ?? null
}

async function main() {
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN')
  console.log(`Account: ${ACCOUNT_ID}`)

  const userId = await resolveOwnerUserId()
  console.log(`Owner user: ${userId}`)

  const flowId = await ensureFlow(userId)

  await ensureAutomation(userId, {
    name: managed.selectionAutomation,
    description:
      'Starts the managed stateful property-selection qualification flow from WhatsApp quick replies.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: selectionReplyIds },
    is_active: true,
    steps: [
      {
        step_type: 'emit_business_event',
        step_config: {
          event_type: 'selection_requested',
          source: 'whatsapp_quick_reply',
          payload_template:
            '{"conversation_id":"{{conversation.id}}","contact_id":"{{contact.id}}"}',
        },
      },
      {
        step_type: 'start_flow',
        step_config: { flow_id: flowId },
      },
    ],
  })

  await ensureAutomation(userId, {
    name: managed.callAutomation,
    description:
      'Turns a WhatsApp call-request quick reply into a durable human handoff business event.',
    trigger_type: 'interactive_reply',
    trigger_config: { reply_ids: callReplyIds },
    is_active: true,
    steps: [
      {
        step_type: 'emit_business_event',
        step_config: {
          event_type: 'human_handoff_requested',
          source: 'whatsapp_call_request',
          payload_template:
            '{"reason":"request_call","conversation_id":"{{conversation.id}}","contact_id":"{{contact.id}}"}',
        },
      },
    ],
  })

  const telegramConnectionId = await resolveTelegramConnection()
  await ensureAutomation(userId, {
    name: managed.telegramAutomation,
    description:
      'Notifies the configured Telegram destination when WACRM requests human handoff.',
    trigger_type: 'business_event',
    trigger_config: { event_types: ['human_handoff_requested'] },
    is_active: Boolean(telegramConnectionId),
    steps: [
      {
        step_type: 'send_telegram',
        step_config: {
          connection_id: telegramConnectionId || '',
          chat_id: '',
          parse_mode: 'HTML',
          message:
            '🚨 <b>WACRM human handoff</b>\nContact: {{contact.id}}\nConversation: {{conversation.id}}\nReason: {{vars.ai_reason}}\nSummary: {{vars.ai_summary}}',
        },
      },
    ],
  })

  if (!telegramConnectionId) {
    console.log(
      '\nTelegram handoff automation is created/updated INACTIVE until a Telegram connection exists. Re-run this seed after connecting a bot.',
    )
  }

  console.log(
    '\nExisting production automation "Cold WhatsApp — Positive Lead → amoCRM" is intentionally untouched.',
  )
  console.log(APPLY ? '\nSeed applied.' : '\nDry run only. Re-run with --apply to write.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
