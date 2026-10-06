import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sendTelegramNotification } from '@/lib/telegram/send'

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
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}
