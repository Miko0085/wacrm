import type { SupabaseClient } from '@supabase/supabase-js'

export interface BusinessEventInput {
  accountId: string
  userId?: string | null
  contactId?: string | null
  conversationId?: string | null
  eventType: string
  source?: string
  payload?: Record<string, unknown>
  /** Automation->event chain depth; 0 (default) for root events. */
  chainDepth?: number
}

export async function recordBusinessEvent(
  db: SupabaseClient,
  input: BusinessEventInput,
): Promise<{ id: string }> {
  const eventType = input.eventType.trim()
  if (!eventType) throw new Error('business event type is required')
  if (eventType.length > 128) throw new Error('business event type is too long')

  const source = input.source?.trim() || 'system'
  if (source.length > 64) throw new Error('business event source is too long')

  const payload = input.payload ?? {}
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (payloadBytes > 64 * 1024) throw new Error('business event payload exceeds 64 KiB')

  const { data, error } = await db
    .from('business_events')
    .insert({
      account_id: input.accountId,
      user_id: input.userId ?? null,
      contact_id: input.contactId ?? null,
      conversation_id: input.conversationId ?? null,
      event_type: eventType,
      source,
      payload,
      // Only sent when non-zero so root events keep working before 058 lands.
      ...(input.chainDepth ? { chain_depth: input.chainDepth } : {}),
    })
    .select('id')
    .single()

  if (error || !data?.id) {
    throw new Error(error?.message ?? 'business event insert failed')
  }

  return { id: data.id as string }
}
