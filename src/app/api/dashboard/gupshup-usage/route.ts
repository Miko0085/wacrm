import { NextResponse } from 'next/server'
import { requireActiveAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  aggregateGupshupUsage,
  fetchGupshupUsage,
} from '@/lib/gupshup/usage'

const ALLOWED_DAYS = new Set([7, 30, 90])

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function rangeForDays(days: number): { from: string; to: string } {
  const toDate = new Date()
  const fromDate = new Date(toDate)
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1))
  return { from: isoDay(fromDate), to: isoDay(toDate) }
}

function parseDays(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get('days') ?? 30)
  return ALLOWED_DAYS.has(raw) ? raw : 30
}

export async function GET(request: Request) {
  try {
    const ctx = await requireActiveAccount()
    const days = parseDays(request)

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select(
        'provider, gupshup_app_id, gupshup_app_name, gupshup_partner_app_token',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) throw error
    if (!config || config.provider !== 'gupshup') {
      return NextResponse.json({
        configured: false,
        reason: 'provider_not_gupshup',
      })
    }

    const appId = String(config.gupshup_app_id ?? '').trim()
    if (!appId) {
      return NextResponse.json({
        configured: false,
        reason: 'missing_app_id',
      })
    }

    if (!config.gupshup_partner_app_token) {
      return NextResponse.json({
        configured: false,
        reason: 'missing_partner_app_token',
        appId,
        appName: config.gupshup_app_name ?? null,
      })
    }

    let appToken: string
    try {
      appToken = decrypt(config.gupshup_partner_app_token)
    } catch (err) {
      console.error('[gupshup-usage] Partner app token decrypt failed:', err)
      return NextResponse.json(
        {
          configured: false,
          reason: 'token_corrupted',
          message: 'Saved Gupshup analytics token cannot be decrypted. Re-enter it.',
          appId,
          appName: config.gupshup_app_name ?? null,
        },
        { status: 409 },
      )
    }

    const range = rangeForDays(days)
    try {
      const rows = await fetchGupshupUsage({
        appId,
        appToken,
        from: range.from,
        to: range.to,
      })
      return NextResponse.json({
        configured: true,
        source: 'gupshup_partner_usage_api',
        appId,
        appName: config.gupshup_app_name ?? null,
        range: { days, ...range },
        ...aggregateGupshupUsage(rows),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[gupshup-usage] fetch failed:', message)
      return NextResponse.json(
        {
          configured: true,
          error: 'usage_fetch_failed',
          message,
          appId,
          appName: config.gupshup_app_name ?? null,
          range: { days, ...range },
        },
        { status: 502 },
      )
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const appToken =
      body && typeof body === 'object' && typeof body.app_token === 'string'
        ? body.app_token.trim()
        : ''
    if (!appToken) {
      return NextResponse.json({ error: 'app_token is required' }, { status: 400 })
    }

    const { data: config, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('provider, gupshup_app_id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) throw error
    if (!config || config.provider !== 'gupshup') {
      return NextResponse.json(
        { error: 'The active account is not configured to use Gupshup.' },
        { status: 409 },
      )
    }
    const appId = String(config.gupshup_app_id ?? '').trim()
    if (!appId) {
      return NextResponse.json(
        { error: 'Gupshup App ID is missing from WhatsApp settings.' },
        { status: 409 },
      )
    }

    // Verify the Partner App Token against the real Usage API before storing it.
    const verifyRange = rangeForDays(2)
    try {
      await fetchGupshupUsage({
        appId,
        appToken,
        from: verifyRange.from,
        to: verifyRange.to,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { error: `Gupshup rejected the Partner App Token: ${message}` },
        { status: 400 },
      )
    }

    const encrypted = encrypt(appToken)
    const { error: updateError } = await ctx.supabase
      .from('whatsapp_config')
      .update({
        gupshup_partner_app_token: encrypted,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', ctx.accountId)
    if (updateError) throw updateError

    return NextResponse.json({ configured: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin')
    const { error } = await ctx.supabase
      .from('whatsapp_config')
      .update({
        gupshup_partner_app_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', ctx.accountId)
    if (error) throw error
    return NextResponse.json({ configured: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
