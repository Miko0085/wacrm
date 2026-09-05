// ============================================================
// WhatsApp marketing-consent enforcement.
//
// A contact can be reached for transactional/conversational purposes
// (agent replies, Utility/Authentication templates, automations/flows
// answering something they asked) even after opting out of marketing —
// that's what "marketing opt-out" means under WhatsApp's own template
// categories. What must be hard-blocked, everywhere, regardless of who
// asks (dashboard composer, public API, MCP via the public API,
// automations), is a MARKETING-category template going to an
// OPTED_OUT contact. Broadcasts already enforce this (broadcast-core.ts,
// the dashboard broadcast route, broadcast-resume.ts); this module is
// the same check for the two remaining template-send paths: the manual/
// public-API send (send-message.ts) and the automations engine's
// send_template action (automations/meta-send.ts).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export class MarketingSuppressedError extends Error {
  constructor(contactId: string) {
    super(
      `Contact ${contactId} has opted out of WhatsApp marketing messages — this Marketing-category template cannot be sent to them.`,
    )
    this.name = 'MarketingSuppressedError'
  }
}

/**
 * Throws {@link MarketingSuppressedError} when `category` is
 * `'Marketing'` and the contact's `wa_marketing_status` is
 * `'OPTED_OUT'`. A no-op for every other category (Utility,
 * Authentication, or an unset/local-only template row) and for a
 * contact whose status is `OPTED_IN` or `UNKNOWN` (the default —
 * matches existing behavior for every account that predates the
 * consent model).
 */
export async function assertMarketingAllowed(
  db: SupabaseClient,
  contactId: string,
  category: string | null | undefined,
): Promise<void> {
  if (category !== 'Marketing') return

  const { data: contact } = await db
    .from('contacts')
    .select('wa_marketing_status')
    .eq('id', contactId)
    .maybeSingle()

  if (contact?.wa_marketing_status === 'OPTED_OUT') {
    throw new MarketingSuppressedError(contactId)
  }
}
