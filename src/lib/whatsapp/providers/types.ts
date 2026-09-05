/**
 * WhatsApp Provider Layer — the abstraction boundary between "WACRM
 * business logic" and "which WhatsApp API we're actually talking to".
 *
 * Every call site that used to import from `@/lib/whatsapp/meta-api`
 * directly (send-message.ts, broadcast-core.ts, automations/meta-send.ts,
 * flows/meta-send.ts, the broadcast route, the config route, the
 * template routes) now calls `resolveWhatsAppProvider(config)` and gets
 * back an object implementing this interface. Meta and Gupshup are the
 * two implementations; a third provider is "add another file that
 * implements this interface, teach the resolver about it" — no call
 * site changes.
 *
 * Design notes:
 *   - `SendResult` deliberately keeps the shape `{ messageId }` that
 *     `meta-api.ts`'s `MetaSendResult` already used everywhere — every
 *     existing caller destructures `.messageId`, and the public API's
 *     `whatsapp_message_id` field / `broadcast_recipients.whatsapp_message_id`
 *     column are the provider's message id under a Meta-flavored name
 *     kept for backward compatibility (see docs/GUPSHUP_INTEGRATION_AUDIT.md §9).
 *   - Methods that are genuinely Meta-only (phone `register`, WABA
 *     `subscribed_apps`) are optional on the interface rather than
 *     forcing Gupshup to implement a no-op — callers check for
 *     presence instead.
 *   - Inbound normalization is intentionally NOT part of this
 *     interface. Verifying + parsing a webhook body is per-provider
 *     (different transport, different envelope, different — or
 *     absent — signature scheme) and lives in each provider's own
 *     `webhook.ts`, dispatched by the route that owns that provider's
 *     URL. The *processing* of a normalized event (contact/conversation
 *     resolution, dedup, status ladder, fan-out to flows/automations/
 *     AI/webhooks) is shared and lives in `inbound-pipeline.ts`.
 */

import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import type { InteractiveButton, InteractiveListSection } from '@/lib/whatsapp/meta-api'

export type WhatsAppProviderId = 'meta' | 'gupshup'

export interface SendResult {
  /** The provider's own message id (Meta's wamid, Gupshup's messageId). */
  messageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  /** Provider's id of the message being replied to, for a quote/context. */
  contextMessageId?: string
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  /** Publicly-fetchable URL for the attachment. */
  link: string
  caption?: string
  /** Document only. */
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  /** Legacy positional body params. */
  params?: string[]
  /** Local template row — used to build header/button components. */
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export type InteractivePayload =
  | {
      kind: 'buttons'
      bodyText: string
      headerText?: string
      footerText?: string
      buttons: InteractiveButton[]
    }
  | {
      kind: 'list'
      bodyText: string
      buttonLabel: string
      headerText?: string
      footerText?: string
      sections: InteractiveListSection[]
    }

export interface SendInteractiveArgs {
  to: string
  payload: InteractivePayload
  contextMessageId?: string
}

/** Provider-independent connection health, surfaced in Settings. */
export interface ConnectionStatus {
  connected: boolean
  /** Short machine-readable reason, mirrors the existing `/api/whatsapp/config` GET shape. */
  reason?: string
  message?: string
  /** Freeform provider details (phone info for Meta, business info for Gupshup) — never secrets. */
  details?: Record<string, unknown>
}

/** Normalized template row shape returned by `listTemplates()`, before it's upserted into `message_templates`. */
export interface NormalizedTemplate {
  name: string
  language: string
  category: 'Marketing' | 'Utility' | 'Authentication'
  status: string // MessageTemplateStatus, kept as string here to avoid a circular import
  headerType: 'text' | 'image' | 'video' | 'document' | null
  headerContent: string | null
  bodyText: string
  footerText: string | null
  buttons: unknown | null
  qualityScore: 'GREEN' | 'YELLOW' | 'RED' | null
  /** The provider's own template id — persisted as `meta_template_id` or `gupshup_template_id`. */
  providerTemplateId: string
}

/**
 * Errors every provider call site is expected to raise as. Callers
 * (routes) map `.code` to their own HTTP status / user-facing copy.
 * Deliberately provider-independent — a route never needs to know
 * whether `code: 'auth_error'` came from Meta or Gupshup.
 */
export type ProviderErrorCode =
  | 'auth_error'
  | 'rate_limited'
  | 'invalid_template'
  | 'invalid_recipient'
  | 'provider_unavailable'
  | 'media_error'
  | 'not_supported'
  | 'unknown_provider_error'

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly provider: WhatsAppProviderId
  /** Raw upstream status code, if any — for logs only, never shown to end users. */
  readonly httpStatus?: number

  constructor(
    provider: WhatsAppProviderId,
    code: ProviderErrorCode,
    message: string,
    httpStatus?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.code = code
    this.httpStatus = httpStatus
  }

  /** Whether a retry (bounded, exponential backoff) is worth attempting. */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'provider_unavailable'
  }
}

export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId

  /** Real server-side credential check — never "fields are non-empty". */
  testConnection(): Promise<ConnectionStatus>

  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendInteractive(args: SendInteractiveArgs): Promise<SendResult>

  /**
   * Pull the current template catalog for sync into `message_templates`.
   * `truncated` is true when the provider has more templates than this
   * call fetched (a page-count safety cap, not a per-request limit) —
   * the sync route surfaces it so the user knows to re-run sync/narrow
   * their catalog rather than silently seeing a partial list.
   */
  listTemplates(): Promise<{ templates: NormalizedTemplate[]; truncated: boolean }>

  /**
   * Template lifecycle management. Optional: Gupshup template
   * creation/edit/delete is not implemented in this integration (see
   * docs/GUPSHUP_INTEGRATION.md — limitations) — callers must check
   * for presence and return a clear "not supported for this provider"
   * error rather than assuming every provider can do this.
   */
  submitTemplate?(payload: unknown): Promise<{ id: string; status: string }>
  editTemplate?(templateId: string, payload: unknown): Promise<void>
  deleteTemplate?(templateId: string, name: string): Promise<void>

  /** Meta-only phone registration step. Absent on Gupshup. */
  register?(pin: string): Promise<void>
}
