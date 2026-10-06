import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function sendTelegramMessage(args: {
  db: SupabaseClient
  accountId: string
  connectionId: string
  chatId?: string | null
  text: string
  parseMode?: 'HTML' | 'MarkdownV2' | null
}): Promise<{ message_id: number; chat_id: string }> {
  const { data, error } = await args.db
    .from('telegram_connections')
    .select('id, account_id, bot_token, default_chat_id, is_active')
    .eq('id', args.connectionId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (error) throw new Error(`Telegram connection lookup failed: ${error.message}`)
  if (!data) throw new Error('Telegram connection not found')
  if (!data.is_active) throw new Error('Telegram connection is disabled')

  const chatId = (args.chatId || data.default_chat_id || '').trim()
  if (!chatId) throw new Error('Telegram chat id is required')

  const token = decrypt(data.bot_token as string)
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: args.text,
    disable_web_page_preview: true,
  }
  if (args.parseMode) body.parse_mode = args.parseMode

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const json = await res.json().catch(() => null) as {
    ok?: boolean
    description?: string
    result?: { message_id?: number; chat?: { id?: string | number } }
  } | null

  if (!res.ok || !json?.ok || !json.result?.message_id) {
    throw new Error(`Telegram send failed: ${json?.description ?? res.status}`)
  }

  return {
    message_id: json.result.message_id,
    chat_id: String(json.result.chat?.id ?? chatId),
  }
}
