import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  addContactTags,
  ContactError,
  findOrCreateContact,
  getContactById,
  resolveAuditUserId,
  updateContactFields,
} from '@/lib/api/v1/contacts';

const MAX_BATCH = 500;

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const items = body && Array.isArray(body.contacts) ? body.contacts : null;
    if (!items) return fail('bad_request', "'contacts' must be an array", 400);
    if (items.length === 0) return ok({ items: [], created: 0, matched: 0 });
    if (items.length > MAX_BATCH) {
      return fail('bad_request', `'contacts' may contain at most ${MAX_BATCH} items`, 400);
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const result: Array<Record<string, unknown>> = [];
    let createdCount = 0;

    for (let index = 0; index < items.length; index += 1) {
      const raw = items[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail('bad_request', `contacts[${index}] must be an object`, 400);
      }
      const item = raw as Record<string, unknown>;
      const phone = stringOrUndefined(item.phone);
      if (!phone) return fail('bad_request', `contacts[${index}].phone is required`, 400);

      const name = stringOrUndefined(item.name);
      const email = stringOrUndefined(item.email);
      const company = stringOrUndefined(item.company);
      const tagsAdd = Array.isArray(item.tags_add)
        ? item.tags_add.filter((v): v is string => typeof v === 'string')
        : [];

      const { id, created } = await findOrCreateContact(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        { phone, name, email, company }
      );
      if (created) createdCount += 1;
      else await updateContactFields(ctx.supabase, ctx.accountId, id, { name, email, company });

      if (tagsAdd.length > 0) {
        await addContactTags(ctx.supabase, ctx.accountId, auditUserId, id, tagsAdd);
      }

      const contact = await getContactById(ctx.supabase, ctx.accountId, id);
      result.push({
        index,
        id,
        phone: contact?.phone ?? phone,
        created,
        tags: contact?.tags ?? [],
      });
    }

    return ok({
      items: result,
      created: createdCount,
      matched: result.length - createdCount,
    });
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(err.status === 400 ? 'bad_request' : 'internal', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
