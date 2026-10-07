-- 058_production_orchestration_hardening.sql
-- Additive, replay-safe follow-up to 053-057. Never edits already-deployed
-- migrations.
--
--   1. Lease / retry / dead-letter columns for automation_pending_executions
--      (the wait scheduler had none, unlike debounce + business events).
--   2. business_events.chain_depth for event-loop protection.
--   3. Retention helper for the operational queues.
--   4. Transactional "managed object" RPCs used by the Nika seed so a graph
--      replacement can never be observed half-applied.

-- ---------------------------------------------------------------------------
-- 1. Automation wait scheduler leases.
-- ---------------------------------------------------------------------------
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;

ALTER TABLE automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead'));

CREATE INDEX IF NOT EXISTS idx_automation_pending_running_lease
  ON automation_pending_executions(locked_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_automation_pending_terminal
  ON automation_pending_executions(created_at)
  WHERE status IN ('done', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- 2. Business-event chain depth (automation -> emit_business_event -> ...).
-- ---------------------------------------------------------------------------
ALTER TABLE business_events
  ADD COLUMN IF NOT EXISTS chain_depth INTEGER NOT NULL DEFAULT 0;

-- Dead-letter lookups: ops dashboards, cron stats and retention scan these.
CREATE INDEX IF NOT EXISTS idx_business_events_dead
  ON business_events(created_at)
  WHERE dispatch_status = 'dead';

-- ---------------------------------------------------------------------------
-- 3. Retention for operational queues. Batched so a large backlog never turns
--    into one long-running DELETE. Service-role only.
--
--    business_events:           dispatched rows after p_dispatched_days,
--                               dead rows only after the (longer) p_dead_event_days
--    inbound_debounce_jobs:     dead rows after p_dead_debounce_days
--    automation_pending_exec.:  done rows after p_dispatched_days
--
--    automation_logs retention is intentionally NOT touched here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cleanup_orchestration_data(
  p_dispatched_days INTEGER DEFAULT 30,
  p_dead_event_days INTEGER DEFAULT 90,
  p_dead_debounce_days INTEGER DEFAULT 14,
  p_batch INTEGER DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch INTEGER := GREATEST(1, LEAST(COALESCE(p_batch, 1000), 10000));
  v_events INTEGER := 0;
  v_dead_events INTEGER := 0;
  v_debounce INTEGER := 0;
  v_pending INTEGER := 0;
BEGIN
  WITH doomed AS (
    SELECT id FROM business_events
    WHERE dispatch_status = 'dispatched'
      AND dispatched_at < NOW() - make_interval(days => GREATEST(1, p_dispatched_days))
    ORDER BY dispatched_at
    LIMIT v_batch
  )
  DELETE FROM business_events b USING doomed d WHERE b.id = d.id;
  GET DIAGNOSTICS v_events = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM business_events
    WHERE dispatch_status = 'dead'
      AND created_at < NOW() - make_interval(days => GREATEST(7, p_dead_event_days))
    ORDER BY created_at
    LIMIT v_batch
  )
  DELETE FROM business_events b USING doomed d WHERE b.id = d.id;
  GET DIAGNOSTICS v_dead_events = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM inbound_debounce_jobs
    WHERE status = 'dead'
      AND updated_at < NOW() - make_interval(days => GREATEST(1, p_dead_debounce_days))
    ORDER BY updated_at
    LIMIT v_batch
  )
  DELETE FROM inbound_debounce_jobs j USING doomed d WHERE j.id = d.id;
  GET DIAGNOSTICS v_debounce = ROW_COUNT;

  WITH doomed AS (
    SELECT id FROM automation_pending_executions
    WHERE status = 'done'
      AND created_at < NOW() - make_interval(days => GREATEST(1, p_dispatched_days))
    ORDER BY created_at
    LIMIT v_batch
  )
  DELETE FROM automation_pending_executions p USING doomed d WHERE p.id = d.id;
  GET DIAGNOSTICS v_pending = ROW_COUNT;

  RETURN jsonb_build_object(
    'business_events_dispatched', v_events,
    'business_events_dead', v_dead_events,
    'inbound_debounce_dead', v_debounce,
    'automation_pending_done', v_pending
  );
END;
$$;

REVOKE ALL ON FUNCTION cleanup_orchestration_data(INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_orchestration_data(INTEGER, INTEGER, INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Managed flow / automation upserts (single transaction each).
--
-- "Managed" means the object's description carries an explicit marker such as
--   [NIKA_MANAGED:flow_property_selection_v1]
-- An object that merely shares a NAME with a managed one is never modified.
-- A function body is one transaction: any error rolls the whole replacement
-- back, so live traffic observes either the old graph or the new one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_managed_flow(
  p_account_id UUID,
  p_user_id UUID,
  p_marker TEXT,
  p_flow JSONB,
  p_nodes JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_flow_id UUID;
  v_active_runs INTEGER;
  v_entry TEXT := p_flow->>'entry_node_id';
BEGIN
  IF p_marker IS NULL OR p_marker !~ '^\[NIKA_MANAGED:[A-Za-z0-9_]+\]$' THEN
    RAISE EXCEPTION 'invalid managed marker: %', p_marker;
  END IF;
  IF jsonb_typeof(p_nodes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_nodes) = 0 THEN
    RAISE EXCEPTION 'managed flow requires at least one node';
  END IF;
  IF v_entry IS NULL OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_nodes) n WHERE n->>'node_key' = v_entry
  ) THEN
    RAISE EXCEPTION 'entry_node_id % is not among the supplied nodes', v_entry;
  END IF;

  SELECT id INTO v_flow_id
  FROM flows
  WHERE account_id = p_account_id
    AND position(p_marker IN COALESCE(description, '')) > 0
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE;

  IF v_flow_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_active_runs
    FROM flow_runs WHERE flow_id = v_flow_id AND status = 'active';
    IF v_active_runs > 0 THEN
      RAISE EXCEPTION 'managed flow % has % active run(s); refusing to replace', v_flow_id, v_active_runs;
    END IF;

    UPDATE flows SET
      name = p_flow->>'name',
      description = p_flow->>'description',
      status = p_flow->>'status',
      trigger_type = p_flow->>'trigger_type',
      trigger_config = COALESCE(p_flow->'trigger_config', '{}'::jsonb),
      entry_node_id = v_entry,
      fallback_policy = COALESCE(p_flow->'fallback_policy', fallback_policy),
      updated_at = NOW()
    WHERE id = v_flow_id;

    DELETE FROM flow_nodes WHERE flow_id = v_flow_id;
  ELSE
    INSERT INTO flows (
      account_id, user_id, name, description, status, trigger_type,
      trigger_config, entry_node_id, fallback_policy
    )
    VALUES (
      p_account_id,
      p_user_id,
      p_flow->>'name',
      p_flow->>'description',
      p_flow->>'status',
      p_flow->>'trigger_type',
      COALESCE(p_flow->'trigger_config', '{}'::jsonb),
      v_entry,
      COALESCE(
        p_flow->'fallback_policy',
        '{"on_exhaust": "handoff", "max_reprompts": 2, "on_timeout_hours": 24, "on_unknown_reply": "reprompt"}'::jsonb
      )
    )
    RETURNING id INTO v_flow_id;
  END IF;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  SELECT
    v_flow_id,
    n->>'node_key',
    n->>'node_type',
    COALESCE(n->'config', '{}'::jsonb),
    COALESCE((n->>'position_x')::INTEGER, 0),
    COALESCE((n->>'position_y')::INTEGER, 0)
  FROM jsonb_array_elements(p_nodes) n;

  RETURN v_flow_id;
END;
$$;

REVOKE ALL ON FUNCTION upsert_managed_flow(UUID, UUID, TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_managed_flow(UUID, UUID, TEXT, JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION upsert_managed_automation(
  p_account_id UUID,
  p_user_id UUID,
  p_marker TEXT,
  p_automation JSONB,
  p_steps JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_marker IS NULL OR p_marker !~ '^\[NIKA_MANAGED:[A-Za-z0-9_]+\]$' THEN
    RAISE EXCEPTION 'invalid managed marker: %', p_marker;
  END IF;
  IF jsonb_typeof(p_steps) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_steps must be a JSON array';
  END IF;

  SELECT id INTO v_id
  FROM automations
  WHERE account_id = p_account_id
    AND position(p_marker IN COALESCE(description, '')) > 0
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    UPDATE automations SET
      name = p_automation->>'name',
      description = p_automation->>'description',
      trigger_type = p_automation->>'trigger_type',
      trigger_config = COALESCE(p_automation->'trigger_config', '{}'::jsonb),
      is_active = COALESCE((p_automation->>'is_active')::BOOLEAN, FALSE),
      updated_at = NOW()
    WHERE id = v_id;
    DELETE FROM automation_steps WHERE automation_id = v_id;
  ELSE
    INSERT INTO automations (
      account_id, user_id, name, description, trigger_type, trigger_config, is_active
    )
    VALUES (
      p_account_id,
      p_user_id,
      p_automation->>'name',
      p_automation->>'description',
      p_automation->>'trigger_type',
      COALESCE(p_automation->'trigger_config', '{}'::jsonb),
      COALESCE((p_automation->>'is_active')::BOOLEAN, FALSE)
    )
    RETURNING id INTO v_id;
  END IF;

  -- One statement: the parent_step_id self-FK is checked at statement end, so
  -- parent/child row order inside p_steps does not matter.
  INSERT INTO automation_steps (
    id, automation_id, parent_step_id, branch, step_type, step_config, position
  )
  SELECT
    (s->>'id')::UUID,
    v_id,
    NULLIF(s->>'parent_step_id', '')::UUID,
    NULLIF(s->>'branch', ''),
    s->>'step_type',
    COALESCE(s->'step_config', '{}'::jsonb),
    (s->>'position')::INTEGER
  FROM jsonb_array_elements(p_steps) s;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION upsert_managed_automation(UUID, UUID, TEXT, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_managed_automation(UUID, UUID, TEXT, JSONB, JSONB) TO service_role;
