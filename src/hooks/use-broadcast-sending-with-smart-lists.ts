'use client';

import { createClient } from '@/lib/supabase/client';
import {
  useBroadcastSending,
  type AudienceConfig,
  type VariableMapping,
} from '@/hooks/use-broadcast-sending';
import type { Contact, MessageTemplate } from '@/types';

export type SmartBroadcastAudience = AudienceConfig | {
  type: 'smart_list';
  smartListId: string;
  smartListName?: string;
};

interface SmartBroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: SmartBroadcastAudience;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

export function useBroadcastSendingWithSmartLists() {
  const base = useBroadcastSending();

  async function createAndSendBroadcast(payload: SmartBroadcastPayload): Promise<string> {
    if (payload.audience.type !== 'smart_list') {
      return base.createAndSendBroadcast({
        ...payload,
        audience: payload.audience,
      });
    }

    const supabase = createClient();
    const PAGE_SIZE = 500;
    let offset = 0;
    const contacts: Contact[] = [];

    while (true) {
      const { data, error } = await supabase.rpc('resolve_smart_list_contacts', {
        p_smart_list_id: payload.audience.smartListId,
        p_limit: PAGE_SIZE,
        p_offset: offset,
      });
      if (error) {
        throw new Error(`Failed to resolve Smart List: ${error.message}`);
      }

      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contacts.push(...rows.map((row) => row.contact));
      if (rows.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (contacts.length === 0) {
      throw new Error('This Smart List currently has no contacts.');
    }

    // The base sender already has the battle-tested recipient creation,
    // retry/rate-limit, template-variable and analytics flow. Feed the
    // resolved live membership through its CSV path so we reuse that code
    // instead of maintaining a second send engine. Existing contacts are
    // matched by normalized phone and are not duplicated.
    const broadcastId = await base.createAndSendBroadcast({
      ...payload,
      audience: {
        type: 'csv',
        csvContacts: contacts
          .filter((contact) => Boolean(contact.phone))
          .map((contact) => ({ phone: contact.phone, name: contact.name })),
      },
    });

    // Preserve the semantic audience in the broadcast record. Membership
    // was resolved at send time; this metadata tells operators which Smart
    // List produced the recipient snapshot without changing recipient rows.
    await supabase
      .from('broadcasts')
      .update({
        audience_filter: {
          type: 'smart_list',
          smartListId: payload.audience.smartListId,
          smartListName: payload.audience.smartListName ?? null,
          resolvedCount: contacts.length,
          resolvedAt: new Date().toISOString(),
        },
      })
      .eq('id', broadcastId);

    return broadcastId;
  }

  return {
    ...base,
    createAndSendBroadcast,
  };
}
