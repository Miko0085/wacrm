import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sendSessionMessage,
  sendTemplateMessage,
  listTemplates,
  getBusinessDetails,
  type GupshupCredentials,
} from './gupshup-client'
import { ProviderError } from './types'

const CREDS: GupshupCredentials = {
  apiKey: 'test-key',
  appId: 'app-1',
  appName: 'TestApp',
  sourceNumber: '15550001234',
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('gupshup-client', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sendSessionMessage', () => {
    it('posts form-urlencoded body with apikey header, returns messageId', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'submitted', messageId: 'msg-1' }))

      const result = await sendSessionMessage(CREDS, { type: 'text', text: 'hi' }, '15559998888')

      expect(result).toEqual({ messageId: 'msg-1' })
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.gupshup.io/wa/api/v1/msg')
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
      expect(init.headers.apikey).toBe('test-key')
      const params = new URLSearchParams(init.body)
      expect(params.get('source')).toBe('15550001234')
      expect(params.get('destination')).toBe('15559998888')
      expect(params.get('src.name')).toBe('TestApp')
      expect(JSON.parse(params.get('message')!)).toEqual({ type: 'text', text: 'hi' })
    })

    it('throws ProviderError with auth_error on 401', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { status: 'error', message: 'Authentication Failed' }))
      await expect(sendSessionMessage(CREDS, { type: 'text', text: 'hi' }, '1555')).rejects.toMatchObject({
        code: 'auth_error',
        provider: 'gupshup',
      })
    })

    it('throws ProviderError with invalid_recipient on a destination error', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { status: 'error', message: 'Invalid Destination' }))
      await expect(sendSessionMessage(CREDS, { type: 'text', text: 'hi' }, 'bad')).rejects.toMatchObject({
        code: 'invalid_recipient',
      })
    })

    it('throws ProviderError with rate_limited on 429', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(429, { status: 'error', message: 'Too Many Requests' }))
      await expect(sendSessionMessage(CREDS, { type: 'text', text: 'hi' }, '1555')).rejects.toMatchObject({
        code: 'rate_limited',
        retryable: true,
      })
    })

    it('throws when Gupshup omits messageId on a 2xx', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'submitted' }))
      await expect(sendSessionMessage(CREDS, { type: 'text', text: 'hi' }, '1555')).rejects.toBeInstanceOf(
        ProviderError,
      )
    })
  })

  describe('sendTemplateMessage', () => {
    it('posts template id + params, includes message object when media is set', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(202, { status: 'success', messageId: 'msg-2' }))

      const result = await sendTemplateMessage(CREDS, {
        to: '15559998888',
        templateId: 'tpl-abc',
        params: ['Alice', 'Friday'],
        mediaMessage: { type: 'image', image: { link: 'https://example.com/x.png' } },
      })

      expect(result).toEqual({ messageId: 'msg-2' })
      const [, init] = fetchMock.mock.calls[0]
      const params = new URLSearchParams(init.body)
      expect(JSON.parse(params.get('template')!)).toEqual({ id: 'tpl-abc', params: ['Alice', 'Friday'] })
      expect(JSON.parse(params.get('message')!)).toEqual({
        type: 'image',
        image: { link: 'https://example.com/x.png' },
      })
    })

    it('omits the message field when there is no media header', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(202, { status: 'success', messageId: 'msg-3' }))
      await sendTemplateMessage(CREDS, { to: '1555', templateId: 'tpl', params: [] })
      const [, init] = fetchMock.mock.calls[0]
      const params = new URLSearchParams(init.body)
      expect(params.has('message')).toBe(false)
    })

    it('maps an invalid-template-sounding error to invalid_template', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { status: 'error', message: 'Invalid template id' }))
      await expect(
        sendTemplateMessage(CREDS, { to: '1555', templateId: 'nope', params: [] }),
      ).rejects.toMatchObject({ code: 'invalid_template' })
    })
  })

  describe('listTemplates', () => {
    it('GETs the app template list with apikey header', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          status: 'success',
          templates: [
            { id: 't1', elementName: 'order_update', status: 'APPROVED', category: 'UTILITY', languageCode: 'en', templateType: 'TEXT', data: 'Hi {{1}}' },
          ],
        }),
      )
      const templates = await listTemplates(CREDS)
      expect(templates).toHaveLength(1)
      expect(templates[0].elementName).toBe('order_update')
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.gupshup.io/wa/app/app-1/template')
      expect(init.headers.apikey).toBe('test-key')
    })

    it('returns an empty array when the response has no templates field', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'success' }))
      expect(await listTemplates(CREDS)).toEqual([])
    })
  })

  describe('getBusinessDetails', () => {
    it('unwraps the real, live-confirmed {status, business:{...}} response shape', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { status: 'success', business: { name: 'Acme Inc', contactNumber: '15550001234' } }),
      )
      const details = await getBusinessDetails(CREDS)
      expect(details.name).toBe('Acme Inc')
      const [url] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.gupshup.io/wa/app/app-1/business')
    })

    it('falls back to a flat response shape if Gupshup ever changes back', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { name: 'Acme Inc', contactNumber: '15550001234' }))
      const details = await getBusinessDetails(CREDS)
      expect(details.name).toBe('Acme Inc')
    })

    it('surfaces a 401 as auth_error — this is what powers "Test connection"', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'Authentication Failed' }))
      await expect(getBusinessDetails(CREDS)).rejects.toMatchObject({ code: 'auth_error' })
    })
  })
})
