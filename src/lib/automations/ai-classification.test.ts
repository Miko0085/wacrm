import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiClassificationStepConfig } from '@/types'

const { loadAiConfigMock, generateReplyMock } = vi.hoisted(() => ({
  loadAiConfigMock: vi.fn(),
  generateReplyMock: vi.fn(),
}))

vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: loadAiConfigMock,
}))

vi.mock('@/lib/ai/generate', () => ({
  generateReply: generateReplyMock,
}))

import {
  classifyAutomationMessage,
  classificationTakesYesBranch,
  classificationVars,
  parseAiClassificationResult,
} from './ai-classification'

const config: AiClassificationStepConfig = {
  instruction: 'Classify interest',
  input_template: '{{message.text}}',
  context_messages: 5,
  positive_intent: 'positive',
  min_score: 60,
}

beforeEach(() => {
  vi.clearAllMocks()
  loadAiConfigMock.mockResolvedValue({
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
  })
})

describe('parseAiClassificationResult', () => {
  it('accepts strict JSON and markdown JSON fences', () => {
    const raw = `\`\`\`json
{"intent":"positive","score":87,"qualified":true,"language":"ru","summary":"Interested","reason":"Asked for options"}
\`\`\``
    expect(parseAiClassificationResult(raw)).toEqual({
      intent: 'positive',
      score: 87,
      qualified: true,
      language: 'ru',
      summary: 'Interested',
      reason: 'Asked for options',
    })
  })

  it('rejects malformed or invalid structured output', () => {
    expect(() => parseAiClassificationResult('not json')).toThrow('valid JSON')
    expect(() =>
      parseAiClassificationResult(
        JSON.stringify({
          intent: 'maybe',
          score: 50,
          qualified: false,
          language: 'en',
          summary: '',
          reason: '',
        }),
      ),
    ).toThrow('intent is invalid')
    expect(() =>
      parseAiClassificationResult(
        JSON.stringify({
          intent: 'positive',
          score: 101,
          qualified: true,
          language: 'en',
          summary: '',
          reason: '',
        }),
      ),
    ).toThrow('score')
  })
})

describe('classificationTakesYesBranch', () => {
  it('routes a qualified positive result to YES', () => {
    expect(
      classificationTakesYesBranch(
        {
          intent: 'positive',
          score: 87,
          qualified: true,
          language: 'ru',
          summary: 'Interested',
          reason: 'Asked for options',
        },
        config,
      ),
    ).toBe(true)
  })

  it('routes neutral/negative/low-score results to NO', () => {
    expect(
      classificationTakesYesBranch(
        {
          intent: 'neutral',
          score: 80,
          qualified: true,
          language: 'ru',
          summary: '',
          reason: '',
        },
        config,
      ),
    ).toBe(false)
    expect(
      classificationTakesYesBranch(
        {
          intent: 'positive',
          score: 59,
          qualified: true,
          language: 'en',
          summary: '',
          reason: '',
        },
        config,
      ),
    ).toBe(false)
  })

  it('always routes opt-out to NO regardless of score', () => {
    expect(
      classificationTakesYesBranch(
        {
          intent: 'opt_out',
          score: 100,
          qualified: true,
          language: 'ru',
          summary: 'Do not contact',
          reason: 'STOP',
        },
        config,
      ),
    ).toBe(false)
  })
})

describe('classifyAutomationMessage', () => {
  it('retries once after malformed JSON and returns the second valid result', async () => {
    generateReplyMock
      .mockResolvedValueOnce({ text: 'bad-json', handoff: false, usage: null })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          intent: 'positive',
          score: 91,
          qualified: true,
          language: 'en',
          summary: 'Wants available options',
          reason: 'Explicit request',
        }),
        handoff: false,
        usage: null,
      })

    const result = await classifyAutomationMessage({
      db: {} as never,
      accountId: 'account-1',
      messageText: 'Yes, send me the available options',
      config,
    })

    expect(generateReplyMock).toHaveBeenCalledTimes(2)
    expect(result.intent).toBe('positive')
    expect(result.score).toBe(91)
  })

  it('fails after two malformed responses', async () => {
    generateReplyMock.mockResolvedValue({ text: 'not-json', handoff: false, usage: null })

    await expect(
      classifyAutomationMessage({
        db: {} as never,
        accountId: 'account-1',
        messageText: 'Да, пришлите варианты и цены',
        config,
      }),
    ).rejects.toThrow('after retry')
    expect(generateReplyMock).toHaveBeenCalledTimes(2)
  })

  it('fails clearly when AI is not configured', async () => {
    loadAiConfigMock.mockResolvedValue(null)

    await expect(
      classifyAutomationMessage({
        db: {} as never,
        accountId: 'account-1',
        messageText: 'Hello',
        config,
      }),
    ).rejects.toThrow('AI Agents → Setup')
    expect(generateReplyMock).not.toHaveBeenCalled()
  })
})

describe('classificationVars', () => {
  it('exposes structured values for later webhook interpolation', () => {
    expect(
      classificationVars({
        intent: 'positive',
        score: 87,
        qualified: true,
        language: 'ru',
        summary: 'Interested',
        reason: 'Asked for prices',
      }),
    ).toEqual({
      ai_intent: 'positive',
      ai_score: 87,
      ai_qualified: true,
      ai_language: 'ru',
      ai_summary: 'Interested',
      ai_reason: 'Asked for prices',
    })
  })
})
