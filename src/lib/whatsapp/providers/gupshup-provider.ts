/**
 * Gupshup WhatsApp Business API provider adapter — implements the same
 * `WhatsAppProvider` interface the Meta adapter does, so every existing
 * call site (send-message.ts, broadcast-core.ts, automations/meta-send.ts,
 * flows/meta-send.ts, the broadcast route, the template routes) works
 * unmodified once it goes through `resolveWhatsAppProvider()` instead of
 * importing `meta-api.ts` directly.
 *
 * Endpoint/payload shapes here come from Gupshup's official docs — see
 * `gupshup-client.ts`'s header comment for the exact pages used.
 */

import type { MessageTemplate } from '@/types'
import {
  getBusinessDetails,
  listTemplates as listGupshupTemplates,
  sendSessionMessage,
  sendTemplateMessage as sendGupshupTemplateMessage,
  type GupshupCredentials,
} from './gupshup-client'
import {
  normalizeGupshupTemplateStatus,
} from './gupshup-status-map'
import type {
  ConnectionStatus,
  NormalizedTemplate,
  SendInteractiveArgs,
  SendMediaArgs,
  SendResult,
  SendTemplateArgs,
  SendTextArgs,
  WhatsAppProvider,
} from './types'
import { ProviderError } from './types'

export type GupshupProviderConfig = GupshupCredentials

function normalizeCategory(raw: string): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = (raw ?? '').toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

/** Extract the Gupshup template id a send needs to reference off the local row. */
function requireGupshupTemplateId(template: MessageTemplate | undefined, templateName: string): string {
  const id = template?.gupshup_template_id
  if (!id) {
    throw new ProviderError(
      'gupshup',
      'invalid_template',
      `Template "${templateName}" has no Gupshup template id — run "Sync from Gupshup" in Settings first.`,
    )
  }
  return id
}

/** Build the optional `message` object Gupshup wants for a media-header template. */
function buildTemplateMediaMessage(
  template: MessageTemplate | undefined,
  headerMediaUrlOverride: string | undefined,
): Record<string, unknown> | undefined {
  const headerType = template?.header_type
  if (headerType !== 'image' && headerType !== 'video' && headerType !== 'document') {
    return undefined
  }
  const link = headerMediaUrlOverride ?? template?.header_media_url ?? undefined
  if (!link) return undefined
  if (headerType === 'image') return { type: 'image', image: { link } }
  if (headerType === 'video') return { type: 'video', video: { link } }
  return { type: 'file', file: { link } }
}

export function createGupshupProvider(config: GupshupProviderConfig): WhatsAppProvider {
  const creds: GupshupCredentials = config

  return {
    id: 'gupshup',

    async testConnection(): Promise<ConnectionStatus> {
      try {
        const business = await getBusinessDetails(creds)
        return { connected: true, details: { ...business } }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Gupshup API error'
        return { connected: false, reason: 'gupshup_api_error', message }
      }
    },

    async sendText(args: SendTextArgs): Promise<SendResult> {
      const message: Record<string, unknown> = { type: 'text', text: args.text, previewUrl: true }
      if (args.contextMessageId) message.context = { msgId: args.contextMessageId }
      return sendSessionMessage(creds, message, args.to)
    },

    async sendMedia(args: SendMediaArgs): Promise<SendResult> {
      let message: Record<string, unknown>
      switch (args.kind) {
        case 'image':
          message = { type: 'image', originalUrl: args.link, previewUrl: args.link }
          if (args.caption) message.caption = args.caption
          break
        case 'video':
          message = { type: 'video', url: args.link, previewUrl: args.link }
          if (args.caption) message.caption = args.caption
          break
        case 'document':
          message = { type: 'file', url: args.link }
          if (args.filename) message.filename = args.filename
          if (args.caption) message.caption = args.caption
          break
        case 'audio':
          // Gupshup's audio message accepts neither caption nor filename,
          // mirroring Meta's own audio restriction (meta-api.ts).
          message = { type: 'audio', url: args.link }
          break
      }
      if (args.contextMessageId) message.context = { msgId: args.contextMessageId }
      return sendSessionMessage(creds, message, args.to)
    },

    async sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
      const templateId = requireGupshupTemplateId(args.template, args.templateName)
      const params = args.messageParams?.body ?? args.params ?? []
      const mediaMessage = buildTemplateMediaMessage(args.template, args.messageParams?.headerMediaUrl)
      return sendGupshupTemplateMessage(creds, {
        to: args.to,
        templateId,
        params,
        mediaMessage,
      })
    },

    async sendInteractive(args: SendInteractiveArgs): Promise<SendResult> {
      const { payload } = args
      let message: Record<string, unknown>
      if (payload.kind === 'buttons') {
        // Gupshup caps quick-reply options at 3, same as Meta's button
        // cap — the shared validators in meta-api.ts already enforce
        // this before either provider is reached.
        message = {
          type: 'quick_reply',
          content: { type: 'text', text: payload.bodyText },
          options: payload.buttons.map((b) => ({ title: b.title, postbackText: b.id })),
        }
      } else {
        message = {
          type: 'list',
          title: payload.headerText || payload.bodyText.slice(0, 60),
          body: payload.bodyText,
          globalButtons: [{ type: 'text', title: payload.buttonLabel }],
          items: payload.sections.map((s) => ({
            title: s.title ?? '',
            options: s.rows.map((r) => ({
              type: 'text',
              title: r.title,
              description: r.description ?? '',
              postbackText: r.id,
            })),
          })),
        }
      }
      if (args.contextMessageId) message.context = { msgId: args.contextMessageId }
      return sendSessionMessage(creds, message, args.to)
    },

    async listTemplates(): Promise<{ templates: NormalizedTemplate[]; truncated: boolean }> {
      const items = await listGupshupTemplates(creds)
      const templates = items.map((t) => ({
        name: t.elementName,
        language: t.languageCode,
        category: normalizeCategory(t.category),
        status: normalizeGupshupTemplateStatus(t.status),
        // Gupshup's template list is flatter than Meta's — it returns
        // rendered `data` (the body with {{n}} placeholders) but not a
        // structured components array, so header/footer/buttons aren't
        // recoverable from this endpoint. Documented limitation — see
        // docs/GUPSHUP_INTEGRATION.md.
        headerType: null,
        headerContent: null,
        bodyText: t.data ?? '',
        footerText: null,
        buttons: null,
        qualityScore:
          t.quality?.toUpperCase() === 'GREEN' ||
          t.quality?.toUpperCase() === 'YELLOW' ||
          t.quality?.toUpperCase() === 'RED'
            ? (t.quality.toUpperCase() as 'GREEN' | 'YELLOW' | 'RED')
            : null,
        providerTemplateId: t.id,
      }))
      // Gupshup's list endpoint is not paginated in this integration
      // (no pageNo/pageSize looping) — see docs/GUPSHUP_INTEGRATION.md
      // for the follow-up if an account's catalog exceeds one page.
      return { templates, truncated: false }
    },

    // submitTemplate / editTemplate / deleteTemplate intentionally
    // absent — Gupshup template creation/edit/delete via API is not
    // implemented in this integration (documented limitation). Callers
    // must check `typeof provider.submitTemplate === 'function'` before
    // calling and surface a clear "not supported for Gupshup" message —
    // see the templates/submit and templates/[id] routes.
  }
}
