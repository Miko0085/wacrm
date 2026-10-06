import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const id = typeof body?.id === 'string' ? body.id.trim() : ''
    const chatId = typeof body?.chat_id === 'string' ? body.chat_id.trim() : ''
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const { data, error } = await supabase
      .from('telegram_connections')
      .select('bot_token, default_chat_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) throw error
    if (!data) return NextResponse.json({ error: 'connection not found' }, { status: 404 })

    const token = decrypt(data.bot_token as string)
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    })
    const me = await meRes.json().catch(() => null) as {
      ok?: boolean
      description?: string
      result?: { username?: string }
    } | null
    if (!meRes.ok || !me?.ok) {
      return NextResponse.json(
        { error: me?.description ?? 'Telegram connection failed' },
        { status: 400 },
      )
    }

    const target = chatId || data.default_chat_id || ''
    if (target) {
      const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: target,
          text: 'WACRM Telegram integration test ✅',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const send = await sendRes.json().catch(() => null) as { ok?: boolean; description?: string } | null
      if (!sendRes.ok || !send?.ok) {
        return NextResponse.json(
          { error: send?.description ?? 'Telegram test message failed' },
          { status: 400 },
        )
      }
    }

    return NextResponse.json({
      success: true,
      username: me.result?.username ?? null,
      message_sent: Boolean(target),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
