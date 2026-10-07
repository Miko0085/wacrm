import { describe, it, expect } from 'vitest'
import { interpolateTemplate, type AutomationContext } from './engine'

function render(template: string, context: AutomationContext, contactId: string | null = 'c-1') {
  return interpolateTemplate(template, { contactId, context })
}

const HOSTILE = [
  ['double quotes', 'He said "call me"'],
  ['newline', 'line1\nline2\r\nline3'],
  ['backslash', 'C:\\temp\\new and \\" escaped'],
  ['unicode', 'Привет 👋 — 你好 — \u2028 line-sep'],
  ['control chars', 'tab\there \u0001 bell'],
  ['json-looking', '{"injected": true}, "x": '],
] as const

describe('interpolateTemplate — legacy raw syntax is unchanged', () => {
  const context: AutomationContext = {
    message_text: 'hi there',
    conversation_id: 'conv-1',
    vars: { ai_primary_intent: 'purchase', n: 5 },
    business_event_id: 'ev-1',
    business_event_type: 'human_handoff_requested',
    business_event_payload: { reason: 'request_call', nested: { a: 1 } },
  }

  it.each([
    ['{{message.text}}', 'hi there'],
    ['{{contact.id}}', 'c-1'],
    ['{{conversation.id}}', 'conv-1'],
    ['{{vars.ai_primary_intent}}', 'purchase'],
    ['{{ vars.n }}', '5'],
    ['{{event.id}}', 'ev-1'],
    ['{{event.type}}', 'human_handoff_requested'],
    ['{{event.reason}}', 'request_call'],
    ['{{event.payload}}', '{"reason":"request_call","nested":{"a":1}}'],
    ['{{vars.missing}}', ''],
    ['{{nope.what}}', ''],
  ])('%s', (tpl, expected) => {
    expect(render(tpl, context)).toBe(expected)
  })

  it('raw substitution of a quote DOES break JSON — the reason json.* exists', () => {
    const out = render('{"reason":"{{event.reason}}"}', {
      business_event_payload: { reason: 'He said "call me"' },
    })
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('interpolateTemplate — {{json.*}} is always valid JSON', () => {
  it.each(HOSTILE)('event payload value with %s round-trips exactly', (_label, value) => {
    const out = render('{"reason":{{json.event.reason}},"id":{{json.event.id}}}', {
      business_event_id: 'ev-1',
      business_event_payload: { reason: value },
    })
    expect(JSON.parse(out)).toEqual({ reason: value, id: 'ev-1' })
  })

  it.each(HOSTILE)('customer message text with %s round-trips exactly', (_label, value) => {
    const out = render('{"text":{{json.message.text}}}', { message_text: value })
    expect(JSON.parse(out)).toEqual({ text: value })
  })

  it.each(HOSTILE)('vars value with %s round-trips exactly', (_label, value) => {
    const out = render('{"v":{{json.vars.foo}}}', { vars: { foo: value } })
    expect(JSON.parse(out)).toEqual({ v: value })
  })

  it('keeps native JSON types for vars and whole payloads', () => {
    const out = render('{"n":{{json.vars.n}},"ok":{{json.vars.ok}},"p":{{json.event.payload}}}', {
      vars: { n: 42, ok: true },
      business_event_payload: { a: [1, 2] },
    })
    expect(JSON.parse(out)).toEqual({ n: 42, ok: true, p: { a: [1, 2] } })
  })

  it('missing values become an empty JSON string, never invalid JSON', () => {
    const out = render('{"a":{{json.vars.nope}},"b":{{json.event.nope}},"c":{{json.contact.id}}}', {}, null)
    expect(JSON.parse(out)).toEqual({ a: '', b: '', c: '' })
  })

  it('a bare {{json}} yields null rather than breaking the document', () => {
    expect(JSON.parse(render('{"x":{{json}}}', {}))).toEqual({ x: null })
  })

  it('can be mixed with legacy placeholders for ids that are always safe', () => {
    const out = render('{"c":"{{contact.id}}","r":{{json.event.reason}}}', {
      business_event_payload: { reason: 'a "b"' },
    })
    expect(JSON.parse(out)).toEqual({ c: 'c-1', r: 'a "b"' })
  })
})
