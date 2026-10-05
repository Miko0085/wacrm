import { describe, expect, it } from 'vitest'
import { aggregateGupshupUsage } from './usage'

describe('aggregateGupshupUsage', () => {
  it('sums fees, message counts and categories and calculates avg outbound cost', () => {
    const result = aggregateGupshupUsage([
      {
        date: '2026-10-02',
        currency: 'USD',
        totalFees: 3,
        waFees: 2,
        gsFees: 1,
        outgoingMsg: 100,
        incomingMsg: 20,
        totalMsg: 120,
        marketing: 40,
        utility: 10,
        authentication: 2,
        internationalAuthentication: 1,
        service: 5,
        mmLiteMarketing: 3,
        ftc: 7,
        fep: 4,
      },
      {
        date: '2026-10-01',
        currency: 'USD',
        totalFees: 2,
        waFees: 1.5,
        gsFees: 0.5,
        outgoingMsg: 50,
        incomingMsg: 10,
        totalMsg: 60,
        marketing: 20,
        utility: 5,
        service: 2,
      },
    ])

    expect(result.currency).toBe('USD')
    expect(result.totals).toEqual({
      totalFees: 5,
      waFees: 3.5,
      gsFees: 1.5,
      outgoingMsg: 150,
      incomingMsg: 30,
      totalMsg: 180,
      avgOutboundCost: 5 / 150,
    })
    expect(result.categories).toEqual({
      marketing: 60,
      mmLiteMarketing: 3,
      utility: 15,
      authentication: 2,
      internationalAuthentication: 1,
      service: 7,
      freeTierConversations: 7,
      freeEntryPointConversations: 4,
    })
    expect(result.daily.map((row) => row.date)).toEqual(['2026-10-01', '2026-10-02'])
  })

  it('returns null avg when there are no outbound messages', () => {
    const result = aggregateGupshupUsage([
      { date: '2026-10-01', currency: 'USD', totalFees: 0, outgoingMsg: 0 },
    ])
    expect(result.totals.avgOutboundCost).toBeNull()
  })
})
