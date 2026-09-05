import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createGupshupProvider } from '@/lib/whatsapp/providers/gupshup-provider'
import { createMetaProvider } from '@/lib/whatsapp/providers/meta-provider'

/**
 * POST /api/whatsapp/config/test
 *
 * "Test connection" for the Settings form, BEFORE the user has saved
 * anything — it builds a provider straight from the values currently
 * in the form (never persisted, never logged) and runs the same real
 * server-side check `resolveWhatsAppProvider(...).testConnection()`
 * would run against a saved row. Required so "Test connection" can't
 * be satisfied by "the fields are non-empty" (see requirement #9 /
 * docs/GUPSHUP_INTEGRATION.md).
 */
export async function POST(request: Request) {
  try {
    await requireRole('admin')

    const body = await request.json()
    const provider = body.provider === 'gupshup' ? 'gupshup' : 'meta'

    if (provider === 'gupshup') {
      const { gupshup_api_key, gupshup_app_id, gupshup_app_name, gupshup_source_phone_number } = body
      if (!gupshup_api_key || !gupshup_app_id || !gupshup_source_phone_number) {
        return NextResponse.json(
          { connected: false, reason: 'bad_request', message: 'API key, App ID, and Source Number are required.' },
          { status: 200 },
        )
      }
      const result = await createGupshupProvider({
        apiKey: gupshup_api_key,
        appId: gupshup_app_id,
        appName: gupshup_app_name || '',
        sourceNumber: gupshup_source_phone_number,
      }).testConnection()
      return NextResponse.json(result)
    }

    const { phone_number_id, access_token } = body
    if (!phone_number_id || !access_token) {
      return NextResponse.json(
        { connected: false, reason: 'bad_request', message: 'Phone Number ID and Access Token are required.' },
        { status: 200 },
      )
    }
    const result = await createMetaProvider({
      phoneNumberId: phone_number_id,
      wabaId: body.waba_id || null,
      accessToken: access_token,
    }).testConnection()
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
