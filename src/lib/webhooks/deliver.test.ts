import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

// Control the SSRF guard per-test.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { dispatchWebhookEvent, MAX_CONSECUTIVE_FAILURES } from './deliver';
import { isDeliverableUrl } from './ssrf';

interface Row {
  id: string;
  url: string;
  secret: string;
}
interface Calls {
  updates: { id: string; payload: Record<string, unknown> }[];
  rpcs: { name: string; args: Record<string, unknown> }[];
}

function makeDb(rows: Row[], calls: Calls, conversationContactId = 'contact-1') {
  const from = (table: string) => {
    let mode: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    let id: string | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: string) => {
        if (col === 'id') id = val;
        return b;
      },
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return b;
      },
      contains: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () =>
        Promise.resolve({
          data:
            table === 'conversations'
              ? { contact_id: conversationContactId }
              : null,
          error: null,
        }),
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update' && id) calls.updates.push({ id, payload });
        return resolve({ data: null, error: null });
      },
    };
    return b;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.rpcs.push({ name, args });
    return Promise.resolve({ data: null, error: null });
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const emptyCalls = (): Calls => ({ updates: [], rpcs: [] });

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs (no redirect follow) and resets failure_count on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'a', url: 'https://a.test/hook', secret: 's1' }], calls),
      'acct-1',
      'message.received',
      { x: 1 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // Payload carries a dedupe id.
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);
    expect(calls.updates[0]).toMatchObject({ id: 'a', payload: { failure_count: 0 } });
    expect(calls.rpcs).toHaveLength(0);
  });

  it.each(['pending', 'sent', 'delivered', 'read', 'failed'] as const)(
    'adds the owning WACRM contact_id to message.status_updated (%s)',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
      vi.stubGlobal('fetch', fetchMock);
      const calls = emptyCalls();

      await dispatchWebhookEvent(
        makeDb([{ id: 'status-hook', url: 'https://crm.test/hook', secret: 's1' }], calls, 'contact-42'),
        'acct-1',
        'message.status_updated',
        {
          whatsapp_message_id: 'wamid.42',
          conversation_id: 'conversation-42',
          status,
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.event).toBe('message.status_updated');
      expect(body.data).toEqual({
        whatsapp_message_id: 'wamid.42',
        conversation_id: 'conversation-42',
        status,
        contact_id: 'contact-42',
      });
    },
  );

  it('keeps contact_id stable across repeated status deliveries for the same conversation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();
    const db = makeDb(
      [{ id: 'status-hook', url: 'https://crm.test/hook', secret: 's1' }],
      calls,
      'contact-stable',
    );

    for (const status of ['delivered', 'read'] as const) {
      await dispatchWebhookEvent(db, 'acct-1', 'message.status_updated', {
        whatsapp_message_id: 'wamid.same',
        conversation_id: 'conversation-same',
        status,
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(payloads[0].data.contact_id).toBe('contact-stable');
    expect(payloads[1].data.contact_id).toBe('contact-stable');
  });

  it('records an atomic failure (RPC) when the endpoint errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'b', url: 'https://b.test/hook', secret: 's2' }], calls),
      'acct-1',
      'message.received',
      {}
    );

    expect(calls.rpcs[0]).toEqual({
      name: 'record_webhook_failure',
      args: { endpoint_id: 'b', max_failures: MAX_CONSECUTIVE_FAILURES },
    });
    expect(calls.updates).toHaveLength(0);
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }], calls),
      'acct-1',
      'message.received',
      {}
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs[0].name).toBe('record_webhook_failure');
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();
    await dispatchWebhookEvent(makeDb([], calls), 'acct-1', 'message.received', {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });
});
