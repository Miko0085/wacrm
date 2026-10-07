import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { TelegramError, sendTelegramNotification } from '@/lib/telegram/send'

/**
 * Status codes (the body only ever carries our own fixed message):
 *   400 bad input / connection config / Telegram rejected chat_id
 *   401 Telegram rejected the bot token      403 bot not allowed in that chat
 *   429 Telegram rate limit                  502 Telegram unavailable / unreachable
 *   504 Telegram timed out
 * App-level auth failures keep their own 401/403 via toErrorResponse.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const connectionId = typeof body?.connection_id === 'string' ? body.connection_id : ''
    const chatId = typeof body?.chat_id === 'string' ? body.chat_id : undefined
    if (!connectionId) {
      return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
    }
    const messageId = await sendTelegramNotification({
      db: supabase,
      accountId,
      connectionId,
      chatId,
      text: 'WACRM Telegram integration test ✅',
    })
    return NextResponse.json({ ok: true, message_id: messageId })
  } catch (err) {
    if (err instanceof TelegramError) {
      return NextResponse.json(
        { error: err.message, kind: err.kind },
        {
          status: err.httpStatus,
          headers: err.retryAfterSeconds
            ? { 'Retry-After': String(err.retryAfterSeconds) }
            : undefined,
        },
      )
    }
    return toErrorResponse(err)
  }
}
