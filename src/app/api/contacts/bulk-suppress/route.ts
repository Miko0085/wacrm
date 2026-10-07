import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

interface Body {
  contact_ids?: string[] | null;
  all_matching?: boolean;
  filter_tag_ids?: string[] | null;
  search?: string | null;
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const body = (await request.json()) as Body;

    const { data: resolved, error: resolveError } = await supabase.rpc(
      'resolve_bulk_contact_ids',
      {
        p_account_id: accountId,
        p_contact_ids: body.all_matching ? null : (body.contact_ids ?? []),
        p_all_matching: Boolean(body.all_matching),
        p_filter_tag_ids: body.filter_tag_ids?.length ? body.filter_tag_ids : null,
        p_search: body.search?.trim() || null,
      },
    );
    if (resolveError) throw resolveError;

    const ids = (resolved ?? []) as string[];
    if (ids.length === 0) {
      return NextResponse.json({ success: true, changed: 0, contact_ids: [] });
    }

    const admin = supabaseAdmin();
    const nowIso = new Date().toISOString();
    const changedIds: string[] = [];
    const chunkSize = 500;

    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const { data: changed, error } = await admin
        .from('contacts')
        .update({
          wa_marketing_status: 'OPTED_OUT',
          wa_opt_out_at: nowIso,
          wa_consent_source: 'wacrm_bulk_dnc',
          updated_at: nowIso,
        })
        .eq('account_id', accountId)
        .in('id', chunk)
        .neq('wa_marketing_status', 'OPTED_OUT')
        .select('id');

      if (error) throw error;
      changedIds.push(...((changed ?? []) as { id: string }[]).map((row) => row.id));
    }

    // Use the same event envelope/data contract as provider-side opt-outs so
    // the already configured nika-ghl-amocrm webhook path receives manual
    // bulk DNC changes too. Delivery is best-effort by design.
    await Promise.allSettled(
      changedIds.map((contactId) =>
        dispatchWebhookEvent(admin, accountId, 'contact.opted_out', {
          contact_id: contactId,
          status: 'OPTED_OUT',
          source: 'wacrm_bulk_dnc',
          occurred_at: nowIso,
        }),
      ),
    );

    return NextResponse.json({
      success: true,
      changed: changedIds.length,
      contact_ids: changedIds,
    });
  } catch (error) {
    console.error('[contacts/bulk-suppress] failed:', error);
    return toErrorResponse(error);
  }
}
