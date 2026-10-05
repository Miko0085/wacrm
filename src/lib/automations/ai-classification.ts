import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiClassificationStepConfig } from '@/types'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import type { ChatMessage } from '@/lib/ai/types'

export type AiClassificationIntent =
  | 'positive'
  | 'neutral'
  | 'negative'
  | 'opt_out'
  | 'unclear'

export interface AiClassificationResult {
  intent: AiClassificationIntent
  score: number
  qualified: boolean
  language: string
  summary: string
  reason: string
}

const ALLOWED_INTENTS = new Set<AiClassificationIntent>([
  'positive',
  'neutral',
  'negative',
  'opt_out',
  'unclear',
])

const DEFAULT_INSTRUCTION =
  'Determine whether the customer shows genuine interest in the offer and should be transferred to sales.'

/**
 * Classify the current inbound message with the account's existing BYOK AI
 * configuration. This is deliberately separate from the customer-facing
 * auto-reply path: it never sends a WhatsApp message and only returns a
 * validated structured decision to the automation engine.
 */
export async function classifyAutomationMessage(args: {
  db: SupabaseClient
  accountId: string
  conversationId?: string
  messageText: string
  config: AiClassificationStepConfig
}): Promise<AiClassificationResult> {
  const { db, accountId, conversationId, messageText, config } = args
  const aiConfig = await loadAiConfig(db, accountId)
  if (!aiConfig) {
    throw new Error(
      'AI Classification requires AI to be configured in AI Agents → Setup',
    )
  }

  const contextLimit = clampContextMessages(config.context_messages)
  const transcript = conversationId
    ? await loadScopedConversationMessages(db, accountId, conversationId, contextLimit)
    : []
  const latest = interpolateInput(config.input_template || '{{message.text}}', messageText)
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: buildClassificationInput(transcript, latest),
    },
  ]
  const systemPrompt = buildClassificationPrompt(config.instruction || DEFAULT_INSTRUCTION)

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generated = await generateReply({
      config: aiConfig,
      systemPrompt,
      messages,
    })
    try {
      return parseAiClassificationResult(generated.text)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }

  throw new Error(
    `AI Classification returned invalid structured output after retry: ${lastError?.message ?? 'unknown parse error'}`,
  )
}

export function classificationTakesYesBranch(
  result: AiClassificationResult,
  config: AiClassificationStepConfig,
): boolean {
  if (result.intent === 'opt_out') return false
  const positiveIntent = config.positive_intent ?? 'positive'
  const minScore = clampScore(config.min_score)
  return (
    result.intent === positiveIntent &&
    result.score >= minScore &&
    result.qualified === true
  )
}

export function classificationVars(
  result: AiClassificationResult,
): Record<string, unknown> {
  return {
    ai_intent: result.intent,
    ai_score: result.score,
    ai_qualified: result.qualified,
    ai_language: result.language,
    ai_summary: result.summary,
    ai_reason: result.reason,
  }
}

export function parseAiClassificationResult(raw: string): AiClassificationResult {
  const cleaned = stripMarkdownFence(raw).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error('response is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response must be a JSON object')
  }

  const value = parsed as Record<string, unknown>
  if (!ALLOWED_INTENTS.has(value.intent as AiClassificationIntent)) {
    throw new Error('intent is invalid')
  }
  if (
    typeof value.score !== 'number' ||
    !Number.isFinite(value.score) ||
    !Number.isInteger(value.score) ||
    value.score < 0 ||
    value.score > 100
  ) {
    throw new Error('score must be an integer from 0 to 100')
  }
  if (typeof value.qualified !== 'boolean') {
    throw new Error('qualified must be boolean')
  }
  for (const key of ['language', 'summary', 'reason'] as const) {
    if (typeof value[key] !== 'string') {
      throw new Error(`${key} must be a string`)
    }
  }

  return {
    intent: value.intent as AiClassificationIntent,
    score: value.score,
    qualified: value.qualified,
    language: value.language,
    summary: value.summary,
    reason: value.reason,
  }
}

function buildClassificationPrompt(instruction: string): string {
  return `You are a CRM lead-intent classifier.

Your task is to classify whether the customer is genuinely interested in the offer and should be transferred to sales.

Return ONLY valid JSON with exactly these fields:
{
  "intent": "positive|neutral|negative|opt_out|unclear",
  "score": 0,
  "qualified": false,
  "language": "",
  "summary": "",
  "reason": ""
}

Definitions:
- positive: customer clearly wants to continue, asks for options, prices, availability, details, a consultation, call, viewing, selection, or purchase information.
- neutral: conversation exists but there is not enough buying or interest signal.
- negative: customer clearly rejects the offer or states they are not interested.
- opt_out: customer asks not to be contacted, unsubscribe, STOP, or equivalent.
- unclear: the message cannot safely be classified.

Never classify a simple courtesy response as positive unless context clearly shows genuine interest.
Do not invent information.

User instruction:
${instruction}`
}

function buildClassificationInput(
  history: Array<{ sender_type: string; content_text: string | null }>,
  latest: string,
): string {
  const transcript = history
    .filter((m) => m.content_text?.trim())
    .map((m) => {
      const role = m.sender_type === 'customer' ? 'CUSTOMER' : 'AGENT'
      return `${role}: ${m.content_text!.trim()}`
    })
    .join('\n')

  return [
    transcript ? `RECENT CONVERSATION:\n${transcript}` : '',
    `LATEST CUSTOMER MESSAGE:\n${latest}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function loadScopedConversationMessages(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  limit: number,
): Promise<Array<{ sender_type: string; content_text: string | null }>> {
  const { data: conversation, error: conversationError } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (conversationError) throw conversationError
  if (!conversation) return []

  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['customer', 'agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error

  return ((data ?? []) as Array<{
    sender_type: string
    content_text: string | null
    created_at: string
  }>).reverse()
}

function interpolateInput(template: string, messageText: string): string {
  return template.replace(/\{\{\s*message\.text\s*\}\}/g, messageText)
}

function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1] : trimmed
}

function clampContextMessages(value: number | undefined): number {
  if (!Number.isInteger(value)) return 5
  return Math.min(20, Math.max(1, value!))
}

function clampScore(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 60
  return Math.min(100, Math.max(0, value))
}
