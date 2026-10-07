-- 057_orchestration_hardening.sql
-- Production hardening for durable inbound debounce + business-event delivery.

-- ---------------------------------------------------------------------------
-- Inbound debounce leases / retries / dead-lettering.
-- ---------------------------------------------------------------------------
ALTER TABLE inbound_debounce_jobs
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE inbound_debounce_jobs
  DROP CONSTRAINT IF EXISTS inbound_debounce_jobs_status_check;

ALTER TABLE inbound_debounce_jobs
  ADD CONSTRAINT inbound_debounce_jobs_status_check
  CHECK (status IN ('pending', 'running', 'dead'));

CREATE INDEX IF NOT EXISTS idx_inbound_debounce_running_lease
  ON inbound_debounce_jobs(locked_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_inbound_debounce_dead
  ON inbound_debounce_jobs(updated_at)
  WHERE status = 'dead';

-- Recreate the queue RPC so a new customer message always revives/resets the
-- conversation job, including jobs that previously reached dead-letter state.
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
    run_at,
    locked_at,
    attempt_count,
    last_error
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
    NOW() + make_interval(secs => v_delay),
    NULL,
    0,
    NULL
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
    locked_at = NULL,
    attempt_count = 0,
    last_error = NULL,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION queue_inbound_debounce(UUID, UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_inbound_debounce(UUID, UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, INTEGER)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Durable business-event outbox.
--
-- Delivery is intentionally at-least-once. Downstream webhook consumers should
-- use business_events.id as their idempotency key.
-- ---------------------------------------------------------------------------
ALTER TABLE business_events
  ADD COLUMN IF NOT EXISTS dispatch_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispatch_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Rows created before this migration were already handled synchronously by the
-- legacy runtime. Mark them delivered so deployment does not replay historical
-- handoffs. New rows created after the migration keep the DEFAULT 'pending'.
UPDATE business_events
SET dispatch_status = 'dispatched',
    dispatched_at = COALESCE(dispatched_at, created_at)
WHERE dispatch_status = 'pending'
  AND dispatch_attempts = 0
  AND dispatched_at IS NULL;

ALTER TABLE business_events
  DROP CONSTRAINT IF EXISTS business_events_dispatch_status_check;

ALTER TABLE business_events
  ADD CONSTRAINT business_events_dispatch_status_check
  CHECK (dispatch_status IN ('pending', 'running', 'dispatched', 'dead'));

CREATE INDEX IF NOT EXISTS idx_business_events_dispatch_due
  ON business_events(dispatch_after, created_at)
  WHERE dispatch_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_business_events_dispatch_running
  ON business_events(locked_at)
  WHERE dispatch_status = 'running';

-- Retention indexes used by ops cleanup jobs.
CREATE INDEX IF NOT EXISTS idx_business_events_created_at
  ON business_events(created_at);

CREATE INDEX IF NOT EXISTS idx_inbound_debounce_created_at
  ON inbound_debounce_jobs(created_at);


-- Corporate integrations must survive deletion of the user who originally
-- created them. Ownership is account-scoped; created_by is audit metadata.
ALTER TABLE telegram_connections
  ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE telegram_connections
  DROP CONSTRAINT IF EXISTS telegram_connections_created_by_fkey;

ALTER TABLE telegram_connections
  ADD CONSTRAINT telegram_connections_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


-- Tie automation executions to durable business events. Successful deliveries
-- are unique per (automation,event), allowing failed events to retry without
-- repeating automations that already completed.
ALTER TABLE automation_logs
  ADD COLUMN IF NOT EXISTS business_event_id UUID REFERENCES business_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_automation_logs_business_event
  ON automation_logs(business_event_id)
  WHERE business_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_event_success_once
  ON automation_logs(automation_id, business_event_id)
  WHERE business_event_id IS NOT NULL AND status = 'success';
