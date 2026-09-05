/**
 * Normalize Gupshup's message-event (`type`) and template-status
 * vocabularies into WACRM's existing internal vocabularies, so the
 * shared inbound pipeline / template sync never need to know which
 * provider produced an event.
 *
 * Source: https://docs.gupshup.io/docs/message-events (V2 message-event
 * callback) and https://docs.gupshup.io/docs/message-template-approvals-statuses
 * — fetched and quoted in docs/GUPSHUP_INTEGRATION.md.
 */

import type { MessageTemplateStatus } from '@/types'

/**
 * Gupshup's V2 message-event `payload.type` values. `enqueued` has no
 * Meta/WACRM equivalent event — it fires before the message actually
 * leaves Gupshup, so it maps to the pre-send `pending` state (a same-
 * or-backward move on the ladder, which `isValidStatusTransition` in
 * the webhook route already no-ops). `deleted` has no slot in the
 * `messages.status` / `broadcast_recipients.status` CHECK constraints
 * at all — logged as `unsupported_provider_event` and dropped rather
 * than crashing the webhook.
 */
export type GupshupMessageEventType =
  | 'enqueued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'deleted'

/** The subset of WACRM's status ladder a delivery-status webhook can produce. */
export type NormalizedDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null

export function normalizeGupshupMessageEventType(
  raw: string,
): NormalizedDeliveryStatus {
  switch (raw as GupshupMessageEventType) {
    case 'enqueued':
      return 'pending'
    case 'sent':
      return 'sent'
    case 'delivered':
      return 'delivered'
    case 'read':
      return 'read'
    case 'failed':
      return 'failed'
    default:
      // 'deleted', or anything Gupshup adds later — caller logs
      // `unsupported_provider_event` and skips the DB write.
      return null
  }
}

/**
 * Gupshup's template review statuses (docs/message-template-approvals-statuses):
 * Submitted, Approved, Rejected, Paused, Failed, Deactivated. The
 * "Get all templates" list endpoint returns them uppercase
 * (e.g. "APPROVED") per its own query-param examples — normalize
 * case-insensitively and cover both the human-readable doc spelling
 * and the API's own casing.
 *
 * Mapped onto the *same* `MessageTemplateStatus` enum Meta templates
 * use (see supabase/migrations/014_message_templates_meta_integration.sql)
 * so the rest of the app (edit/resubmit/delete gating, the templates
 * UI) doesn't need a second status vocabulary — it already treats
 * PAUSED as recoverable and REJECTED/DISABLED as terminal, which is
 * exactly the distinction Gupshup's own statuses draw.
 */
export function normalizeGupshupTemplateStatus(raw: string): MessageTemplateStatus {
  const upper = (raw ?? '').toUpperCase()
  switch (upper) {
    case 'SUBMITTED':
    case 'PENDING':
    case 'PENDING_REVIEW':
      return 'PENDING'
    case 'APPROVED':
      return 'APPROVED'
    case 'REJECTED':
      // Gupshup's own "Failed" (failed at Gupshup's end, distinct from
      // Meta rejecting the content) has no closer terminal-negative slot
      // in the shared enum than REJECTED — surfaced to the user the same
      // way a content rejection would be.
      return 'REJECTED'
    case 'FAILED':
      return 'REJECTED'
    case 'PAUSED':
      return 'PAUSED'
    case 'DEACTIVATED':
      return 'DISABLED'
    default:
      return 'PENDING'
  }
}
