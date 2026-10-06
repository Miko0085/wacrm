import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

export interface InboundDebounceJob {
  id: string
  account_id: string
  user_id: string
  contact_id: string
  conversation_id: string
  message_ids: unknown
  text_parts: unknown
  is_first_inbound: boolean
  version: number
  status: 'pending' | 'running'
  run_at: string
}

export async function queueInboundTextTurn(args: {
  db: SupabaseClient
  accountId: string
  userId: string
  contactId: string
  conversationId: string
  providerMessageId: string
  text: string
  isFirstInbound: boolean
  delaySeconds?: number
}): Promise<string> {
  const delay = Math.min(300, Math.max(1, Math.floor(args.delaySeconds ?? 35)))
  const { data, error } = await args.db.rpc('queue_inbound_debounce', {
    p_account_id: args.accountId,
    p_user_id: args.userId,
    p_contact_id: args.contactId,
    p_conversation_id: args.conversationId,
    p_message_id: args.providerMessageId,
    p_text: args.text,
    p_is_first_inbound: args.isFirstInbound,
    p_delay_seconds: delay,
  })
  if (error) throw error
  if (!data) throw new Error('queue_inbound_debounce returned no job id')
  return String(data)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

export async function processDebouncedInboundTurn(
  db: SupabaseClient,
  job: InboundDebounceJob,
): Promise<void> {
  const textParts = stringArray(job.text_parts)
    .map((part) => part.trim())
    .filter(Boolean)
  if (textParts.length === 0) return

  const mergedText = textParts.join('\n')
  const syntheticMessageId = `debounce:${job.id}:v${job.version}`

  const flowResult = await dispatchInboundToFlows({
    accountId: job.account_id,
    userId: job.user_id,
    contactId: job.contact_id,
    conversationId: job.conversation_id,
    message: {
      kind: 'text',
      text: mergedText,
      meta_message_id: syntheticMessageId,
    },
    isFirstInboundMessage: job.is_first_inbound,
  })

  if (!flowResult.consumed) {
    const triggerTypes: Array<
      'first_inbound_message' | 'new_message_received' | 'keyword_match'
    > = ['new_message_received', 'keyword_match']

    if (job.is_first_inbound) {
      triggerTypes.unshift('first_inbound_message')
    }

    for (const triggerType of triggerTypes) {
      await runAutomationsForTrigger({
        accountId: job.account_id,
        triggerType,
        contactId: job.contact_id,
        context: {
          message_text: mergedText,
          conversation_id: job.conversation_id,
          vars: {
            debounce_job_id: job.id,
            debounce_message_count: textParts.length,
          },
        },
      })
    }

    await dispatchInboundToAiReply({
      accountId: job.account_id,
      conversationId: job.conversation_id,
      contactId: job.contact_id,
      configOwnerUserId: job.user_id,
    })
  }
}

export async function drainInboundDebounceJobs(
  db: SupabaseClient,
  limit = 50,
): Promise<{ processed: number; failed: number }> {
  const nowIso = new Date().toISOString()
  const { data: rows, error } = await db
    .from('inbound_debounce_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(limit)

  if (error) throw error

  let processed = 0
  let failed = 0

  for (const raw of rows ?? []) {
    const row = raw as InboundDebounceJob
    const { data: claimed, error: claimError } = await db
      .from('inbound_debounce_jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('version', row.version)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()

    if (claimError || !claimed) continue

    const claimedJob = claimed as InboundDebounceJob

    try {
      await processDebouncedInboundTurn(db, claimedJob)
      // Delete only the exact claimed version. If another inbound arrived
      // while we were processing, the RPC already advanced the version and
      // reset the row to pending, so this becomes a no-op and the new batch
      // survives for the next cron tick.
      await db
        .from('inbound_debounce_jobs')
        .delete()
        .eq('id', claimedJob.id)
        .eq('version', claimedJob.version)
        .eq('status', 'running')
      processed += 1
    } catch (err) {
      failed += 1
      console.error(
        '[inbound-debounce] processing failed:',
        claimedJob.id,
        err instanceof Error ? err.message : err,
      )
      await db
        .from('inbound_debounce_jobs')
        .update({
          status: 'pending',
          run_at: new Date(Date.now() + 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', claimedJob.id)
        .eq('version', claimedJob.version)
        .eq('status', 'running')
    }
  }

  return { processed, failed }
}
