import type { SupabaseClient } from '@supabase/supabase-js'

export interface BusinessEventInput {
  accountId: string
  userId?: string | null
  contactId?: string | null
  conversationId?: string | null
  eventType: string
  source?: string
  payload?: Record<string, unknown>
}

export async function recordBusinessEvent(
  db: SupabaseClient,
  input: BusinessEventInput,
): Promise<{ id: string }> {
  const eventType = input.eventType.trim()
  if (!eventType) throw new Error('business event type is required')

  const { data, error } = await db
    .from('business_events')
    .insert({
      account_id: input.accountId,
      user_id: input.userId ?? null,
      contact_id: input.contactId ?? null,
      conversation_id: input.conversationId ?? null,
      event_type: eventType,
      source: input.source?.trim() || 'system',
      payload: input.payload ?? {},
    })
    .select('id')
    .single()

  if (error || !data?.id) {
    throw new Error(error?.message ?? 'business event insert failed')
  }

  return { id: data.id as string }
}
