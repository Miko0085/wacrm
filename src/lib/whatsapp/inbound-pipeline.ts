// ============================================================
// Shared inbound WhatsApp pipeline.
//
// Everything here used to live inline in
// src/app/api/whatsapp/webhook/route.ts (the Meta webhook handler).
// It is extracted verbatim (same logic, same comments explaining WHY
// each guard exists) so a second provider's webhook route — Gupshup's,
// at src/app/api/whatsapp/gupshup/webhook/[token]/route.ts — can drive
// the exact same contact/conversation/message/dedup/status pipeline
// instead of a second hand-rolled copy of the CRM. Per-provider work
// (verifying the webhook, parsing that provider's payload shape,
// resolving media) stays in each provider's own route; everything
// past "here is a normalized inbound event" is shared.
//
// `db` is always the service-role client — every function here is
// meant to be called from inside a webhook handler's `after()` block,
// with no user session to scope RLS to.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// ------------------------------------------------------------
// Normalized shapes every provider's webhook route must produce.
// ------------------------------------------------------------

export type NormalizedContentType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'location'
  | 'template'
  | 'interactive'

export interface NormalizedInboundMessage {
  /** The provider's own message id (Meta's wamid, Gupshup's payload.id). */
  providerMessageId: string
  fromPhone: string
  contactName: string
  /** Unix ms the message was sent/received, per the provider's timestamp. */
  timestampMs: number
  contentType: NormalizedContentType
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /** Tapped button/list-row id, for content_type='interactive'. */
  interactiveReplyId: string | null
  /** Provider message id this is a swipe-reply/quoted-reply to, if any. */
  replyToProviderMessageId: string | null
  /**
   * Raw provider type label (e.g. Meta's "sticker" before it's folded
   * into the shared `image` content type) used ONLY for the
   * conversation-preview fallback text `[${label}]` when there's no
   * caption. Defaults to `contentType` when omitted.
   */
  rawTypeLabel?: string
}

