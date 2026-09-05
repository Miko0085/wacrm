import { describe, it, expect } from 'vitest'
import { normalizeGupshupMessageEventType, normalizeGupshupTemplateStatus } from './gupshup-status-map'

describe('normalizeGupshupMessageEventType', () => {
  it('maps enqueued to the pre-send pending state', () => {
    expect(normalizeGupshupMessageEventType('enqueued')).toBe('pending')
  })
  it('maps the DLR ladder 1:1', () => {
    expect(normalizeGupshupMessageEventType('sent')).toBe('sent')
    expect(normalizeGupshupMessageEventType('delivered')).toBe('delivered')
    expect(normalizeGupshupMessageEventType('read')).toBe('read')
  })
  it('maps failed to failed', () => {
    expect(normalizeGupshupMessageEventType('failed')).toBe('failed')
  })
  it('returns null for deleted and unknown types — caller logs and skips, never crashes', () => {
    expect(normalizeGupshupMessageEventType('deleted')).toBeNull()
    expect(normalizeGupshupMessageEventType('some_future_type')).toBeNull()
  })
})

describe('normalizeGupshupTemplateStatus', () => {
  it('maps Submitted to PENDING', () => {
    expect(normalizeGupshupTemplateStatus('Submitted')).toBe('PENDING')
    expect(normalizeGupshupTemplateStatus('SUBMITTED')).toBe('PENDING')
  })
  it('maps Approved / Rejected / Paused straight across', () => {
    expect(normalizeGupshupTemplateStatus('Approved')).toBe('APPROVED')
    expect(normalizeGupshupTemplateStatus('Rejected')).toBe('REJECTED')
    expect(normalizeGupshupTemplateStatus('Paused')).toBe('PAUSED')
  })
  it('maps Gupshup-side Failed onto REJECTED (no closer terminal-negative slot)', () => {
    expect(normalizeGupshupTemplateStatus('Failed')).toBe('REJECTED')
  })
  it('maps Deactivated onto DISABLED', () => {
    expect(normalizeGupshupTemplateStatus('Deactivated')).toBe('DISABLED')
  })
  it('falls back to PENDING for an unrecognized status rather than dropping the row', () => {
    expect(normalizeGupshupTemplateStatus('SOMETHING_NEW')).toBe('PENDING')
  })
})
