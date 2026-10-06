import type { SupabaseClient } from '@supabase/supabase-js'

export interface BusinessEventInput {
  accountId: string
  userId?: string | null
  eventType: string
  contactId?: string | null
  conversationId?: string | null
  source: 'automation' | 'flow' | 'ai' | 'system'
  payload?: Record<string, unknown>
}

export async function persistBusinessEvent(
  db: SupabaseClient,
  input: BusinessEventInput,
): Promise<{ id: string; event_type: string }> {
  const eventType = input.eventType.trim()
  if (!eventType) throw new Error('business event type is required')

  const { data, error } = await db
    .from('business_events')
    .insert({
      account_id: input.accountId,
      user_id: input.userId ?? null,
      event_type: eventType,
      contact_id: input.contactId ?? null,
      conversation_id: input.conversationId ?? null,
      source: input.source,
      payload: input.payload ?? {},
    })
    .select('id, event_type')
    .single()

  if (error || !data) {
    throw new Error(`business event insert failed: ${error?.message ?? 'unknown error'}`)
  }

  return {
    id: data.id as string,
    event_type: data.event_type as string,
  }
}