export interface NormalizedReactionEvent {
  /** Provider message id of the message being reacted to. */
  targetProviderMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

/** The subset of WACRM's status ladder a provider's status webhook can produce. */
export type NormalizedStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface NormalizedStatusEvent {
  providerMessageId: string
  status: NormalizedStatus
  timestampMs: number
}

// ------------------------------------------------------------
// Status ladder — shared by every provider.
//
// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once a message
// has been delivered or the user has read or replied, a later "failed"
// status event is a bug in the provider's pipeline (or, for Gupshup
// specifically, an out-of-order callback — Gupshup's own docs warn
// these can arrive non-sequentially) and must be ignored.
// ------------------------------------------------------------
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
export function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

/**
 * Mirror a normalized delivery-status event onto `messages` and
 * `broadcast_recipients`, then fan out the public `message.status_updated`
 * webhook. Idempotent and out-of-order-safe via {@link isValidStatusTransition}.
 */
export async function handleStatusUpdate(
  db: SupabaseClient,
  event: NormalizedStatusEvent,
): Promise<void> {
  // 1) Mirror onto messages (legacy behavior). No `.select()`:
  //    message_id is NOT unique (Meta ids repeat across numbers), so
  //    this updates 0..N rows and must not assume a single row.
  const { error: msgErr } = await db
    .from('messages')
    .update({ status: event.status })
    .eq('message_id', event.providerMessageId)

  if (msgErr) {
    console.error('[inbound-pipeline] Error updating message status:', msgErr)
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id. The
  //    aggregate trigger on broadcast_recipients re-derives the parent
  //    broadcast's sent/delivered/read/failed counts automatically.
  const tsIso = new Date(event.timestampMs).toISOString()

  const { data: recipient, error: recFetchErr } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', event.providerMessageId)
    .maybeSingle()

  if (recFetchErr) {
    console.error('[inbound-pipeline] Error fetching broadcast recipient:', recFetchErr)
  } else if (
    recipient &&
    isValidStatusTransition(recipient.status, event.status)
  ) {
    const update: Record<string, unknown> = { status: event.status }
    if (event.status === 'sent') update.sent_at = tsIso
    if (event.status === 'delivered') update.delivered_at = tsIso
    if (event.status === 'read') update.read_at = tsIso

    const { error: recUpdateErr } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', recipient.id)

    if (recUpdateErr) {
      console.error('[inbound-pipeline] Error updating broadcast recipient status:', recUpdateErr)
    }
  }

  // 3) Webhook fan-out for messages we store (inbox / API sends). Runs
  //    last so a slow subscriber can't delay the mirrors above. Bounded
  //    to one row (message_id isn't unique) purely to resolve the
  //    owning account for delivery.
  const { data: msgRow } = await db
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', event.providerMessageId)
    .limit(1)
    .maybeSingle()

  if (msgRow) {
    const conv = msgRow.conversations as unknown as { account_id: string } | null
    const accountId = conv?.account_id
    if (accountId) {
      await dispatchWebhookEvent(db, accountId, 'message.status_updated', {
        whatsapp_message_id: event.providerMessageId,
        conversation_id: msgRow.conversation_id,
        status: event.status,
      })
    }
  }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures here must
 * not break the main inbound-message flow.
 */
export async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<void> {
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('[inbound-pipeline] Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound-pipeline] flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * System-default STOP keyword — this is NOT a user-configured
 * automation, it always runs, for every account, both providers,
 * regardless of whether the account has any automations at all. An
 * exact (trimmed, case-insensitive) match on the inbound message text
 * against this list flips `wa_marketing_status` to `OPTED_OUT`
 * immediately, feeding the same suppression check every broadcast/
 * template-send path already enforces. Matched on the *whole* message
 * rather than a substring so a sentence that merely contains one of
 * these words ("please don't stop the shipment") doesn't false-positive.
 *
 * A user-configured keyword automation (update_contact_field →
 * wa_marketing_status) still works alongside this and can extend the
 * keyword list per-account; this is the floor, not a replacement.
 */
const STOP_KEYWORDS = new Set([
  'STOP',
  'UNSUBSCRIBE',
  'REMOVE',
  'СТОП',
  'ОТПИСКА',
  'НЕ ПИШИТЕ',
])

export async function applyStopKeywordIfMatched(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  contentText: string | null,
): Promise<void> {
  const normalized = (contentText ?? '').trim().toUpperCase()
  if (!normalized || !STOP_KEYWORDS.has(normalized)) return

  try {
    const { error } = await db
      .from('contacts')
      .update({
        wa_marketing_status: 'OPTED_OUT',
        wa_opt_out_at: new Date().toISOString(),
        wa_consent_source: 'stop_keyword',
      })
      .eq('id', contactId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[inbound-pipeline] STOP-keyword opt-out write failed:', error.message)
    }
  } catch (err) {
    console.error('[inbound-pipeline] applyStopKeywordIfMatched failed:', err)
  }
}

/**
 * Resolve a provider-side message_id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received the
 * parent (e.g. a swipe-reply to a message older than this CRM install).
 */
export async function lookupInternalIdByProviderMessageId(
  db: SupabaseClient,
  providerMessageId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-pipeline] lookupInternalIdByProviderMessageId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages
 * — they're per-(target, actor) state. Upserts/deletes on
 * `message_reactions`, never writes a row into `messages`. Best-effort:
 * a missing parent is logged and skipped so the webhook still acks 200.
 */
export async function handleReaction(
  db: SupabaseClient,
  reaction: NormalizedReactionEvent,
  conversationId: string,
  contactId: string,
): Promise<void> {
  const targetInternalId = await lookupInternalIdByProviderMessageId(
    db,
    reaction.targetProviderMessageId,
    conversationId,
  )
  if (!targetInternalId) {
    console.warn(
      '[inbound-pipeline] reaction target message not found; skipping',
      reaction.targetProviderMessageId,
    )
    return
  }

  if (!reaction.emoji) {
    const { error: delError } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[inbound-pipeline] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await db.from('message_reactions').upsert(
    {
      message_id: targetInternalId,
      conversation_id: conversationId,
      actor_type: 'customer',
      actor_id: contactId,
      emoji: reaction.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' },
  )
  if (upsertError) {
    console.error('[inbound-pipeline] reaction upsert failed:', upsertError.message)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created automation dispatch. */
  wasCreated: boolean
}

export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-pipeline] Error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Oldest-first, one row — NOT `.single()` (errors on both 0 and ≥2
  // rows). See the Meta webhook's original comment (issue #363) for
  // why that distinction matters; preserved verbatim here.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound-pipeline] Error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[inbound-pipeline] Error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video',
  'location', 'template', 'interactive',
])

export interface ResolvedThread {
  contactRecord: ContactRow
  wasContactCreated: boolean
  conversation: ContactRow
}

/**
 * Resolve (or create) the contact + conversation for an inbound event
 * and dispatch `conversation.created` when the thread is brand new.
 * Shared by every provider's webhook route — called once per inbound
 * event, BEFORE branching on message-vs-reaction (Meta) or going
 * straight to {@link finishProcessingInboundMessage} (every provider).
 */
export async function resolveInboundThread(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  fromPhone: string,
  contactName: string,
): Promise<ResolvedThread | null> {
  const contactOutcome = await findOrCreateContact(db, accountId, configOwnerUserId, fromPhone, contactName)
  if (!contactOutcome) return null

  const convResult = await findOrCreateConversation(db, accountId, configOwnerUserId, contactOutcome.contact.id)
  if (!convResult) return null

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: convResult.conversation.id,
      contact_id: contactOutcome.contact.id,
    })
  }

  return {
    contactRecord: contactOutcome.contact,
    wasContactCreated: contactOutcome.wasCreated,
    conversation: convResult.conversation,
  }
}

/**
 * The shared core: given an already-normalized inbound message (the
 * provider-specific webhook route has already verified the request,
 * parsed its payload, and resolved any media to a durable URL) and an
 * already-{@link resolveInboundThread}d contact/conversation, run the
 * exact same idempotent-insert/dedup/dispatch pipeline every provider
 * shares — unread bump, flows, automations, AI auto-reply, and the
 * outbound webhook.
 *
 * Mirrors `processMessage` from the original (Meta-only)
 * src/app/api/whatsapp/webhook/route.ts move-for-move — see that
 * file's git history for the issue numbers behind each guard
 * (idempotency #367, race conditions #369/#363, reopen #409, etc).
 */
export async function finishProcessingInboundMessage(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  thread: ResolvedThread,
  msg: NormalizedInboundMessage,
): Promise<void> {
  const { contactRecord, wasContactCreated, conversation } = thread

  let replyToInternalId: string | null = null
  if (msg.replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByProviderMessageId(
      db,
      msg.replyToProviderMessageId,
      conversation.id,
    )
    if (!replyToInternalId) {
      console.warn(
        '[inbound-pipeline] reply context parent not found:',
        msg.replyToProviderMessageId,
      )
    }
  }

  const contentType = ALLOWED_CONTENT_TYPES.has(msg.contentType) ? msg.contentType : 'text'

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  // Idempotent insert — a provider retrying webhook delivery replays
  // the exact same message id. The unique index on
  // (conversation_id, message_id) makes a replay conflict;
  // ignoreDuplicates turns that into ON CONFLICT DO NOTHING, and the
  // .select() then returns the inserted row ONLY on a genuine first
  // insert. This is the single idempotency boundary that must sit
  // BEFORE the unread bump and all downstream fan-out below.
  const { data: insertedRows, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: msg.contentText,
        media_url: msg.mediaUrl,
        media_type: msg.mediaType,
        message_id: msg.providerMessageId,
        status: 'delivered',
        created_at: new Date(msg.timestampMs).toISOString(),
        reply_to_message_id: replyToInternalId,
        interactive_reply_id: msg.interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (msgError) {
    console.error('[inbound-pipeline] Error inserting message:', msgError)
    return
  }

  if (!insertedRows || insertedRows.length === 0) {
    console.info(
      '[inbound-pipeline] duplicate inbound message ignored (idempotent replay):',
      msg.providerMessageId,
    )
    return
  }

  // Unread bump + last-message summary done DB-side (bump_conversation_on_inbound)
  // rather than a read-modify-write — concurrent inbound messages for
  // the same conversation must not lose an increment (issue #369).
  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: msg.contentText || `[${msg.rawTypeLabel ?? msg.contentType}]`,
  })
  if (convError) {
    console.error('[inbound-pipeline] Error updating conversation:', convError)
  }

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(db, conversation)

  await flagBroadcastReplyIfAny(db, accountId, contactRecord.id)

  // System-default STOP keyword — always on, provider-independent, not
  // dependent on the account having configured any automation. Runs
  // before flows/automations dispatch so opt-out takes effect even on
  // an account with zero automations configured.
  await applyStopKeywordIfMatched(db, accountId, contactRecord.id, msg.contentText)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      msg.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: msg.interactiveReplyId,
            reply_title: msg.contentText ?? '',
            meta_message_id: msg.providerMessageId,
          }
        : {
            kind: 'text',
            text: msg.contentText ?? '',
            meta_message_id: msg.providerMessageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = msg.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (msg.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (wasContactCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: msg.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[inbound-pipeline] automations dispatch failed:', err))
  }

  if (!flowConsumed && !msg.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: msg.providerMessageId,
    content_type: contentType,
    text: msg.contentText,
  })
}
