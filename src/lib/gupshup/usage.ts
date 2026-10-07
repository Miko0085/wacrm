export interface GupshupUsageRow {
  appId?: string
  appName?: string
  authentication?: number
  cumulativeBill?: number
  currency?: string
  date?: string
  discount?: number
  fep?: number
  ftc?: number
  gsCap?: number
  gsFeeCapiMarketing?: number
  gsFees?: number
  incomingMsg?: number
  internationalAuthentication?: number
  marketing?: number
  mmLiteBid?: number
  mmLiteMarketing?: number
  outgoingMediaMsg?: number
  outgoingMsg?: number
  service?: number
  templateMediaMsg?: number
  templateMsg?: number
  totalFees?: number
  totalMsg?: number
  utility?: number
  voiceInMetaFeeUsage?: number
  voiceOutMetaFeeUsage?: number
  waFees?: number
}

export interface GupshupUsageSummary {
  currency: string | null
  totals: {
    totalFees: number
    waFees: number
    gsFees: number
    outgoingMsg: number
    incomingMsg: number
    totalMsg: number
    avgOutboundCost: number | null
  }
  categories: {
    marketing: number
    mmLiteMarketing: number
    utility: number
    authentication: number
    internationalAuthentication: number
    service: number
    freeTierConversations: number
    freeEntryPointConversations: number
  }
  daily: Array<{
    date: string
    totalFees: number
    waFees: number
    gsFees: number
    outgoingMsg: number
    incomingMsg: number
  }>
}

type GupshupUsageTotalsAccumulator = {
  totalFees: number
  waFees: number
  gsFees: number
  outgoingMsg: number
  incomingMsg: number
  totalMsg: number
  marketing: number
  mmLiteMarketing: number
  utility: number
  authentication: number
  internationalAuthentication: number
  service: number
  ftc: number
  fep: number
}

function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function aggregateGupshupUsage(rows: GupshupUsageRow[]): GupshupUsageSummary {
  const ordered = [...rows]
    .filter((row) => typeof row.date === 'string' && row.date.length > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))

  const totals = ordered.reduce<GupshupUsageTotalsAccumulator>(
    (acc, row) => {
      acc.totalFees += n(row.totalFees)
      acc.waFees += n(row.waFees)
      acc.gsFees += n(row.gsFees)
      acc.outgoingMsg += n(row.outgoingMsg)
      acc.incomingMsg += n(row.incomingMsg)
      acc.totalMsg += n(row.totalMsg)
      acc.marketing += n(row.marketing)
      acc.mmLiteMarketing += n(row.mmLiteMarketing)
      acc.utility += n(row.utility)
      acc.authentication += n(row.authentication)
      acc.internationalAuthentication += n(row.internationalAuthentication)
      acc.service += n(row.service)
      acc.ftc += n(row.ftc)
      acc.fep += n(row.fep)
      return acc
    },
    {
      totalFees: 0,
      waFees: 0,
      gsFees: 0,
      outgoingMsg: 0,
      incomingMsg: 0,
      totalMsg: 0,
      marketing: 0,
      mmLiteMarketing: 0,
      utility: 0,
      authentication: 0,
      internationalAuthentication: 0,
      service: 0,
      ftc: 0,
      fep: 0,
    },
  )

  const currency =
    ordered.map((row) => row.currency).find((value): value is string => Boolean(value)) ?? null

  return {
    currency,
    totals: {
      totalFees: totals.totalFees,
      waFees: totals.waFees,
      gsFees: totals.gsFees,
      outgoingMsg: totals.outgoingMsg,
      incomingMsg: totals.incomingMsg,
      totalMsg: totals.totalMsg,
      avgOutboundCost:
        totals.outgoingMsg > 0 ? totals.totalFees / totals.outgoingMsg : null,
    },
    categories: {
      marketing: totals.marketing,
      mmLiteMarketing: totals.mmLiteMarketing,
      utility: totals.utility,
      authentication: totals.authentication,
      internationalAuthentication: totals.internationalAuthentication,
      service: totals.service,
      freeTierConversations: totals.ftc,
      freeEntryPointConversations: totals.fep,
    },
    daily: ordered.map((row) => ({
      date: row.date as string,
      totalFees: n(row.totalFees),
      waFees: n(row.waFees),
      gsFees: n(row.gsFees),
      outgoingMsg: n(row.outgoingMsg),
      incomingMsg: n(row.incomingMsg),
    })),
  }
}

export async function fetchGupshupUsage(args: {
  appId: string
  appToken: string
  from: string
  to: string
}): Promise<GupshupUsageRow[]> {
  const url = new URL(
    `https://partner.gupshup.io/partner/app/${encodeURIComponent(args.appId)}/usage`,
  )
  url.searchParams.set('from', args.from)
  url.searchParams.set('to', args.to)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: args.appToken,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    })

    const text = await response.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }

    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message?: unknown }).message ?? '')
          : text
      throw new Error(
        `Gupshup Usage API ${response.status}${message ? `: ${message}` : ''}`,
      )
    }

    if (!body || typeof body !== 'object') {
      throw new Error('Gupshup Usage API returned an invalid response')
    }

    const payload = body as {
      status?: unknown
      message?: unknown
      partnerAppUsageList?: unknown
    }
    if (payload.status !== 'success') {
      throw new Error(
        `Gupshup Usage API error${payload.message ? `: ${String(payload.message)}` : ''}`,
      )
    }
    if (!Array.isArray(payload.partnerAppUsageList)) {
      return []
    }
    return payload.partnerAppUsageList as GupshupUsageRow[]
  } finally {
    clearTimeout(timeout)
  }
}
