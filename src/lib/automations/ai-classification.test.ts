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
  it('accepts legacy JSON and normalizes it into AI Decision fields', () => {
    const raw = `\`\`\`json
{"intent":"positive","score":87,"qualified":true,"language":"ru","summary":"Interested","reason":"Asked for options"}
\`\`\``

    expect(parseAiClassificationResult(raw)).toEqual({
      intent: 'positive',
      score: 87,
      qualified: true,

      intents: ['positive_interest'],
      primary_intent: 'positive_interest',
      confidence: 87,
      requires_human: false,
      safe_to_answer: true,
      extracted: {},

      language: 'ru',
      summary: 'Interested',
      reason: 'Asked for options',
    })
  })

  it('accepts rich multi-intent AI Decision JSON', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 94,
        qualified: true,

        intents: ['qualification_answer', 'expert_question'],
        primary_intent: 'expert_question',
        confidence: 96,
        requires_human: true,
        safe_to_answer: false,
        extracted: {
          purpose: 'investment',
          budget: 2000000,
          currency: 'AED',
          mortgage: true,
        },

        language: 'en',
        summary: 'Investment buyer asks about expected rental yield.',
        reason: 'Qualification data plus a specialist investment question.',
      }),
    )

    expect(result).toEqual({
      intent: 'positive',
      score: 94,
      qualified: true,

      intents: ['qualification_answer', 'expert_question'],
      primary_intent: 'expert_question',
      confidence: 96,
      requires_human: true,
      safe_to_answer: false,
      extracted: {
        purpose: 'investment',
        budget: 2000000,
        currency: 'AED',
        mortgage: true,
      },

      language: 'en',
      summary: 'Investment buyer asks about expected rental yield.',
      reason: 'Qualification data plus a specialist investment question.',
    })
  })

  it('adds primary_intent to intents when the model omitted it from the array', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 85,
        qualified: true,

        intents: ['qualification_answer'],
        primary_intent: 'expert_question',
        confidence: 90,
        requires_human: true,
        safe_to_answer: false,
        extracted: {
          purpose: 'investment',
        },

        language: 'en',
        summary: '',
        reason: '',
      }),
    )

    expect(result.intents).toEqual([
      'expert_question',
      'qualification_answer',
    ])
  })

  it('derives safe human defaults when optional rich fields are omitted', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 82,
        qualified: true,

        intents: ['expert_question'],
        primary_intent: 'expert_question',
        confidence: 88,

        language: 'en',
        summary: 'Customer asks a specialist question.',
        reason: 'Needs case-specific knowledge.',
      }),
    )

    expect(result.requires_human).toBe(true)
    expect(result.safe_to_answer).toBe(false)
    expect(result.extracted).toEqual({})
  })

  it('rejects malformed or invalid structured output', () => {
    expect(() =>
      parseAiClassificationResult('not json'),
    ).toThrow('valid JSON')

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

  it('rejects invalid rich intents', () => {
    expect(() =>
      parseAiClassificationResult(
        JSON.stringify({
          intent: 'positive',
          score: 80,
          qualified: true,

          intents: ['made_up_intent'],
          primary_intent: 'positive_interest',
          confidence: 80,

          language: 'en',
          summary: '',
          reason: '',
        }),
      ),
    ).toThrow('invalid intent')
  })

  it('rejects nested extracted values', () => {
    expect(() =>
      parseAiClassificationResult(
        JSON.stringify({
          intent: 'positive',
          score: 80,
          qualified: true,

          intents: ['qualification_answer'],
          primary_intent: 'qualification_answer',
          confidence: 80,
          requires_human: false,
          safe_to_answer: true,
          extracted: {
            budget: {
              amount: 2000000,
              currency: 'AED',
            },
          },

          language: 'en',
          summary: '',
          reason: '',
        }),
      ),
    ).toThrow('primitive value')
  })
})

