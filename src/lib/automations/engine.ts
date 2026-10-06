import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  AiClassificationStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  BusinessEventTriggerConfig,
  EmitBusinessEventStepConfig,
  SendTelegramStepConfig,
  StartFlowStepConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendMediaStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './meta-send'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { recordBusinessEvent } from '@/lib/business-events/record'
import { sendTelegramNotification } from '@/lib/telegram/send'
import {
  classifyAutomationMessage,
  classificationTakesYesBranch,
  classificationVars,
} from './ai-classification'

export interface AutomationContext {
  message_text?: string
  conversation_id?: string
  vars?: Record<string, unknown>
  tag_id?: string
  agent_id?: string
  interactive_reply_id?: string
  business_event_id?: string
  business_event_type?: string
  business_event_payload?: Record<string, unknown>
}

export interface DispatchInput {
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  user_id: string
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      account_id: automation.account_id,
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) console.error('[automations] increment counter failed:', rpcErr)
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  const db = supabaseAdmin()
  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped
  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      if (step.step_type === 'ai_classification') {
        const cfg = step.step_config as AiClassificationStepConfig
        const result = await classifyAutomationMessage({
          db,
          accountId: args.automation.account_id,
          conversationId: args.context.conversation_id,
          messageText: String(args.context.message_text ?? ''),
          config: cfg,
        })
        args.context.vars = {
          ...(args.context.vars ?? {}),
          ...classificationVars(result),
          wacrm_contact_id: args.contactId ?? '',
          wacrm_conversation_id: args.context.conversation_id ?? '',
        }
        const taken = classificationTakesYesBranch(result, cfg)
        results.push({
          step_id: step.id,
          step_type: 'ai_classification',
          status: 'success',
          detail: `intent=${result.intent} primary=${result.primary_intent} confidence=${result.confidence} requires_human=${result.requires_human} safe_to_answer=${result.safe_to_answer} score=${result.score} qualified=${result.qualified} branch=${taken ? 'yes' : 'no'}`,
        })
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()
  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }
    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }
    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }
    case 'send_media': {
      const cfg = step.step_config as SendMediaStepConfig
      if (!args.contactId) throw new Error('send_media needs a contact')
      if (!cfg.media_url) throw new Error('send_media needs media_url')
      if (!['image', 'video', 'document'].includes(cfg.media_type)) {
        throw new Error('send_media has invalid media_type')
      }
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendMedia({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        kind: cfg.media_type,
        link: cfg.media_url,
        caption: cfg.caption ? interpolate(cfg.caption, args) : undefined,
        filename:
          cfg.media_type === 'document' && cfg.filename
            ? interpolate(cfg.filename, args)
            : undefined,
      })
      return `media sent via WhatsApp (${whatsapp_message_id})`
    }
    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`
      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }
      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: { ...(args.context.vars ?? {}), _tag_chain_depth: depth + 1 },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }
    case 'remove_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db.from('contact_tags').delete().eq('contact_id', args.contactId).eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }
    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        const { data: profiles } = await db.from('profiles').select('user_id').eq('account_id', args.automation.account_id).limit(1)
        agentId = profiles?.[0]?.user_id
      }
      if (!agentId) return 'no agent resolved'
      await db.from('conversations').update({ assigned_agent_id: agentId }).eq('account_id', args.automation.account_id).eq('contact_id', args.contactId)
      return `assigned to ${agentId}`
    }
    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      const value = interpolate(cfg.value, args)
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) return `field ${cfg.field} not writable from automations`
        const { data: field } = await db.from('custom_fields').select('id').eq('id', customFieldId).eq('account_id', args.automation.account_id).maybeSingle()
        if (!field) return `field ${cfg.field} not writable from automations`
        await db.from('contact_custom_values').upsert(
          { contact_id: args.contactId, custom_field_id: customFieldId, value },
          { onConflict: 'contact_id,custom_field_id' },
        )
        return 'custom field updated'
      }
      const allowed = new Set(['name', 'email', 'company', 'wa_marketing_status'])
      if (!allowed.has(cfg.field)) return `field ${cfg.field} not writable from automations`
      const extra: Record<string, unknown> =
        cfg.field === 'wa_marketing_status'
          ? value === 'OPTED_OUT'
            ? { wa_opt_out_at: new Date().toISOString(), wa_consent_source: 'automation_keyword' }
            : value === 'OPTED_IN'
              ? { wa_opt_in_at: new Date().toISOString(), wa_consent_source: 'automation_keyword' }
              : {}
          : {}
      await db.from('contacts').update({ [cfg.field]: value, updated_at: new Date().toISOString(), ...extra }).eq('id', args.contactId).eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }
    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      const { data: acct } = await db.from('accounts').select('default_currency').eq('id', args.automation.account_id).maybeSingle()
      await db.from('deals').insert({
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }
    case 'emit_business_event': {
      const cfg = step.step_config as EmitBusinessEventStepConfig
      const eventType = interpolate(cfg.event_type ?? '', args).trim()
      if (!eventType) throw new Error('emit_business_event needs event_type')

      const depth = Number(args.context.vars?._business_event_depth ?? 0)
      if (depth >= 5) throw new Error('business event recursion limit reached')

      let payload: Record<string, unknown> = {}
      if (cfg.payload_template?.trim()) {
        const rendered = interpolate(cfg.payload_template, args)
        const parsed = JSON.parse(rendered)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('business event payload must render to a JSON object')
        }
        payload = parsed as Record<string, unknown>
      }

      const recorded = await recordBusinessEvent(db, {
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        contactId: args.contactId,
        conversationId: args.context.conversation_id ?? null,
        eventType,
        source: cfg.source ? interpolate(cfg.source, args) : 'automation',
        payload,
      })

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'business_event',
        contactId: args.contactId,
        context: {
          ...args.context,
          business_event_id: recorded.id,
          business_event_type: eventType,
          business_event_payload: payload,
          vars: {
            ...(args.context.vars ?? {}),
            _business_event_depth: depth + 1,
          },
        },
      })

      return `business event ${eventType} emitted (${recorded.id})`
    }
    case 'start_flow': {
      const cfg = step.step_config as StartFlowStepConfig
      if (!args.contactId) throw new Error('start_flow needs a contact')
      if (!cfg.flow_id) throw new Error('start_flow needs flow_id')
      const conversationId = await resolveConversationId(args)
      const { startFlowForContact } = await import('@/lib/flows/engine')
      const result = await startFlowForContact({
        accountId: args.automation.account_id,
        flowId: cfg.flow_id,
        contactId: args.contactId,
        conversationId,
      })
      return `flow started: ${result.flow_run_id ?? result.outcome ?? 'unknown'}`
    }
    case 'send_telegram': {
      const cfg = step.step_config as SendTelegramStepConfig
      if (!cfg.connection_id) throw new Error('send_telegram needs connection_id')
      const message = interpolate(cfg.message ?? '', args)
      if (!message.trim()) throw new Error('send_telegram has empty message')
      const messageId = await sendTelegramNotification({
        db,
        accountId: args.automation.account_id,
        connectionId: cfg.connection_id,
        chatId: cfg.chat_id ? interpolate(cfg.chat_id, args) : undefined,
        text: message,
        parseMode: cfg.parse_mode,
      })
      return `Telegram message sent (${messageId})`
    }
    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      if (!(await isDeliverableUrl(cfg.url))) throw new Error('send_webhook: destination not allowed')
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }
    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db.from('conversations').update({ status: 'closed', updated_at: new Date().toISOString() }).eq('account_id', args.automation.account_id).eq('contact_id', args.contactId)
      return 'conversation closed'
    }
    default:
      return `unknown step: ${step.step_type}`
  }
}

async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) {
    const prefix = args.triggerEvent === 'tag_added' ? 'tag_added automation cannot send' : 'cannot send'
    throw new Error(`${prefix}: contact has no existing conversation`)
  }
  return data.id as string
}

const WORD_CHAR = '[\\p{L}\\p{N}_]'

export function matchesWholeWord(text: string, keyword: string, caseSensitive = false): boolean {
  if (!keyword) return false
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, caseSensitive ? 'u' : 'iu')
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) => matchesWholeWord(text, raw, cfg.case_sensitive))
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) return false
    return cfg.reply_ids.includes(replyId)
  }
  if (automation.trigger_type === 'business_event') {
    const cfg = automation.trigger_config as BusinessEventTriggerConfig
    const eventType = ctx?.business_event_type
    return Boolean(
      eventType &&
      Array.isArray(cfg?.event_types) &&
      cfg.event_types.includes(eventType),
    )
  }
  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }
  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      const { count } = await db.from('contact_tags').select('id', { count: 'exact', head: true }).eq('contact_id', args.contactId).eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      const { data } = await db.from('contacts').select(cfg.operand).eq('id', args.contactId).eq('account_id', args.automation.account_id).maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'variable': {
      if (!cfg.operand) return false
      const key = cfg.operand.startsWith('vars.')
        ? cfg.operand.slice('vars.'.length)
        : cfg.operand
      const value = args.context.vars?.[key]
      if (value === undefined || value === null) return false
      return String(value) === String(cfg.value ?? '')
    }
    case 'time_of_day': {
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'contact' && prop === 'id') return String(args.contactId ?? '')
    if (ns === 'conversation' && prop === 'id') return String(args.context.conversation_id ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db.from('automation_logs').select('steps_executed, status').eq('id', logId).single()
  const merged = [...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []), ...newItems]
  const update: Record<string, unknown> = { steps_executed: merged }
  if (status !== null) update.status = status
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin().from('automation_logs').update({ status, error_message: errorMessage }).eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin().from('automation_pending_executions').update({ status }).eq('id', id)
}
