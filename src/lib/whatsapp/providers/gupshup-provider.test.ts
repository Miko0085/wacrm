import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageTemplate } from '@/types'

const h = vi.hoisted(() => ({
  sendSessionMessage: vi.fn(async (..._args: unknown[]) => ({ messageId: 'msg-1' })),
  sendTemplateMessage: vi.fn(async (..._args: unknown[]) => ({ messageId: 'msg-2' })),
  listTemplates: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  getBusinessDetails: vi.fn(async (..._args: unknown[]) => ({ name: 'Acme' })),
}))

vi.mock('./gupshup-client', () => ({
  sendSessionMessage: h.sendSessionMessage,
  sendTemplateMessage: h.sendTemplateMessage,
  listTemplates: h.listTemplates,
  getBusinessDetails: h.getBusinessDetails,
}))

import { createGupshupProvider } from './gupshup-provider'
import { ProviderError } from './types'

const CREDS = { apiKey: 'k', appId: 'app-1', appName: 'App', sourceNumber: '1555' }

describe('gupshup-provider', () => {
  beforeEach(() => {
    h.sendSessionMessage.mockClear()
    h.sendTemplateMessage.mockClear()
  })

  it('testConnection delegates to getBusinessDetails and reports connected on success', async () => {
    const provider = createGupshupProvider(CREDS)
    const result = await provider.testConnection()
    expect(result).toEqual({ connected: true, details: { name: 'Acme' } })
  })

  it('testConnection reports disconnected (not throw) when Gupshup rejects the credentials', async () => {
    h.getBusinessDetails.mockRejectedValueOnce(new ProviderError('gupshup', 'auth_error', 'Authentication Failed'))
    const provider = createGupshupProvider(CREDS)
    const result = await provider.testConnection()
    expect(result.connected).toBe(false)
    expect(result.message).toMatch(/Authentication Failed/)
  })

  it('sendText builds a text session message with previewUrl', async () => {
    const provider = createGupshupProvider(CREDS)
    await provider.sendText({ to: '1666', text: 'hello' })
    expect(h.sendSessionMessage).toHaveBeenCalledWith(
      CREDS,
      { type: 'text', text: 'hello', previewUrl: true },
      '1666',
    )
  })

  it('sendMedia builds the audio message with no caption field, matching Meta\'s audio restriction', async () => {
    const provider = createGupshupProvider(CREDS)
    await provider.sendMedia({ to: '1666', kind: 'audio', link: 'https://x/a.ogg', caption: 'ignored' })
    const [, message] = h.sendSessionMessage.mock.calls[0]
    expect(message).toEqual({ type: 'audio', url: 'https://x/a.ogg' })
  })

  it('sendMedia builds a document message with filename + caption', async () => {
    const provider = createGupshupProvider(CREDS)
    await provider.sendMedia({ to: '1666', kind: 'document', link: 'https://x/f.pdf', filename: 'invoice.pdf', caption: 'here' })
    const [, message] = h.sendSessionMessage.mock.calls[0]
    expect(message).toEqual({ type: 'file', url: 'https://x/f.pdf', filename: 'invoice.pdf', caption: 'here' })
  })

  it('sendTemplate throws invalid_template when the local row has no gupshup_template_id', async () => {
    const provider = createGupshupProvider(CREDS)
    await expect(
      provider.sendTemplate({ to: '1666', templateName: 'order_update', params: ['A'] }),
    ).rejects.toMatchObject({ code: 'invalid_template' })
    expect(h.sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('sendTemplate sends the Gupshup template id + params when the row is synced', async () => {
    const provider = createGupshupProvider(CREDS)
    const template = { gupshup_template_id: 'gs-tpl-1' } as MessageTemplate
    await provider.sendTemplate({ to: '1666', templateName: 'order_update', params: ['Alice'], template })
    expect(h.sendTemplateMessage).toHaveBeenCalledWith(CREDS, {
      to: '1666',
      templateId: 'gs-tpl-1',
      params: ['Alice'],
      mediaMessage: undefined,
    })
  })

  it('sendTemplate attaches a media message for an image-header template', async () => {
    const provider = createGupshupProvider(CREDS)
    const template = {
      gupshup_template_id: 'gs-tpl-2',
      header_type: 'image',
      header_media_url: 'https://x/header.png',
    } as MessageTemplate
    await provider.sendTemplate({ to: '1666', templateName: 'promo', params: [], template })
    const call = h.sendTemplateMessage.mock.calls[0][1] as { mediaMessage: unknown }
    expect(call.mediaMessage).toEqual({ type: 'image', image: { link: 'https://x/header.png' } })
  })

  it('sendInteractive (buttons) maps to a quick_reply message capped at Gupshup\'s option shape', async () => {
    const provider = createGupshupProvider(CREDS)
    await provider.sendInteractive({
      to: '1666',
      payload: {
        kind: 'buttons',
        bodyText: 'Pick one',
        buttons: [{ id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }],
      },
    })
    const [, message] = h.sendSessionMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'quick_reply',
      content: { type: 'text', text: 'Pick one' },
      options: [{ title: 'Yes', postbackText: 'yes' }, { title: 'No', postbackText: 'no' }],
    })
  })

  it('sendInteractive (list) maps sections/rows to items/options', async () => {
    const provider = createGupshupProvider(CREDS)
    await provider.sendInteractive({
      to: '1666',
      payload: {
        kind: 'list',
        bodyText: 'Choose',
        buttonLabel: 'Open',
        sections: [{ title: 'Group', rows: [{ id: 'r1', title: 'Row 1', description: 'd' }] }],
      },
    })
    const [, message] = h.sendSessionMessage.mock.calls[0]
    expect(message).toMatchObject({
      type: 'list',
      body: 'Choose',
      globalButtons: [{ type: 'text', title: 'Open' }],
      items: [{ title: 'Group', options: [{ type: 'text', title: 'Row 1', description: 'd', postbackText: 'r1' }] }],
    })
  })

  it('has no submitTemplate/editTemplate/deleteTemplate — Gupshup template lifecycle is out of scope for this integration', () => {
    const provider = createGupshupProvider(CREDS)
    expect(provider.submitTemplate).toBeUndefined()
    expect(provider.editTemplate).toBeUndefined()
    expect(provider.deleteTemplate).toBeUndefined()
  })
})
