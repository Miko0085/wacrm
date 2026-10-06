import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('telegram_connections')
      .select('id, name, default_chat_id, is_active, created_at, updated_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ connections: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const token = typeof body.bot_token === 'string' ? body.bot_token.trim() : ''
    const defaultChatId =
      typeof body.default_chat_id === 'string' && body.default_chat_id.trim()
        ? body.default_chat_id.trim()
        : null
    const isActive = body.is_active !== false

    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

    if (id) {
      const patch: Record<string, unknown> = {
        name,
        default_chat_id: defaultChatId,
        is_active: isActive,
      }
      if (token) patch.bot_token = encrypt(token)
      const { error } = await supabase
        .from('telegram_connections')
        .update(patch)
        .eq('id', id)
        .eq('account_id', accountId)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    if (!token) {
      return NextResponse.json({ error: 'bot_token is required' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('telegram_connections')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        bot_token: encrypt(token),
        default_chat_id: defaultChatId,
        is_active: isActive,
      })
      .select('id')
      .single()
    if (error) throw error
    return NextResponse.json({ ok: true, id: data.id }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const id = new URL(request.url).searchParams.get('id')?.trim()
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    const { error } = await supabase
      .from('telegram_connections')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
