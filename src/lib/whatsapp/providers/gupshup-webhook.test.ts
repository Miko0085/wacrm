import { describe, it, expect } from 'vitest'
import {
  isValidGupshupEnvelope,
  normalizeGupshupInboundMessage,
  normalizeGupshupStatusEvent,
  normalizeGupshupUserEvent,
} from './gupshup-webhook'

describe('isValidGupshupEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isValidGupshupEnvelope({ type: 'message', payload: {} })).toBe(true)
  })
  it('rejects garbage, missing type, or missing payload', () => {
    expect(isValidGupshupEnvelope(null)).toBe(false)
    expect(isValidGupshupEnvelope('a string')).toBe(false)
    expect(isValidGupshupEnvelope({ payload: {} })).toBe(false)
    expect(isValidGupshupEnvelope({ type: 'message' })).toBe(false)
  })
})

describe('normalizeGupshupInboundMessage', () => {
  const base = {
    app: 'TestApp',
    timestamp: 1700000000000,
    version: 2,
    type: 'message',
  }

  it('normalizes a text message', () => {
    const result = normalizeGupshupInboundMessage({
      ...base,
      payload: {
        id: 'wamid.abc',
        source: '15551234567',
        type: 'text',
        payload: { text: 'Hello there' },
        sender: { phone: '15551234567', name: 'Alice' },
      },
    })
    expect(result).toMatchObject({
      providerMessageId: 'wamid.abc',
      fromPhone: '15551234567',
      contactName: 'Alice',
      contentType: 'text',
      contentText: 'Hello there',
    })
  })

  it('normalizes an image with caption and maps to content_type image', () => {
    const result = normalizeGupshupInboundMessage({
      ...base,
      payload: {
        id: 'wamid.img',
        source: '1555',
        type: 'image',
        payload: { url: 'https://cdn.example.com/a.jpg', contentType: 'image/jpeg', caption: 'nice' },
        sender: { phone: '1555' },
      },
    })
    expect(result).toMatchObject({
      contentType: 'image',
      mediaUrl: 'https://cdn.example.com/a.jpg',
      mediaType: 'image/jpeg',
      contentText: 'nice',
    })
  })

  it('maps a Gupshup "file" type onto the shared "document" content type', () => {
    const result = normalizeGupshupInboundMessage({
      ...base,
      payload: {
        id: 'wamid.doc',
        source: '1555',
        type: 'file',
        payload: { url: 'https://cdn.example.com/f.pdf', filename: 'invoice.pdf' },
        sender: { phone: '1555' },
      },
    })
    expect(result?.contentType).toBe('document')
    expect(result?.contentText).toBe('invoice.pdf')
  })

  it('normalizes a button_reply tap into an interactive reply', () => {
    const result = normalizeGupshupInboundMessage({
      ...base,
      payload: {
        id: 'wamid.btn',
        source: '1555',
        type: 'button_reply',
        payload: { id: 'opt-1', title: 'Yes please' },
        sender: { phone: '1555' },
      },
    })
    expect(result).toMatchObject({
      contentType: 'interactive',
      interactiveReplyId: 'opt-1',
      contentText: 'Yes please',
    })
  })

  it('carries the reply-context id through for a quoted reply', () => {
    const result = normalizeGupshupInboundMessage({
      ...base,
      payload: {
        id: 'wamid.reply',
        source: '1555',
        type: 'text',
        payload: { text: 'yes' },
        sender: { phone: '1555' },
        context: { id: 'wamid.parent' },
      },
    })
    expect(result?.replyToProviderMessageId).toBe('wamid.parent')
  })

  it('returns null for a message type with no mapping, so the caller logs unsupported_provider_event', () => {
    const result = normalizeGupshupInboundMessage({
      ...base,
      payload: { id: 'wamid.x', source: '1555', type: 'contact', payload: {}, sender: { phone: '1555' } },
    })
    expect(result).toBeNull()
  })

  it('returns null when required envelope fields are missing', () => {
    expect(normalizeGupshupInboundMessage({ ...base, payload: {} })).toBeNull()
  })
})

describe('normalizeGupshupStatusEvent', () => {
  it('normalizes a sent DLR event, preferring gsId for correlation', () => {
    const result = normalizeGupshupStatusEvent({
      type: 'message-event',
      timestamp: 1700000000000,
      payload: { id: 'gBEG...', gsId: 'gs-123', type: 'sent', destination: '1555', payload: { ts: 1585344475 } },
    })
    expect(result).toEqual({ providerMessageId: 'gs-123', status: 'sent', timestampMs: 1585344475000 })
  })

  it('normalizes an enqueued event, falling back to id when there is no gsId', () => {
    const result = normalizeGupshupStatusEvent({
      type: 'message-event',
      payload: { id: 'gs-enqueued-1', type: 'enqueued', destination: '1555' },
    })
    expect(result).toMatchObject({ providerMessageId: 'gs-enqueued-1', status: 'pending' })
  })

  it('returns null for an unmapped status type (e.g. deleted)', () => {
    const result = normalizeGupshupStatusEvent({
      type: 'message-event',
      payload: { id: 'gs-1', gsId: 'gs-1', type: 'deleted', destination: '1555' },
    })
    expect(result).toBeNull()
  })
})

describe('normalizeGupshupUserEvent', () => {
  it('normalizes opted-in and opted-out', () => {
    expect(
      normalizeGupshupUserEvent({ type: 'user-event', payload: { phone: '15551234567', type: 'opted-in' } }),
    ).toEqual({ phone: '15551234567', type: 'opted-in' })
    expect(
      normalizeGupshupUserEvent({ type: 'user-event', payload: { phone: '15551234567', type: 'opted-out' } }),
    ).toEqual({ phone: '15551234567', type: 'opted-out' })
  })

  it('returns null for a malformed payload', () => {
    expect(normalizeGupshupUserEvent({ type: 'user-event', payload: { phone: '1555' } })).toBeNull()
    expect(normalizeGupshupUserEvent({ type: 'user-event', payload: { type: 'opted-in' } })).toBeNull()
  })
})
