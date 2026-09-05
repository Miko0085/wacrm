-- ============================================================
-- Fix: create_broadcast_with_recipients (migration 037) has always
-- raised "column reference contact_id is ambiguous" against a real
-- Postgres engine -- the function's RETURNS TABLE(..., contact_id
-- uuid) declares an implicit PL/pgSQL variable named contact_id, which
-- collides with the bare `contact_id` in the nested INSERT's RETURNING
-- clause. This was never caught because broadcast-core.test.ts mocks
-- the .rpc() boundary and never executes the real SQL against a real
-- database -- found during the Gupshup integration's live E2E pass
-- (see docs/GUPSHUP_TEST_REPORT.md) while testing createBroadcast
-- against a real local Supabase instance. Affects EVERY account
-- (Meta or Gupshup) that creates a broadcast through
-- POST /api/v1/broadcasts or the resume path -- unrelated to which
-- WhatsApp provider is connected.
--
-- Fix: alias the RETURNING column so it never collides with the
-- function's own output-parameter name, then select it back out under
-- its original name in the outer query. No signature change --
-- callers (broadcast-core.ts) keep reading `contact_id` from the
-- result set exactly as before.
--
-- Idempotent (CREATE OR REPLACE) — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION create_broadcast_with_recipients(
  p_account_id UUID,
  p_user_id UUID,
  p_name TEXT,
  p_template_name TEXT,
  p_template_language TEXT,
  p_total_recipients INT,
  p_contact_ids UUID[],
  p_template_params JSONB[]
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  -- Two-array unnest pairs each contact with its params positionally.
  -- A shorter params array pads with NULL, which the resume path reads
  -- as "no params" — the same as a pre-038 row.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    -- Table-qualified AND aliased: the bare `contact_id` on the read
    -- side of RETURNING is ambiguous against the function's own
    -- `contact_id` OUT parameter (RETURNS TABLE implicitly declares it
    -- as a PL/pgSQL variable in scope for the whole function body) —
    -- qualifying with the target table name resolves which one is
    -- meant; the alias then keeps the outer SELECT unambiguous too.
    RETURNING id, broadcast_recipients.contact_id AS recipient_contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.recipient_contact_id
  FROM ins;
END;
$$;
