import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeDb } from '@/test-utils/fake-db'

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v === 'corrupt') throw new Error('bad key')
    return v.replace(/^enc:/, '')
  },
}))

import { TelegramError, escapeTelegramText, sendTelegramNotification } from './send'

const TOKEN = '123456:SECRET-BOT-TOKEN'

function db(extra: Record<string, unknown>[] = []) {
  return createFakeDb({
    telegram_connections: [
      { id: 'tg-A', account_id: 'acc-A', bot_token: `enc:${TOKEN}`, default_chat_id: '-1001', is_active: true },
      { id: 'tg-B', account_id: 'acc-B', bot_token: 'enc:other', default_chat_id: '-2002', is_active: true },
      { id: 'tg-off', account_id: 'acc-A', bot_token: `enc:${TOKEN}`, default_chat_id: '-1001', is_active: false },
      { id: 'tg-nochat', account_id: 'acc-A', bot_token: `enc:${TOKEN}`, default_chat_id: null, is_active: true },
      { id: 'tg-corrupt', account_id: 'acc-A', bot_token: 'corrupt', default_chat_id: '1', is_active: true },
      ...extra,
    ],
  }) as unknown as SupabaseClient
}

const send = (over: Partial<Parameters<typeof sendTelegramNotification>[0]> = {}) =>
  sendTelegramNotification({
    db: db(),
    accountId: 'acc-A',
    connectionId: 'tg-A',
    text: 'hello',
    ...over,
  })

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.unstubAllGlobals())

async function failure(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(TelegramError)
    return e as TelegramError
  }
  throw new Error('expected a TelegramError')
}

describe('sendTelegramNotification', () => {
  it('sends with the DECRYPTED token and returns the message id', async () => {
    const fetchMock = mockFetch(200, { ok: true, result: { message_id: 42 } })
    expect(await send()).toBe(42)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: '-1001', text: 'hello' })
  })

  it('uses plain text by default: no parse_mode key is sent', async () => {
    const fetchMock = mockFetch(200, { ok: true, result: { message_id: 1 } })
    await send({ text: '<b>customer</b> *injected* [x](http://evil)' })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).not.toHaveProperty('parse_mode')
    expect(body.text).toBe('<b>customer</b> *injected* [x](http://evil)')
  })

  it('sends parse_mode only when explicitly requested', async () => {
    const fetchMock = mockFetch(200, { ok: true, result: { message_id: 1 } })
    await send({ parseMode: 'HTML' })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.parse_mode).toBe('HTML')
  })

  it('truncates to the Telegram 4096 character limit', async () => {
    const fetchMock = mockFetch(200, { ok: true, result: { message_id: 1 } })
    await send({ text: 'x'.repeat(10_000) })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.text).toHaveLength(4096)
  })

  describe('tenant scope', () => {
    it("cannot use another account's connection", async () => {
      const fetchMock = mockFetch(200, { ok: true, result: { message_id: 1 } })
      const err = await failure(send({ accountId: 'acc-A', connectionId: 'tg-B' }))
      expect(err.kind).toBe('config')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('refuses an inactive connection', async () => {
      mockFetch(200, { ok: true, result: { message_id: 1 } })
      expect((await failure(send({ connectionId: 'tg-off' }))).kind).toBe('config')
    })
  })

  describe('config errors never reach Telegram', () => {
    it('requires a chat id', async () => {
      const fetchMock = mockFetch(200, {})
      const err = await failure(send({ connectionId: 'tg-nochat' }))
      expect(err.message).toMatch(/chat_id/)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('reports an undecryptable token without leaking it', async () => {
      const err = await failure(send({ connectionId: 'tg-corrupt' }))
      expect(err.kind).toBe('config')
      expect(err.message).not.toContain('corrupt')
    })
  })

  describe('error mapping', () => {
    it.each([
      [400, { ok: false, description: 'Bad Request: chat not found' }, 'bad_request', 400],
      [400, { ok: false, description: "Bad Request: can't parse entities: Unexpected end tag" }, 'bad_request', 400],
      [401, { ok: false, description: 'Unauthorized' }, 'auth', 401],
      [404, { ok: false, description: 'Not Found' }, 'auth', 401],
      [403, { ok: false, description: 'Forbidden: bot was blocked by the user' }, 'forbidden', 403],
      [429, { ok: false, parameters: { retry_after: 17 } }, 'rate_limited', 429],
      [500, { ok: false, description: 'Internal Server Error' }, 'upstream', 502],
      [502, null, 'upstream', 502],
    ])('Telegram %i -> %s (HTTP %i)', async (status, body, kind, httpStatus) => {
      mockFetch(status as number, body)
      const err = await failure(send())
      expect(err.kind).toBe(kind)
      expect(err.httpStatus).toBe(httpStatus)
    })

    it('carries Retry-After for rate limits', async () => {
      mockFetch(429, { ok: false, parameters: { retry_after: 17 } })
      expect((await failure(send())).retryAfterSeconds).toBe(17)
    })

    it('maps a timeout to 504', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new DOMException('timed out', 'TimeoutError')
      }))
      const err = await failure(send())
      expect(err).toMatchObject({ kind: 'timeout', httpStatus: 504 })
    })

    it('maps a network failure to 502', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new TypeError('fetch failed')
      }))
      expect(await failure(send())).toMatchObject({ kind: 'network', httpStatus: 502 })
    })

    it('treats an ok response without a message id as an upstream fault', async () => {
      mockFetch(200, { ok: true, result: {} })
      expect((await failure(send())).kind).toBe('upstream')
    })
  })

  it('NEVER exposes the bot token or raw Telegram text in any error', async () => {
    const leaky = [
      mockFetchReturn(401, { ok: false, description: `Unauthorized token ${TOKEN}` }),
      mockFetchReturn(400, { ok: false, description: `Bad Request: secret ${TOKEN}` }),
      mockFetchReturn(500, { ok: false, description: TOKEN }),
    ]
    for (const setup of leaky) {
      setup()
      const err = await failure(send())
      expect(err.message).not.toContain(TOKEN)
      expect(err.message).not.toContain('SECRET')
      expect(String(err.stack)).not.toContain(TOKEN)
    }
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`)
    }))
    const netErr = await failure(send())
    expect(netErr.message).not.toContain(TOKEN)
  })
})

function mockFetchReturn(status: number, body: unknown) {
  return () => {
    mockFetch(status, body)
  }
}

describe('escapeTelegramText', () => {
  it('HTML: neutralises tags and entities', () => {
    expect(escapeTelegramText('HTML', '<b>x</b> & <a href="y">')).toBe(
      '&lt;b&gt;x&lt;/b&gt; &amp; &lt;a href="y"&gt;',
    )
  })
  it('MarkdownV2: escapes every reserved character', () => {
    const out = escapeTelegramText('MarkdownV2', '_*[]()~`>#+-=|{}.!\\')
    expect(out).toBe('\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\')
  })
  it('Markdown: escapes emphasis / code / link starters', () => {
    expect(escapeTelegramText('Markdown', '_a_ *b* `c` [d]')).toBe('\\_a\\_ \\*b\\* \\`c\\` \\[d]')
  })
  it('plain text (null/undefined) is untouched', () => {
    expect(escapeTelegramText(null, '<b>*')).toBe('<b>*')
    expect(escapeTelegramText(undefined, '<b>*')).toBe('<b>*')
  })
})
