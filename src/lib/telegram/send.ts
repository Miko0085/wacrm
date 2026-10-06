import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

export interface SendTelegramArgs {
  db: SupabaseClient
  accountId: string
  connectionId: string
  chatId?: string | null
  text: string
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2' | null
}

export async function sendTelegramNotification(args: SendTelegramArgs): Promise<number> {
  const { data, error } = await args.db
    .from('telegram_connections')
    .select('id, bot_token, default_chat_id, is_active')
    .eq('id', args.connectionId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (error) throw error
  if (!data || !data.is_active) throw new Error('Telegram connection is missing or inactive')

  const chatId = (args.chatId ?? data.default_chat_id ?? '').trim()
  if (!chatId) throw new Error('Telegram chat_id is required')

  const token = decrypt(data.bot_token)
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: args.text,
      ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  const body = await res.json().catch(() => null) as
    | { ok?: boolean; description?: string; result?: { message_id?: number } }
    | null

  if (!res.ok || !body?.ok || !body.result?.message_id) {
    throw new Error(body?.description || `Telegram API returned ${res.status}`)
  }

  return body.result.message_id
}
