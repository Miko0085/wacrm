import { describe, it, expect, vi } from 'vitest'
import type { WhatsAppConfig } from '@/types'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
}))

import { resolveWhatsAppProvider, ProviderError } from './resolve'

function baseConfig(overrides: Partial<WhatsAppConfig>): WhatsAppConfig {
  return {
    id: 'cfg-1',
    user_id: 'u1',
    provider: 'meta',
    status: 'connected',
    ...overrides,
  } as WhatsAppConfig
}

describe('resolveWhatsAppProvider', () => {
  it('defaults to Meta for a pre-migration row with no provider column set', () => {
    const config = baseConfig({
      provider: undefined as unknown as 'meta',
      phone_number_id: 'pn-1',
      access_token: 'enc-token',
    })
    const provider = resolveWhatsAppProvider(config)
    expect(provider.id).toBe('meta')
  })

  it('builds a Meta provider from phone_number_id + access_token', () => {
    const provider = resolveWhatsAppProvider(
      baseConfig({ provider: 'meta', phone_number_id: 'pn-1', access_token: 'enc-token', waba_id: 'waba-1' }),
    )
    expect(provider.id).toBe('meta')
  })

  it('throws not_supported when provider=meta but credentials are missing', () => {
    expect(() => resolveWhatsAppProvider(baseConfig({ provider: 'meta' }))).toThrowError(ProviderError)
    try {
      resolveWhatsAppProvider(baseConfig({ provider: 'meta' }))
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe('not_supported')
      expect((err as ProviderError).provider).toBe('meta')
    }
  })

  it('builds a Gupshup provider from the gupshup_* columns', () => {
    const provider = resolveWhatsAppProvider(
      baseConfig({
        provider: 'gupshup',
        gupshup_api_key: 'enc-key',
        gupshup_app_id: 'app-1',
        gupshup_app_name: 'MyApp',
        gupshup_source_phone_number: '15550001234',
      }),
    )
    expect(provider.id).toBe('gupshup')
  })

  it('throws not_supported when provider=gupshup but credentials are missing', () => {
    expect(() => resolveWhatsAppProvider(baseConfig({ provider: 'gupshup' }))).toThrowError(ProviderError)
    try {
      resolveWhatsAppProvider(baseConfig({ provider: 'gupshup' }))
    } catch (err) {
      expect((err as ProviderError).provider).toBe('gupshup')
    }
  })

  it('never picks Meta credentials when provider=gupshup, and vice versa (no cross-provider leakage on the same row)', () => {
    // A row that has BOTH sets saved (switched providers before) —
    // resolveWhatsAppProvider must honor `provider`, not "whichever
    // credentials happen to be present".
    const config = baseConfig({
      provider: 'gupshup',
      phone_number_id: 'pn-1',
      access_token: 'enc-token',
      gupshup_api_key: 'enc-key',
      gupshup_app_id: 'app-1',
      gupshup_source_phone_number: '15550001234',
    })
    expect(resolveWhatsAppProvider(config).id).toBe('gupshup')
  })
})
