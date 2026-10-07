#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const ACCOUNT_ID = (process.env.NIKA_WACRM_ACCOUNT_ID || '').trim()
const SUPABASE_URL =
  process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    'Missing SUPABASE_INTERNAL_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
  )
  process.exit(1)
}

if (!ACCOUNT_ID) {
  console.error('NIKA_WACRM_ACCOUNT_ID is required. Refusing to guess a production account.')
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
  webhookAutomation: 'Nika — Human Handoff → External Webhook',
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
          'Qualified WhatsApp lead. Purpose answer={{vars.purpose_answer}}; budget answer={{vars.budget_answer}}; timeline answer={{vars.timeline_answer}}. Latest AI summary={{vars.ai_summary}}',
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
    const { count: activeRuns, error: runError } = await db
      .from('flow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('flow_id', flowId)
      .eq('status', 'active')
    if (runError) throw runError
    if ((activeRuns ?? 0) > 0) {
      throw new Error(
        `Refusing to replace managed flow while ${activeRuns} active run(s) exist. Finish/handoff them first.`,
      )
    }
  }

  const previousStatus = existing?.status ?? null
  const { data: previousNodes, error: backupError } = existing
    ? await db.from('flow_nodes').select('*').eq('flow_id', flowId)
    : { data: [], error: null }
  if (backupError) throw backupError

  if (existing) {
    // Make the managed flow temporarily non-startable while its graph is
    // replaced. startFlowForContact also rejects non-active flows.
    const { error } = await db
      .from('flows')
      .update({ ...desired, status: 'draft' })
      .eq('id', flowId)
    if (error) throw error
  } else {
    const { data, error } = await db
      .from('flows')
      .insert({ ...desired, status: 'draft' })
      .select('id')
      .single()
    if (error) throw error
    flowId = data.id
  }

  try {
    const { error: delError } = await db
      .from('flow_nodes')
      .delete()
      .eq('flow_id', flowId)
    if (delError) throw delError

    const { error: nodesError } = await db.from('flow_nodes').insert(
      nodes.map((node) => ({ ...node, flow_id: flowId })),
    )
    if (nodesError) throw nodesError

    const { error: activateError } = await db
      .from('flows')
      .update({ status: desired.status })
      .eq('id', flowId)
    if (activateError) throw activateError
  } catch (err) {
    await db.from('flow_nodes').delete().eq('flow_id', flowId)
    if (previousNodes?.length) {
      const { error: restoreError } = await db.from('flow_nodes').insert(previousNodes)
      if (restoreError) {
        console.error('CRITICAL: failed to restore previous flow nodes', restoreError)
      }
    }
    if (existing) {
      await db
        .from('flows')
        .update({ status: previousStatus, ...existing })
        .eq('id', flowId)
    }
    throw err
  }

  return flowId
}

async function replaceAutomationSteps(automationId, steps) {
  const { data: previousRows, error: backupError } = await db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', automationId)
  if (backupError) throw backupError

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

  const { error: delError } = await db
    .from('automation_steps')
    .delete()
    .eq('automation_id', automationId)
  if (delError) throw delError

  try {
    if (rows.length) {
      const { error } = await db.from('automation_steps').insert(rows)
      if (error) throw error
    }
  } catch (err) {
    // Best-effort rollback: restore the exact previous step rows before
    // surfacing the apply failure. The automation is kept inactive by the
    // caller while replacement is in progress.
    await db.from('automation_steps').delete().eq('automation_id', automationId)
    if (previousRows?.length) {
      const { error: restoreError } = await db.from('automation_steps').insert(previousRows)
      if (restoreError) {
        console.error('CRITICAL: failed to restore previous automation steps', restoreError)
      }
    }
    throw err
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
    // Disable the managed automation during step replacement so a live trigger
    // can never observe a partially replaced tree.
    const { error } = await db
      .from('automations')
      .update({ ...desired, is_active: false })
      .eq('id', id)
    if (error) throw error
  } else {
    const { data, error } = await db
      .from('automations')
      .insert({ ...desired, is_active: false })
      .select('id')
      .single()
    if (error) throw error
    id = data.id
  }

  try {
    await replaceAutomationSteps(id, spec.steps)
    const { error: activateError } = await db
      .from('automations')
      .update({ is_active: desired.is_active })
      .eq('id', id)
    if (activateError) throw activateError
  } catch (err) {
    // Existing automations retain their previous activation state after a
    // failed apply; newly created ones remain inactive for safe inspection.
    if (existing) {
      await db
        .from('automations')
        .update({ is_active: existing.is_active })
        .eq('id', id)
    }
    throw err
  }
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
          parse_mode: null,
          message:
            '🚨 WACRM human handoff\nEvent: {{event.id}}\nContact: {{contact.id}}\nConversation: {{conversation.id}}\nReason: {{event.reason}}\nSummary: {{event.summary}}',
        },
      },
    ],
  })

  if (!telegramConnectionId) {
    console.log(
      '\nTelegram handoff automation is created/updated INACTIVE until a Telegram connection exists. Re-run this seed after connecting a bot.',
    )
  }

  const handoffWebhookUrl = (process.env.NIKA_HANDOFF_WEBHOOK_URL || '').trim()
  if (handoffWebhookUrl) {
    let headers = {}
    if (process.env.NIKA_HANDOFF_WEBHOOK_HEADERS_JSON) {
      headers = JSON.parse(process.env.NIKA_HANDOFF_WEBHOOK_HEADERS_JSON)
    }
    await ensureAutomation(userId, {
      name: managed.webhookAutomation,
      description:
        'Forwards durable human handoff business events to an external service.',
      trigger_type: 'business_event',
      trigger_config: { event_types: ['human_handoff_requested'] },
      is_active: true,
      steps: [
        {
          step_type: 'send_webhook',
          step_config: {
            url: handoffWebhookUrl,
            headers,
            body_template:
              '{"event_id":"{{event.id}}","event_type":"{{event.type}}","contact_id":"{{contact.id}}","conversation_id":"{{conversation.id}}","reason":"{{event.reason}}","summary":"{{event.summary}}"}',
          },
        },
      ],
    })
  } else {
    console.log(
      '\nNo NIKA_HANDOFF_WEBHOOK_URL set; external handoff webhook automation was not created.',
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