describe('classificationTakesYesBranch', () => {
  it('keeps legacy qualified positive routing to YES', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 87,
        qualified: true,
        language: 'ru',
        summary: 'Interested',
        reason: 'Asked for options',
      }),
    )

    expect(
      classificationTakesYesBranch(result, config),
    ).toBe(true)
  })

  it('keeps legacy neutral and low-score routing to NO', () => {
    const neutral = parseAiClassificationResult(
      JSON.stringify({
        intent: 'neutral',
        score: 80,
        qualified: true,
        language: 'ru',
        summary: '',
        reason: '',
      }),
    )

    const lowScore = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 59,
        qualified: true,
        language: 'en',
        summary: '',
        reason: '',
      }),
    )

    expect(
      classificationTakesYesBranch(neutral, config),
    ).toBe(false)

    expect(
      classificationTakesYesBranch(lowScore, config),
    ).toBe(false)
  })

  it('always routes legacy opt-out to NO', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'opt_out',
        score: 100,
        qualified: true,
        language: 'ru',
        summary: 'Do not contact',
        reason: 'STOP',
      }),
    )

    expect(
      classificationTakesYesBranch(result, config),
    ).toBe(false)
  })
})

describe('classifyAutomationMessage', () => {
  it('retries once after malformed JSON and returns the second valid decision', async () => {
    generateReplyMock
      .mockResolvedValueOnce({
        text: 'bad-json',
        handoff: false,
        usage: null,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          intent: 'positive',
          score: 91,
          qualified: true,

          intents: ['request_selection'],
          primary_intent: 'request_selection',
          confidence: 95,
          requires_human: false,
          safe_to_answer: true,
          extracted: {},

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
    expect(result.primary_intent).toBe('request_selection')
    expect(result.confidence).toBe(95)
  })

  it('fails after two malformed responses', async () => {
    generateReplyMock.mockResolvedValue({
      text: 'not-json',
      handoff: false,
      usage: null,
    })

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
  it('preserves legacy vars and exposes rich AI Decision vars', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 94,
        qualified: true,

        intents: [
          'qualification_answer',
          'expert_question',
        ],
        primary_intent: 'expert_question',
        confidence: 96,
        requires_human: true,
        safe_to_answer: false,
        extracted: {
          purpose: 'investment',
          budget: 2000000,
          currency: 'AED',
        },

        language: 'en',
        summary: 'Investment buyer asks about expected yield.',
        reason: 'Needs specialist input.',
      }),
    )

    expect(classificationVars(result)).toEqual({
      // Legacy
      ai_intent: 'positive',
      ai_score: 94,
      ai_qualified: true,

      // Rich decision
      ai_intents: 'qualification_answer,expert_question',
      ai_primary_intent: 'expert_question',
      ai_confidence: 96,
      ai_requires_human: true,
      ai_safe_to_answer: false,
      ai_extracted:
        '{"purpose":"investment","budget":2000000,"currency":"AED"}',

      ai_language: 'en',
      ai_summary: 'Investment buyer asks about expected yield.',
      ai_reason: 'Needs specialist input.',

      // Flattened extracted values
      ai_extracted_purpose: 'investment',
      ai_extracted_budget: 2000000,
      ai_extracted_currency: 'AED',
    })
  })

  it('sanitizes extracted keys before exposing them as vars', () => {
    const result = parseAiClassificationResult(
      JSON.stringify({
        intent: 'positive',
        score: 80,
        qualified: true,

        intents: ['qualification_answer'],
        primary_intent: 'qualification_answer',
        confidence: 80,
        requires_human: false,
        safe_to_answer: true,
        extracted: {
          'target market': 'Dubai',
          'budget-aed': 2500000,
        },

        language: 'en',
        summary: '',
        reason: '',
      }),
    )

    const vars = classificationVars(result)

    expect(vars.ai_extracted_target_market).toBe('Dubai')
    expect(vars.ai_extracted_budget_aed).toBe(2500000)
  })
})
