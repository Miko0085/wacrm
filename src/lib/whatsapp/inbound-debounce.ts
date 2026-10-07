import type { SupabaseClient } from '@supabase/supabase-js'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { runBounded } from '@/lib/ops/pool'

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
  status: 'pending' | 'running' | 'dead'
  run_at: string
  locked_at?: string | null
  attempt_count?: number
  last_error?: string | null
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

  if (flowResult.consumed) return

  const triggerTypes: Array<
    'first_inbound_message' | 'new_message_received' | 'keyword_match'
  > = ['new_message_received', 'keyword_match']

  if (job.is_first_inbound) {
    triggerTypes.unshift('first_inbound_message')
  }

  // The AI must stay quiet iff a deterministic responder actually tried to
  // answer THIS merged turn. Decide it from the real dispatch results rather
  // than a second DB lookup that could disagree (different text, race with
  // an edit, missing triggers).
  let deterministicResponderHandled = false
  for (const triggerType of triggerTypes) {
    const dispatch = await runAutomationsForTrigger({
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
    if (dispatch.customer_facing_attempted) deterministicResponderHandled = true
  }

  await dispatchInboundToAiReply({
    accountId: job.account_id,
    conversationId: job.conversation_id,
    contactId: job.contact_id,
    configOwnerUserId: job.user_id,
    deterministicResponderHandled,
  })
}

const DEBOUNCE_LEASE_MS = 5 * 60_000
export const MAX_DEBOUNCE_ATTEMPTS = 5
const DEFAULT_DEBOUNCE_CONCURRENCY = 3

export function debounceRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(15 * 60_000, 30_000 * 2 ** (safeAttempt - 1))
}

export interface DebounceDrainResult {
  processed: number
  failed: number
  recovered: number
  dead: number
  /** Due jobs left untouched because the cron time budget ran out. */
  skipped: number
}

export async function drainInboundDebounceJobs(
  db: SupabaseClient,
  opts: { limit?: number; concurrency?: number; deadline?: number } = {},
): Promise<DebounceDrainResult> {
  const limit = opts.limit ?? 20
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const staleBefore = new Date(now - DEBOUNCE_LEASE_MS).toISOString()

  const { data: staleRows, error: staleError } = await db
    .from('inbound_debounce_jobs')
    .select('id, version, attempt_count')
    .eq('status', 'running')
    .or(`locked_at.is.null,locked_at.lt.${staleBefore}`)
    .limit(limit)

  if (staleError) throw staleError

  let recovered = 0
  let dead = 0
  for (const stale of staleRows ?? []) {
    // A job whose worker keeps dying (OOM, platform timeout) never reaches the
    // catch block below, so the attempt budget must be enforced here too —
    // otherwise it crash-loops forever.
    const exhausted = (stale.attempt_count ?? 0) >= MAX_DEBOUNCE_ATTEMPTS
    const { data: revived, error: reviveError } = await db
      .from('inbound_debounce_jobs')
      .update({
        status: exhausted ? 'dead' : 'pending',
        locked_at: null,
        run_at: nowIso,
        last_error: exhausted
          ? 'worker lease expired repeatedly; moved to dead-letter'
          : 'worker lease expired; recovered by scheduler',
        updated_at: nowIso,
      })
      .eq('id', stale.id)
      .eq('version', stale.version)
      .eq('status', 'running')
      .select('id')
      .maybeSingle()
    if (!reviveError && revived) {
      if (exhausted) dead += 1
      else recovered += 1
    }
  }

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

  const pool = await runBounded(
    (rows ?? []) as InboundDebounceJob[],
    opts.concurrency ?? DEFAULT_DEBOUNCE_CONCURRENCY,
    async (row) => {
      const { data: claimed, error: claimError } = await db
        .from('inbound_debounce_jobs')
        .update({
          status: 'running',
          locked_at: new Date().toISOString(),
          attempt_count: (row.attempt_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('version', row.version)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle()

      if (claimError || !claimed) return

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
        // Never log message text — only ids and the error message.
        console.error(
          '[inbound-debounce] processing failed:',
          claimedJob.id,
          err instanceof Error ? err.message : err,
        )
        const attempts = claimedJob.attempt_count ?? 1
        const terminal = attempts >= MAX_DEBOUNCE_ATTEMPTS
        if (terminal) dead += 1
        await db
          .from('inbound_debounce_jobs')
          .update({
            status: terminal ? 'dead' : 'pending',
            locked_at: null,
            run_at: new Date(Date.now() + debounceRetryDelayMs(attempts)).toISOString(),
            last_error: err instanceof Error ? err.message : String(err),
            updated_at: new Date().toISOString(),
          })
          .eq('id', claimedJob.id)
          .eq('version', claimedJob.version)
          .eq('status', 'running')
      }
    },
    { deadline: opts.deadline },
  )

  return { processed, failed, recovered, dead, skipped: pool.skipped }
}
