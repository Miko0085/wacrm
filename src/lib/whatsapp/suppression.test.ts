import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assertMarketingAllowed, MarketingSuppressedError } from './suppression'

function mockDb(waMarketingStatus: string | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: waMarketingStatus ? { wa_marketing_status: waMarketingStatus } : null,
            error: null,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('assertMarketingAllowed', () => {
  it('is a no-op for a non-Marketing category, even for an opted-out contact', async () => {
    await expect(assertMarketingAllowed(mockDb('OPTED_OUT'), 'c1', 'Utility')).resolves.toBeUndefined()
    await expect(assertMarketingAllowed(mockDb('OPTED_OUT'), 'c1', 'Authentication')).resolves.toBeUndefined()
  })

  it('is a no-op for a Marketing template when the contact is OPTED_IN or UNKNOWN', async () => {
    await expect(assertMarketingAllowed(mockDb('OPTED_IN'), 'c1', 'Marketing')).resolves.toBeUndefined()
    await expect(assertMarketingAllowed(mockDb('UNKNOWN'), 'c1', 'Marketing')).resolves.toBeUndefined()
  })

  it('is a no-op when there is no template row / category at all (e.g. a free-form send)', async () => {
    await expect(assertMarketingAllowed(mockDb('OPTED_OUT'), 'c1', null)).resolves.toBeUndefined()
    await expect(assertMarketingAllowed(mockDb('OPTED_OUT'), 'c1', undefined)).resolves.toBeUndefined()
  })

  it('throws MarketingSuppressedError for a Marketing template to an OPTED_OUT contact', async () => {
    await expect(assertMarketingAllowed(mockDb('OPTED_OUT'), 'c1', 'Marketing')).rejects.toBeInstanceOf(
      MarketingSuppressedError,
    )
  })
})
