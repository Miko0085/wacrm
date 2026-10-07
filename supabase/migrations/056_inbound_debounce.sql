-- 056_inbound_debounce.sql
-- Durable 30-45s inbound text aggregation before Flow/Automation/AI decisioning.

CREATE TABLE IF NOT EXISTS inbound_debounce_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  text_parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_first_inbound BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running')),
  run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_debounce_due
  ON inbound_debounce_jobs(run_at)
  WHERE status = 'pending';

ALTER TABLE inbound_debounce_jobs ENABLE ROW LEVEL SECURITY;
-- Service-role only. No authenticated write policy.

CREATE OR REPLACE FUNCTION queue_inbound_debounce(
  p_account_id UUID,
  p_user_id UUID,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_message_id TEXT,
  p_text TEXT,
  p_is_first_inbound BOOLEAN,
  p_delay_seconds INTEGER DEFAULT 35
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_delay INTEGER := GREATEST(1, LEAST(COALESCE(p_delay_seconds, 35), 300));
BEGIN
  INSERT INTO inbound_debounce_jobs (
    account_id,
    user_id,
    contact_id,
    conversation_id,
    message_ids,
    text_parts,
    is_first_inbound,
    version,
    status,
    run_at
  )
  VALUES (
    p_account_id,
    p_user_id,
    p_contact_id,
    p_conversation_id,
    jsonb_build_array(p_message_id),
    jsonb_build_array(p_text),
    p_is_first_inbound,
    1,
    'pending',
    NOW() + make_interval(secs => v_delay)
  )
  ON CONFLICT (conversation_id) DO UPDATE SET
    account_id = EXCLUDED.account_id,
    user_id = EXCLUDED.user_id,
    contact_id = EXCLUDED.contact_id,
    message_ids = CASE
      WHEN inbound_debounce_jobs.status = 'running'
        THEN EXCLUDED.message_ids
      ELSE inbound_debounce_jobs.message_ids || EXCLUDED.message_ids
    END,
    text_parts = CASE
      WHEN inbound_debounce_jobs.status = 'running'
        THEN EXCLUDED.text_parts
      ELSE inbound_debounce_jobs.text_parts || EXCLUDED.text_parts
    END,
    is_first_inbound = CASE
      WHEN inbound_debounce_jobs.status = 'running'
        THEN EXCLUDED.is_first_inbound
      ELSE inbound_debounce_jobs.is_first_inbound OR EXCLUDED.is_first_inbound
    END,
    version = inbound_debounce_jobs.version + 1,
    status = 'pending',
    run_at = NOW() + make_interval(secs => v_delay),
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION queue_inbound_debounce(UUID, UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_inbound_debounce(UUID, UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, INTEGER)
  TO service_role;
