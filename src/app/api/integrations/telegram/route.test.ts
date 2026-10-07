import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-utils/fake-db'

const h = vi.hoisted(() => ({
  db: null as unknown,
  role: 'ok' as 'ok' | 'forbidden',
  send: vi.fn(),
}))

class ForbiddenError extends Error {
  status = 403
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ supabase: h.db, accountId: 'acc-A', userId: 'user-1' }),
  requireRole: async () => {
    if (h.role === 'forbidden') throw new ForbiddenError('Forbidden')
    return { supabase: h.db, accountId: 'acc-A', userId: 'user-1' }
  },
  toErrorResponse: (err: unknown) =>
    err instanceof ForbiddenError
      ? Response.json({ error: err.message }, { status: 403 })
      : Response.json({ error: 'Internal server error' }, { status: 500 }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}` }))
vi.mock('@/lib/telegram/send', async (orig) => ({
  ...(await orig<typeof import('@/lib/telegram/send')>()),
  sendTelegramNotification: h.send,
}))

import { GET, POST } from './route'
import { POST as TEST } from './test/route'
import { TelegramError } from '@/lib/telegram/send'

const RAW_TOKEN = '999:RAW-BOT-TOKEN'

function withDb(): FakeDb {
  const db = createFakeDb({
    telegram_connections: [
      { id: 'tg-A', account_id: 'acc-A', name: 'A', bot_token: 'enc:stored', default_chat_id: '1', is_active: true, created_at: 1, updated_at: 1 },
      { id: 'tg-B', account_id: 'acc-B', name: 'B', bot_token: 'enc:other', default_chat_id: '2', is_active: true, created_at: 1, updated_at: 1 },
    ],
  })
  h.db = db
  return db
}

const json = (body: unknown) =>
  new Request('http://x/api/integrations/telegram', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.role = 'ok'
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/integrations/telegram', () => {
  it('lists only the caller account, and never returns the bot token (encrypted or not)', async () => {
    withDb()
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual(['tg-A'])
    expect(JSON.stringify(body)).not.toContain('bot_token')
    expect(JSON.stringify(body)).not.toContain('enc:stored')
  })

  it('selects an explicit column list that excludes bot_token', async () => {
    const db = withDb()
    const selected: string[] = []
    const origFrom = db.from.bind(db)
    db.from = ((t: string) => {
      const b = origFrom(t)
      const origSelect = b.select.bind(b)
      b.select = ((cols?: string, o?: { count?: string; head?: boolean }) => {
        if (cols) selected.push(cols)
        return origSelect(cols, o)
      }) as typeof b.select
      return b
    }) as typeof db.from
    await GET()
    expect(selected.join(',')).not.toMatch(/bot_token|\*/)
  })
})

describe('POST /api/integrations/telegram', () => {
  it('stores the token ENCRYPTED and never echoes it back', async () => {
    const db = withDb()
    const res = await POST(json({ name: 'Ops', bot_token: RAW_TOKEN, default_chat_id: '-100' }))
    expect(res.status).toBe(201)
    expect(JSON.stringify(await res.json())).not.toContain('RAW-BOT-TOKEN')
    const created = db.tables.telegram_connections.at(-1)!
    expect(created.bot_token).toBe(`enc:${RAW_TOKEN}`)
    expect(created.bot_token).not.toBe(RAW_TOKEN)
    expect(created).toMatchObject({ account_id: 'acc-A', created_by: 'user-1' })
  })

  it('keeps the stored token when an update omits it', async () => {
    const db = withDb()
    await POST(json({ id: 'tg-A', name: 'Renamed', default_chat_id: '1' }))
    expect(db.tables.telegram_connections[0]).toMatchObject({ name: 'Renamed', bot_token: 'enc:stored' })
  })

  it("cannot update another account's connection", async () => {
    const db = withDb()
    await POST(json({ id: 'tg-B', name: 'Hijack', bot_token: RAW_TOKEN }))
    expect(db.tables.telegram_connections[1]).toMatchObject({ name: 'B', bot_token: 'enc:other' })
  })

  it('requires admin', async () => {
    withDb()
    h.role = 'forbidden'
    const res = await POST(json({ name: 'x', bot_token: 't' }))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/integrations/telegram/test — status codes', () => {
  const call = (body: unknown = { connection_id: 'tg-A' }) =>
    TEST(json(body))

  it('400 when connection_id is missing', async () => {
    withDb()
    expect((await call({})).status).toBe(400)
  })

  it('200 on success', async () => {
    withDb()
    h.send.mockResolvedValue(7)
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, message_id: 7 })
  })

  it.each([
    ['config', 400],
    ['bad_request', 400],
    ['auth', 401],
    ['forbidden', 403],
    ['rate_limited', 429],
    ['upstream', 502],
    ['network', 502],
    ['timeout', 504],
  ] as const)('Telegram failure kind %s -> HTTP %i', async (kind, status) => {
    withDb()
    h.send.mockRejectedValue(new TelegramError(kind, 'safe message', kind === 'rate_limited' ? 9 : undefined))
    const res = await call()
    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body).toEqual({ error: 'safe message', kind })
    if (kind === 'rate_limited') expect(res.headers.get('Retry-After')).toBe('9')
  })

  it('does not turn an unexpected exception into a 400 or leak its text', async () => {
    withDb()
    h.send.mockRejectedValue(new Error(`db exploded near ${RAW_TOKEN}`))
    const res = await call()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('RAW-BOT-TOKEN')
  })

  it('keeps app authorization failures as 403, not 400', async () => {
    withDb()
    h.role = 'forbidden'
    expect((await call()).status).toBe(403)
  })
})
