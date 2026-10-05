'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  DollarSign,
  KeyRound,
  Loader2,
  RefreshCw,
  WalletCards,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type RangeDays = 7 | 30 | 90

type UsageData = {
  configured: true
  source: string
  appId: string
  appName: string | null
  range: { days: number; from: string; to: string }
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

type NotConfigured = {
  configured: false
  reason: string
  message?: string
  appId?: string
  appName?: string | null
}

type UsageResponse = UsageData | NotConfigured

export function GupshupUsageDashboard() {
  const { accountId, canEditSettings } = useAuth()
  const [range, setRange] = useState<RangeDays>(30)
  const [data, setData] = useState<UsageResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [savingToken, setSavingToken] = useState(false)

  const load = useCallback(async (days: RangeDays) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/dashboard/gupshup-usage?days=${days}`, {
        cache: 'no-store',
      })
      const body = (await res.json()) as UsageResponse & { message?: string }
      if (!res.ok && body.configured !== false) {
        throw new Error(body.message || 'Failed to load Gupshup usage')
      }
      setData(body)
      if (!res.ok && body.configured === false && body.reason !== 'token_corrupted') {
        setError(body.message || 'Failed to load Gupshup usage')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Gupshup usage')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!accountId) return
    void load(range)
  }, [accountId, range, load])

  async function saveToken() {
    const value = token.trim()
    if (!value) {
      toast.error('Partner App Token is required')
      return
    }
    setSavingToken(true)
    try {
      const res = await fetch('/api/dashboard/gupshup-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_token: value }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error || 'Could not save Gupshup Partner App Token')
        return
      }
      setToken('')
      toast.success('Gupshup cost analytics connected')
      await load(range)
    } catch {
      toast.error('Could not save Gupshup Partner App Token')
    } finally {
      setSavingToken(false)
    }
  }

  // Do not add a dead analytics panel to Meta-only accounts.
  if (!loading && data?.configured === false && data.reason === 'provider_not_gupshup') {
    return null
  }

  if (
    !loading &&
    data?.configured === false &&
    ['missing_partner_app_token', 'token_corrupted'].includes(data.reason)
  ) {
    return (
      <section className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <WalletCards className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">WhatsApp spend</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect Gupshup Partner Usage API to show Meta fees, Gupshup fees and average cost per outbound message.
          </p>
        </div>
        <div className="p-5">
          <div className="max-w-2xl rounded-lg border border-border bg-muted/25 p-4">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Gupshup Partner App Token</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This is the Partner App Access Token used by partner.gupshup.io. It is different from the legacy Gupshup API Key used to send messages. The token is encrypted before storage.
                </p>
                {data.reason === 'token_corrupted' && data.message ? (
                  <p className="mt-2 text-xs text-destructive">{data.message}</p>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <Input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Partner App Access Token"
                    disabled={!canEditSettings || savingToken}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    onClick={saveToken}
                    disabled={!canEditSettings || savingToken || !token.trim()}
                  >
                    {savingToken ? <Loader2 className="size-4 animate-spin" /> : 'Connect'}
                  </Button>
                </div>
                {!canEditSettings ? (
                  <p className="mt-2 text-xs text-muted-foreground">Admin access is required to configure billing analytics.</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <WalletCards className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">WhatsApp spend</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Gupshup billing and message usage for the active WhatsApp app.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {([7, 30, 90] as const).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setRange(days)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  range === days
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {days}d
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            type="button"
            onClick={() => void load(range)}
            disabled={loading}
            aria-label="Refresh Gupshup usage"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </header>

      <div className="space-y-5 p-5">
        {loading && !data ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading Gupshup usage…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : data?.configured === true ? (
          <UsageContent data={data} />
        ) : data?.configured === false && data.reason === 'missing_app_id' ? (
          <div className="rounded-lg border border-border bg-muted/25 p-4 text-sm text-muted-foreground">
            Add the Gupshup App ID in Settings → WhatsApp before enabling spend analytics.
          </div>
        ) : null}
      </div>
    </section>
  )
}

function UsageContent({ data }: { data: UsageData }) {
  const currency = data.currency || 'USD'
  const maxDaily = useMemo(
    () => Math.max(0, ...data.daily.map((row) => row.totalFees)),
    [data.daily],
  )

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SpendCard
          label="Total spend"
          value={money(data.totals.totalFees, currency)}
          hint={`${data.range.from} → ${data.range.to}`}
          icon={DollarSign}
        />
        <SpendCard
          label="Meta / WhatsApp fees"
          value={money(data.totals.waFees, currency)}
          hint="waFees from Gupshup"
          icon={WalletCards}
        />
        <SpendCard
          label="Gupshup fees"
          value={money(data.totals.gsFees, currency)}
          hint="gsFees from Gupshup"
          icon={WalletCards}
        />
        <SpendCard
          label="Avg / outbound"
          value={
            data.totals.avgOutboundCost == null
              ? '—'
              : money(data.totals.avgOutboundCost, currency, 4)
          }
          hint="Total spend ÷ outgoing messages"
          icon={DollarSign}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-lg border border-border p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-foreground">Daily spend</h3>
              <p className="text-xs text-muted-foreground">Confirmed daily fees from Gupshup Usage API</p>
            </div>
            <span className="text-xs text-muted-foreground">{currency}</span>
          </div>
          {data.daily.length === 0 ? (
            <div className="flex h-36 items-center justify-center text-sm text-muted-foreground">No usage returned for this period.</div>
          ) : (
            <div className="flex h-40 items-end gap-1.5 overflow-hidden">
              {data.daily.map((row) => {
                const height = maxDaily > 0 ? Math.max(2, (row.totalFees / maxDaily) * 100) : 2
                return (
                  <div key={row.date} className="group flex h-full min-w-0 flex-1 items-end" title={`${row.date}: ${money(row.totalFees, currency)}`}>
                    <div
                      className="w-full rounded-t-sm bg-primary/70 transition-colors group-hover:bg-primary"
                      style={{ height: `${height}%` }}
                    />
                  </div>
                )
              })}
            </div>
          )}
          {data.daily.length > 0 ? (
            <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
              <span>{shortDate(data.daily[0].date)}</span>
              <span>{shortDate(data.daily[data.daily.length - 1].date)}</span>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium text-foreground">Message usage</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Provider-level counts for the selected period</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <CountTile icon={ArrowUpRight} label="Outgoing" value={data.totals.outgoingMsg} />
            <CountTile icon={ArrowDownLeft} label="Incoming" value={data.totals.incomingMsg} />
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Category label="Marketing" value={data.categories.marketing} />
              <Category label="MM Lite marketing" value={data.categories.mmLiteMarketing} />
              <Category label="Utility" value={data.categories.utility} />
              <Category label="Authentication" value={data.categories.authentication} />
              <Category label="International auth" value={data.categories.internationalAuthentication} />
              <Category label="Service" value={data.categories.service} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function SpendCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string
  value: string
  hint: string
  icon: typeof DollarSign
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function CountTile({ icon: Icon, label, value }: { icon: typeof ArrowUpRight; label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </div>
      <p className="mt-1.5 text-xl font-semibold text-foreground">{value.toLocaleString()}</p>
    </div>
  )
}

function Category({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value.toLocaleString()}</span>
    </div>
  )
}

function money(value: number, currency: string, maxFractionDigits = 2): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: maxFractionDigits,
    }).format(value)
  } catch {
    return `${value.toFixed(maxFractionDigits)} ${currency}`
  }
}

function shortDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}
