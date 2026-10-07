import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

export type TelegramParseMode = 'HTML' | 'Markdown' | 'MarkdownV2'

export interface SendTelegramArgs {
  db: SupabaseClient
  accountId: string
  connectionId: string
  chatId?: string | null
  text: string
  /**
   * Defaults to plain text. Handoff notifications embed customer-controlled
   * text, so they must never be parsed as HTML/Markdown unless the template
   * author opted in AND the interpolated values were escaped
   * (see escapeTelegramText).
   */
  parseMode?: TelegramParseMode | null
}

export type TelegramErrorKind =
  | 'config' // our side: missing/inactive connection, no chat id, bad token storage
  | 'bad_request' // Telegram 400: bad chat_id, can't parse entities, message too long
  | 'auth' // Telegram 401/404: token revoked or malformed
  | 'forbidden' // Telegram 403: bot blocked / kicked / no rights in that chat
  | 'rate_limited' // Telegram 429
  | 'upstream' // Telegram 5xx or unparseable reply
  | 'timeout'
  | 'network'

const HTTP_STATUS: Record<TelegramErrorKind, number> = {
  config: 400,
  bad_request: 400,
  auth: 401,
  forbidden: 403,
  rate_limited: 429,
  upstream: 502,
  timeout: 504,
  network: 502,
}

/**
 * Every message below is a fixed string chosen by us. The Telegram response
 * body and any underlying fetch error are deliberately NOT forwarded: the
 * request URL contains the bot token, and error text ends up in
 * automation_logs and API responses.
 */
export class TelegramError extends Error {
  readonly kind: TelegramErrorKind
  readonly httpStatus: number
  readonly retryAfterSeconds?: number

  constructor(kind: TelegramErrorKind, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'TelegramError'
    this.kind = kind
    this.httpStatus = HTTP_STATUS[kind]
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const TELEGRAM_TEXT_LIMIT = 4096
const REQUEST_TIMEOUT_MS = 10_000

/** Escape a dynamic VALUE (never the whole template) for the given parse mode. */
export function escapeTelegramText(
  mode: TelegramParseMode | null | undefined,
  value: string,
): string {
  switch (mode) {
    case 'HTML':
      return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    case 'MarkdownV2':
      return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&')
    case 'Markdown':
      return value.replace(/[_*`[\\]/g, '\\$&')
    default:
      return value
  }
}

function classifyHttpFailure(
  status: number,
  retryAfter: number | undefined,
  description: string,
): TelegramError {
  if (status === 429) {
    return new TelegramError('rate_limited', 'Telegram rate limit reached; try again later', retryAfter)
  }
  if (status === 401 || status === 404) {
    return new TelegramError('auth', 'Telegram rejected the bot token (revoked or invalid)')
  }
  if (status === 403) {
    return new TelegramError('forbidden', 'The Telegram bot is not allowed to message this chat')
  }
  if (status === 400) {
    const d = description.toLowerCase()
    if (d.includes('chat not found')) {
      return new TelegramError(
        'bad_request',
        'Telegram chat not found — check chat_id and that the bot was added to the chat',
      )
    }
    if (d.includes("can't parse entities")) {
      return new TelegramError('bad_request', 'Telegram could not parse the message formatting')
    }
    return new TelegramError('bad_request', 'Telegram rejected the request (invalid chat_id or message)')
  }
  return new TelegramError('upstream', 'Telegram is unavailable; try again later')
}

export async function sendTelegramNotification(args: SendTelegramArgs): Promise<number> {
  const { data, error } = await args.db
    .from('telegram_connections')
    .select('id, bot_token, default_chat_id, is_active')
    .eq('id', args.connectionId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (error) throw error
  if (!data || !data.is_active) {
    throw new TelegramError('config', 'Telegram connection is missing or inactive')
  }

  const chatId = (args.chatId ?? data.default_chat_id ?? '').trim()
  if (!chatId) throw new TelegramError('config', 'Telegram chat_id is required')

  let token: string
  try {
    token = decrypt(data.bot_token)
  } catch {
    throw new TelegramError('config', 'Stored Telegram token could not be decrypted; re-enter the bot token')
  }

  let res: Response
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: args.text.slice(0, TELEGRAM_TEXT_LIMIT),
        ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new TelegramError('timeout', 'Telegram did not respond in time')
    }
    throw new TelegramError('network', 'Could not reach Telegram')
  }

  const body = (await res.json().catch(() => null)) as
    | {
        ok?: boolean
        description?: string
        parameters?: { retry_after?: number }
        result?: { message_id?: number }
      }
    | null

  if (!res.ok || !body?.ok) {
    throw classifyHttpFailure(
      res.status,
      body?.parameters?.retry_after,
      String(body?.description ?? ''),
    )
  }
  if (!body.result?.message_id) {
    throw new TelegramError('upstream', 'Telegram returned an unexpected response')
  }

  return body.result.message_id
}
