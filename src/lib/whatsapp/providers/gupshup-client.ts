/**
 * Gupshup WhatsApp Business API — raw HTTP client.
 *
 * Every endpoint here is taken from Gupshup's official docs
 * (docs.gupshup.io), fetched and verified while building this
 * integration — not guessed, not copied from a forum post. See
 * docs/GUPSHUP_INTEGRATION.md for the source pages.
 *
 *   POST /wa/api/v1/msg            — session/free-form messages (text, media, interactive)
 *   POST /wa/api/v1/template/msg   — template messages
 *   GET  /wa/app/{app_id}/template — list templates for the app
 *   GET  /wa/app/{app_id}/business — business/account details (used as the connection test)
 *
 * All POSTs are `application/x-www-form-urlencoded` with an `apikey`
 * header — Gupshup does not use Bearer/OAuth tokens like Meta.
 */

import { ProviderError } from './types'

const GUPSHUP_API_BASE = 'https://api.gupshup.io/wa'

export interface GupshupCredentials {
  apiKey: string
  appId: string
  appName: string
  /** Digits-only source WhatsApp number (the number Gupshup sends "from"). */
  sourceNumber: string
}

interface GupshupErrorBody {
  status?: string
  message?: string
  error?: { message?: string } | string
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as GupshupErrorBody
    if (typeof body.error === 'string') return body.error
    if (body.error?.message) return body.error.message
    if (body.message) return body.message
  } catch {
    // non-JSON body — fall through to the status-line fallback
  }
  return `Gupshup API error: ${res.status}`
}

function codeForStatus(status: number, message: string): ProviderError['code'] {
  if (status === 401 || status === 403) return 'auth_error'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'provider_unavailable'
  if (/template/i.test(message)) return 'invalid_template'
  if (/destination|recipient|phone/i.test(message)) return 'invalid_recipient'
  return 'unknown_provider_error'
}

async function throwGupshupError(res: Response): Promise<never> {
  const message = await parseErrorMessage(res)
  throw new ProviderError('gupshup', codeForStatus(res.status, message), message, res.status)
}

export interface GupshupSendResult {
  messageId: string
}

/**
 * POST /wa/api/v1/msg — session (free-form) message.
 * `message` is the provider-specific payload object for this message
 * type (text / image / video / file / audio / quick_reply / list) —
 * callers in gupshup-provider.ts build it per Gupshup's documented
 * shape for each type.
 */
export async function sendSessionMessage(
  creds: GupshupCredentials,
  message: Record<string, unknown>,
  to: string,
): Promise<GupshupSendResult> {
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: creds.sourceNumber,
    destination: to,
    'src.name': creds.appName,
    message: JSON.stringify(message),
  })
  const res = await fetch(`${GUPSHUP_API_BASE}/api/v1/msg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: creds.apiKey,
    },
    body: body.toString(),
  })
  if (!res.ok) await throwGupshupError(res)
  const data = (await res.json()) as { messageId?: string; status?: string }
  if (!data.messageId) {
    throw new ProviderError('gupshup', 'unknown_provider_error', 'Gupshup accepted the send but returned no messageId.')
  }
  return { messageId: data.messageId }
}

export interface GupshupTemplateSendArgs {
  to: string
  templateId: string
  params: string[]
  /** Set for a template whose HEADER is image/video/document. */
  mediaMessage?: Record<string, unknown>
}

/** POST /wa/api/v1/template/msg — template message. */
export async function sendTemplateMessage(
  creds: GupshupCredentials,
  args: GupshupTemplateSendArgs,
): Promise<GupshupSendResult> {
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: creds.sourceNumber,
    destination: args.to,
    'src.name': creds.appName,
    template: JSON.stringify({ id: args.templateId, params: args.params }),
  })
  if (args.mediaMessage) {
    body.set('message', JSON.stringify(args.mediaMessage))
  }
  const res = await fetch(`${GUPSHUP_API_BASE}/api/v1/template/msg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: creds.apiKey,
    },
    body: body.toString(),
  })
  if (!res.ok) await throwGupshupError(res)
  const data = (await res.json()) as { messageId?: string; status?: string }
  if (!data.messageId) {
    throw new ProviderError('gupshup', 'unknown_provider_error', 'Gupshup accepted the template send but returned no messageId.')
  }
  return { messageId: data.messageId }
}

export interface GupshupTemplateListItem {
  id: string
  elementName: string
  status: string
  category: string
  languageCode: string
  templateType: string
  data: string
  quality?: string
}

/** GET /wa/app/{app_id}/template — list templates for the app. */
export async function listTemplates(
  creds: GupshupCredentials,
): Promise<GupshupTemplateListItem[]> {
  const res = await fetch(`${GUPSHUP_API_BASE}/app/${creds.appId}/template`, {
    headers: { apikey: creds.apiKey },
  })
  if (!res.ok) await throwGupshupError(res)
  const data = (await res.json()) as { templates?: GupshupTemplateListItem[] }
  return data.templates ?? []
}

export interface GupshupBusinessDetails {
  name?: string
  contactNumber?: string
  email?: string
  country?: string
}

/**
 * GET /wa/app/{app_id}/business — used purely as a real server-side
 * connection test (Gupshup has no dedicated health-check endpoint):
 * it requires a valid apikey + appId pair and returns account
 * metadata, so a 401/403/404 here means the saved credentials don't
 * actually work.
 */
export async function getBusinessDetails(
  creds: GupshupCredentials,
): Promise<GupshupBusinessDetails> {
  const res = await fetch(`${GUPSHUP_API_BASE}/app/${creds.appId}/business`, {
    headers: { apikey: creds.apiKey },
  })
  if (!res.ok) await throwGupshupError(res)
  return (await res.json()) as GupshupBusinessDetails
}
