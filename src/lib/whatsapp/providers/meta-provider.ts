/**
 * Meta Cloud API provider adapter.
 *
 * Zero behavior change from before the provider layer existed — this
 * is a thin wrapper that closes over `phoneNumberId` + a decrypted
 * `accessToken` and forwards every call straight into the existing,
 * battle-tested `meta-api.ts` functions. Every existing Meta call site
 * (send-message.ts, broadcast-core.ts, automations/meta-send.ts,
 * flows/meta-send.ts, the broadcast route) is switching to call
 * through this adapter instead of importing `meta-api.ts` directly,
 * but the wire behavior against Meta's API is byte-for-byte identical.
 */

import {
  verifyPhoneNumber,
  registerPhoneNumber,
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
  submitMessageTemplate,
  editMessageTemplate,
  deleteMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import type { MetaTemplateSubmitPayload } from '@/lib/whatsapp/template-components'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
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

export interface MetaProviderConfig {
  phoneNumberId: string
  wabaId: string | null
  accessToken: string
}

function wrapMetaError(err: unknown): never {
  const message = err instanceof Error ? err.message : 'Unknown Meta API error'
  const status = /\b429\b/.test(message)
    ? 429
    : /\b401\b|authoriz|access token/i.test(message)
      ? 401
      : undefined
  const code =
    status === 429
      ? 'rate_limited'
      : status === 401
        ? 'auth_error'
        : /recipient|phone|131030|not in allowed list/i.test(message)
          ? 'invalid_recipient'
          : /template/i.test(message)
            ? 'invalid_template'
            : 'unknown_provider_error'
  throw new ProviderError('meta', code, message, status)
}

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaTemplateListButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}

interface MetaTemplateListComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaTemplateListButton[]
}

interface MetaTemplateListItem {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateListComponent[]
  quality_score?: { score?: string } | string
}

function normalizeCategory(meta: string): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(
  raw: MetaTemplateListItem['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score = typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED' ? upper : null
}

export function createMetaProvider(config: MetaProviderConfig): WhatsAppProvider {
  const { phoneNumberId, wabaId, accessToken } = config

  return {
    id: 'meta',

    async testConnection(): Promise<ConnectionStatus> {
      try {
        const info = await verifyPhoneNumber({ phoneNumberId, accessToken })
        return { connected: true, details: { ...info } }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Meta API error'
        return { connected: false, reason: 'meta_api_error', message }
      }
    },

    async sendText(args: SendTextArgs): Promise<SendResult> {
      try {
        return await sendTextMessage({
          phoneNumberId,
          accessToken,
          to: args.to,
          text: args.text,
          contextMessageId: args.contextMessageId,
        })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async sendMedia(args: SendMediaArgs): Promise<SendResult> {
      try {
        return await sendMediaMessage({
          phoneNumberId,
          accessToken,
          to: args.to,
          kind: args.kind,
          link: args.link,
          caption: args.caption,
          filename: args.filename,
          contextMessageId: args.contextMessageId,
        })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
      try {
        return await sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to: args.to,
          templateName: args.templateName,
          language: args.language,
          params: args.params,
          template: args.template,
          messageParams: args.messageParams,
          contextMessageId: args.contextMessageId,
        })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async sendInteractive(args: SendInteractiveArgs): Promise<SendResult> {
      try {
        const { payload } = args
        if (payload.kind === 'buttons') {
          return await sendInteractiveButtons({
            phoneNumberId,
            accessToken,
            to: args.to,
            bodyText: payload.bodyText,
            headerText: payload.headerText,
            footerText: payload.footerText,
            buttons: payload.buttons,
            contextMessageId: args.contextMessageId,
          })
        }
        return await sendInteractiveList({
          phoneNumberId,
          accessToken,
          to: args.to,
          bodyText: payload.bodyText,
          buttonLabel: payload.buttonLabel,
          headerText: payload.headerText,
          footerText: payload.footerText,
          sections: payload.sections,
          contextMessageId: args.contextMessageId,
        })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async listTemplates(): Promise<{ templates: NormalizedTemplate[]; truncated: boolean }> {
      if (!wabaId) {
        throw new ProviderError(
          'meta',
          'not_supported',
          'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        )
      }
      const out: NormalizedTemplate[] = []
      let nextUrl: string | null =
        `${META_API_BASE}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`
      const PAGE_CAP = 20
      let pageCount = 0

      while (nextUrl && pageCount < PAGE_CAP) {
        pageCount++
        const res = await fetch(nextUrl, { headers: { Authorization: `Bearer ${accessToken}` } })
        if (!res.ok) {
          let message = `Meta API error: ${res.status}`
          try {
            const body = await res.json()
            if (body?.error?.message) message = body.error.message
          } catch {
            /* keep fallback */
          }
          wrapMetaError(new Error(message))
        }
        const body: { data?: MetaTemplateListItem[]; paging?: { next?: string } } =
          await res.json()

        for (const t of body.data ?? []) {
          const header = (t.components ?? []).find((c) => c.type === 'HEADER')
          const bodyComp = (t.components ?? []).find((c) => c.type === 'BODY')
          const footer = (t.components ?? []).find((c) => c.type === 'FOOTER')
          const buttonsComp = (t.components ?? []).find((c) => c.type === 'BUTTONS')
          const headerFormat = header?.format?.toUpperCase()
          const headerType =
            headerFormat === 'TEXT' ||
            headerFormat === 'IMAGE' ||
            headerFormat === 'VIDEO' ||
            headerFormat === 'DOCUMENT'
              ? (headerFormat.toLowerCase() as 'text' | 'image' | 'video' | 'document')
              : null

          out.push({
            name: t.name,
            language: t.language,
            category: normalizeCategory(t.category),
            status: normalizeStatus(t.status),
            headerType,
            headerContent: header?.text ?? null,
            bodyText: bodyComp?.text ?? '',
            footerText: footer?.text ?? null,
            buttons: buttonsComp?.buttons?.length ? buttonsComp.buttons : null,
            qualityScore: normalizeQualityScore(t.quality_score),
            providerTemplateId: t.id,
          })
        }
        nextUrl = body.paging?.next ?? null
      }
      return { templates: out, truncated: pageCount >= PAGE_CAP && nextUrl !== null }
    },

    async submitTemplate(payload: unknown) {
      if (!wabaId) {
        throw new ProviderError('meta', 'not_supported', 'WABA ID missing.')
      }
      try {
        return await submitMessageTemplate({
          wabaId,
          accessToken,
          payload: payload as MetaTemplateSubmitPayload,
        })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async editTemplate(templateId: string, payload: unknown) {
      try {
        await editMessageTemplate({
          metaTemplateId: templateId,
          accessToken,
          components: (payload as MetaTemplateSubmitPayload).components,
          category: (payload as MetaTemplateSubmitPayload).category,
        })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async deleteTemplate(templateId: string, name: string) {
      if (!wabaId) {
        throw new ProviderError('meta', 'not_supported', 'WABA ID missing.')
      }
      try {
        await deleteMessageTemplate({ wabaId, accessToken, name, metaTemplateId: templateId })
      } catch (err) {
        wrapMetaError(err)
      }
    },

    async register(pin: string) {
      try {
        await registerPhoneNumber({ phoneNumberId, accessToken, pin })
      } catch (err) {
        wrapMetaError(err)
      }
    },
  }
}
