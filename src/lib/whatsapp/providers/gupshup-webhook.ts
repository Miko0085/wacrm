/**
 * Gupshup inbound webhook payload parsing.
 *
 * The V2 callback envelope (`{app, timestamp, version, type, payload}`)
 * and the exact shapes for `type: "message-event"` (delivery status)
 * and `type: "user-event"` (opt-in/opt-out) are confirmed against
 * Gupshup's official docs — see docs/GUPSHUP_INTEGRATION.md for the
 * exact pages and quoted examples.
 *
 * `type: "message"` (inbound customer message) is confirmed at the
 * envelope level (payload.id / payload.source / payload.type /
 * payload.sender / payload.context), but Gupshup's public docs do not
 * publish a field-by-field breakdown of `payload.payload` per message
 * type (image/video/file/audio/location/button_reply/list_reply) the
 * way they do for outbound sends. The mapping below is a best-effort
 * reading of Gupshup's conventions elsewhere in their API (the same
 * field names — `url`, `caption`, `filename` — used on the outbound
 * media send endpoints), NOT independently confirmed against a live
 * payload. This is flagged as the #1 thing to verify against a real
 * Gupshup sandbox delivery during E2E testing (see
 * docs/GUPSHUP_TEST_REPORT.md) and adjust here if field names differ.
 */

import type {
  NormalizedContentType,
  NormalizedInboundMessage,
  NormalizedStatusEvent,
} from '@/lib/whatsapp/inbound-pipeline'
import { normalizeGupshupMessageEventType } from './gupshup-status-map'

export interface GupshupWebhookEnvelope {
  app?: string
  timestamp?: number
  version?: number
  type?: string
  payload?: Record<string, unknown>
}

export function isValidGupshupEnvelope(body: unknown): body is GupshupWebhookEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as GupshupWebhookEnvelope).type === 'string' &&
    typeof (body as GupshupWebhookEnvelope).payload === 'object'
  )
}

interface GupshupSender {
  phone?: string
  name?: string
}

interface GupshupInboundMessagePayload {
  id?: string
  source?: string
  type?: string
  payload?: Record<string, unknown>
  sender?: GupshupSender
  context?: { id?: string; gsId?: string }
}

const CONTENT_TYPE_MAP: Record<string, NormalizedContentType> = {
  text: 'text',
  image: 'image',
  file: 'document',
  audio: 'audio',
  video: 'video',
  location: 'location',
  button_reply: 'interactive',
  list_reply: 'interactive',
}

/**
 * Normalize a Gupshup `type: "message"` event into the shared inbound
 * shape. Returns null for a type we don't recognize at all (logged by
 * the caller as `unsupported_provider_event`, never silently dropped
 * per requirement #20 — see the webhook route).
 */
export function normalizeGupshupInboundMessage(
  envelope: GupshupWebhookEnvelope,
): NormalizedInboundMessage | null {
  const msg = envelope.payload as GupshupInboundMessagePayload
  if (!msg?.id || !msg.source || !msg.type) return null

  const contentType = CONTENT_TYPE_MAP[msg.type]
  if (!contentType) return null

  const inner = msg.payload ?? {}
  const timestampMs =
    typeof envelope.timestamp === 'number' ? envelope.timestamp : Date.now()

  let contentText: string | null = null
  let mediaUrl: string | null = null
  let mediaType: string | null = null
  let interactiveReplyId: string | null = null

  switch (msg.type) {
    case 'text':
      contentText = typeof inner.text === 'string' ? inner.text : null
      break
    case 'image':
    case 'video':
      contentText = typeof inner.caption === 'string' ? inner.caption : null
      mediaUrl = typeof inner.url === 'string' ? inner.url : null
      mediaType = typeof inner.contentType === 'string' ? inner.contentType : null
      break
    case 'file':
      contentText =
        (typeof inner.caption === 'string' && inner.caption) ||
        (typeof inner.filename === 'string' && inner.filename) ||
        null
      mediaUrl = typeof inner.url === 'string' ? inner.url : null
      mediaType = typeof inner.contentType === 'string' ? inner.contentType : null
      break
    case 'audio':
      mediaUrl = typeof inner.url === 'string' ? inner.url : null
      mediaType = typeof inner.contentType === 'string' ? inner.contentType : null
      break
    case 'location': {
      const lat = inner.latitude
      const lon = inner.longitude
      const name = typeof inner.name === 'string' ? inner.name : null
      const address = typeof inner.address === 'string' ? inner.address : null
      contentText = [name, address, lat != null && lon != null ? `${lat},${lon}` : null]
        .filter(Boolean)
        .join(' - ') || null
      break
    }
    case 'button_reply':
    case 'list_reply': {
      const id = typeof inner.id === 'string' ? inner.id : null
      const title = typeof inner.title === 'string' ? inner.title : null
      interactiveReplyId = id
      contentText = title || id
      break
    }
  }

  return {
    providerMessageId: msg.id,
    fromPhone: msg.source,
    contactName: msg.sender?.name || msg.source,
    timestampMs,
    contentType,
    rawTypeLabel: msg.type,
    contentText,
    mediaUrl,
    mediaType,
    interactiveReplyId,
    replyToProviderMessageId: msg.context?.id ?? msg.context?.gsId ?? null,
  }
}

interface GupshupMessageEventPayload {
  id?: string
  gsId?: string
  type?: string
  payload?: { ts?: number }
}

/**
 * Normalize a Gupshup `type: "message-event"` (delivery status)
 * callback into the shared status event. Returns null for a status we
 * don't map onto WACRM's ladder (e.g. `deleted`) — caller logs
 * `unsupported_provider_event` and skips the DB write.
 *
 * Per `id`/`gsId` semantics from Gupshup's docs: for enqueued/failed
 * events `id` IS the Gupshup message id; for sent/delivered/read DLR
 * events, `id` is the WhatsApp message id and `gsId` is the Gupshup id.
 * We always correlate on `id` because that's what we stored as
 * `messages.message_id` / `broadcast_recipients.whatsapp_message_id`
 * at send time (`sendSessionMessage`/`sendTemplateMessage` return
 * Gupshup's own `messageId`, which IS the same `gsId`/enqueued-`id`
 * value) — see gupshup-client.ts.
 */
export function normalizeGupshupStatusEvent(
  envelope: GupshupWebhookEnvelope,
): NormalizedStatusEvent | null {
  const event = envelope.payload as GupshupMessageEventPayload
  const rawType = event?.type
  const providerMessageId = event?.gsId || event?.id
  if (!rawType || !providerMessageId) return null

  const status = normalizeGupshupMessageEventType(rawType)
  if (!status) return null

  const timestampMs =
    typeof event.payload?.ts === 'number'
      ? event.payload.ts * 1000
      : typeof envelope.timestamp === 'number'
        ? envelope.timestamp
        : Date.now()

  return { providerMessageId, status, timestampMs }
}

export interface GupshupUserEvent {
  phone: string
  type: 'opted-in' | 'opted-out'
}

/** Normalize a Gupshup `type: "user-event"` callback. */
export function normalizeGupshupUserEvent(
  envelope: GupshupWebhookEnvelope,
): GupshupUserEvent | null {
  const payload = envelope.payload as { phone?: string; type?: string }
  if (!payload?.phone || (payload.type !== 'opted-in' && payload.type !== 'opted-out')) {
    return null
  }
  return { phone: payload.phone, type: payload.type }
}
