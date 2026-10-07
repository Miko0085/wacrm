-- Behavioural assertions for the orchestration layer (migrations 053-058).
--
-- verify-schema.sql proves the objects EXIST. This file proves they BEHAVE:
-- debounce queue semantics, outbox idempotency, retention, and the managed
-- seed RPCs. Like verify-schema.sql it must stay ONE statement (a single DO
-- block): `supabase db query --file` rejects multi-statement files. All
-- fixtures are created inside a sub-transaction that is rolled back at the
-- end, so the file leaves the database untouched.
--
-- Run locally:  psql -v ON_ERROR_STOP=1 -f supabase/ci/orchestration-behavior.sql

DO $$
DECLARE
  v_user UUID := uuid_generate_v4();
  v_account UUID;
  v_contact UUID;
  v_conv UUID;
  v_job UUID;
  r inbound_debounce_jobs%ROWTYPE;
  v_n INTEGER;
  v_ev UUID;
  v_ev_dead UUID;
  v_ev_old_dead UUID;
  v_auto UUID;
  v_flow UUID;
  v_flow2 UUID;
  v_flow_again UUID;
  v_auto_again UUID;
  v_cleanup JSONB;
  v_marker TEXT := '[NIKA_MANAGED:flow_behavior_test_v1]';
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (v_user, 'behavior-' || v_user || '@example.test');
    INSERT INTO accounts (name, owner_user_id) VALUES ('behavior-test', v_user)
      RETURNING id INTO v_account;
    INSERT INTO contacts (user_id, account_id, phone) VALUES (v_user, v_account, '+10000000001')
      RETURNING id INTO v_contact;
    INSERT INTO conversations (user_id, account_id, contact_id) VALUES (v_user, v_account, v_contact)
      RETURNING id INTO v_conv;

    -- ---------------------------------------------------------------
    -- Debounce: aggregation.
    -- ---------------------------------------------------------------
    v_job := queue_inbound_debounce(v_account, v_user, v_contact, v_conv, 'wamid.1', 'first', TRUE, 35);
    PERFORM queue_inbound_debounce(v_account, v_user, v_contact, v_conv, 'wamid.2', 'second', FALSE, 35);
    SELECT * INTO r FROM inbound_debounce_jobs WHERE conversation_id = v_conv;
    IF r.version <> 2 OR r.status <> 'pending'
       OR r.text_parts <> '["first","second"]'::jsonb
       OR r.is_first_inbound IS NOT TRUE THEN
      RAISE EXCEPTION 'debounce aggregation broken: %', row_to_json(r);
    END IF;

    -- ---------------------------------------------------------------
    -- Debounce: a message arriving while a worker holds version N.
    -- ---------------------------------------------------------------
    UPDATE inbound_debounce_jobs
      SET status = 'running', locked_at = NOW(), attempt_count = 3, last_error = 'boom'
      WHERE id = v_job;
    PERFORM queue_inbound_debounce(v_account, v_user, v_contact, v_conv, 'wamid.3', 'third', FALSE, 35);
    SELECT * INTO r FROM inbound_debounce_jobs WHERE id = v_job;
    IF r.version <> 3 OR r.status <> 'pending' OR r.locked_at IS NOT NULL
       OR r.attempt_count <> 0 OR r.last_error IS NOT NULL
       OR r.text_parts <> '["third"]'::jsonb
       OR r.run_at <= NOW() THEN
      RAISE EXCEPTION 'running->superseded reset broken: %', row_to_json(r);
    END IF;

    -- The old worker (version 2) finishing must NOT delete version 3.
    DELETE FROM inbound_debounce_jobs WHERE id = v_job AND version = 2 AND status = 'running';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 OR NOT EXISTS (SELECT 1 FROM inbound_debounce_jobs WHERE id = v_job AND version = 3) THEN
      RAISE EXCEPTION 'stale worker deleted a newer debounce version';
    END IF;

    -- ---------------------------------------------------------------
    -- Debounce: dead job is revived by a new customer message.
    -- ---------------------------------------------------------------
    UPDATE inbound_debounce_jobs
      SET status = 'dead', attempt_count = 5, last_error = 'gave up', locked_at = NULL
      WHERE id = v_job;
    PERFORM queue_inbound_debounce(v_account, v_user, v_contact, v_conv, 'wamid.4', 'fourth', FALSE, 35);
    SELECT * INTO r FROM inbound_debounce_jobs WHERE id = v_job;
    IF r.version <> 4 OR r.status <> 'pending' OR r.attempt_count <> 0
       OR r.last_error IS NOT NULL OR r.locked_at IS NOT NULL
       OR NOT (r.text_parts @> '["fourth"]'::jsonb) THEN
      RAISE EXCEPTION 'dead debounce job was not revived with the new text: %', row_to_json(r);
    END IF;

    -- CHECK constraint accepts exactly the documented states.
    BEGIN
      UPDATE inbound_debounce_jobs SET status = 'bogus' WHERE id = v_job;
      RAISE EXCEPTION 'debounce status CHECK did not reject bogus';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- ---------------------------------------------------------------
    -- Business-event outbox defaults + per-(automation,event) success unique.
    -- ---------------------------------------------------------------
    INSERT INTO business_events (account_id, contact_id, conversation_id, event_type)
      VALUES (v_account, v_contact, v_conv, 'human_handoff_requested')
      RETURNING id INTO v_ev;
    IF (SELECT dispatch_status FROM business_events WHERE id = v_ev) <> 'pending'
       OR (SELECT chain_depth FROM business_events WHERE id = v_ev) <> 0 THEN
      RAISE EXCEPTION 'new business events must start pending at depth 0';
    END IF;

    INSERT INTO automations (account_id, user_id, name, trigger_type, is_active)
      VALUES (v_account, v_user, 'behavior-auto', 'business_event', TRUE)
      RETURNING id INTO v_auto;
    INSERT INTO automation_logs (automation_id, account_id, user_id, trigger_event, status, business_event_id)
      VALUES (v_auto, v_account, v_user, 'business_event', 'success', v_ev);
    BEGIN
      INSERT INTO automation_logs (automation_id, account_id, user_id, trigger_event, status, business_event_id)
        VALUES (v_auto, v_account, v_user, 'business_event', 'success', v_ev);
      RAISE EXCEPTION 'a second success log for the same (automation,event) was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- failed attempts may repeat freely
    INSERT INTO automation_logs (automation_id, account_id, user_id, trigger_event, status, business_event_id)
      VALUES (v_auto, v_account, v_user, 'business_event', 'failed', v_ev);

    -- ---------------------------------------------------------------
    -- Wait scheduler lease columns + dead state.
    -- ---------------------------------------------------------------
    INSERT INTO automation_pending_executions
      (automation_id, account_id, user_id, next_step_position, status, run_at, locked_at, attempt_count)
      VALUES (v_auto, v_account, v_user, 1, 'dead', NOW(), NULL, 5);

    -- ---------------------------------------------------------------
    -- Retention: old dispatched + very old dead go; recent + young dead stay.
    -- ---------------------------------------------------------------
    INSERT INTO business_events (account_id, event_type, dispatch_status, dispatched_at, created_at)
      VALUES (v_account, 'old_done', 'dispatched', NOW() - INTERVAL '40 days', NOW() - INTERVAL '41 days');
    INSERT INTO business_events (account_id, event_type, dispatch_status, dispatched_at)
      VALUES (v_account, 'fresh_done', 'dispatched', NOW());
    INSERT INTO business_events (account_id, event_type, dispatch_status, created_at)
      VALUES (v_account, 'young_dead', 'dead', NOW() - INTERVAL '10 days')
      RETURNING id INTO v_ev_dead;
    INSERT INTO business_events (account_id, event_type, dispatch_status, created_at)
      VALUES (v_account, 'old_dead', 'dead', NOW() - INTERVAL '120 days')
      RETURNING id INTO v_ev_old_dead;

    v_cleanup := cleanup_orchestration_data(30, 90, 14, 1000);
    IF EXISTS (SELECT 1 FROM business_events WHERE account_id = v_account AND event_type IN ('old_done', 'old_dead'))
       OR NOT EXISTS (SELECT 1 FROM business_events WHERE id = v_ev_dead)
       OR NOT EXISTS (SELECT 1 FROM business_events WHERE account_id = v_account AND event_type = 'fresh_done') THEN
      RAISE EXCEPTION 'retention deleted the wrong rows: %', v_cleanup;
    END IF;

    -- ---------------------------------------------------------------
    -- Managed flow: create, idempotent re-apply, isolation, active-run guard,
    -- atomic rollback on a bad graph.
    -- ---------------------------------------------------------------
    v_flow := upsert_managed_flow(
      v_account, v_user, v_marker,
      jsonb_build_object('name', 'Managed', 'description', 'desc ' || v_marker,
        'status', 'active', 'trigger_type', 'manual', 'entry_node_id', 'start'),
      '[{"node_key":"start","node_type":"start","config":{"next_node_key":"end"}},
        {"node_key":"end","node_type":"end","config":{}}]'::jsonb);
    v_flow_again := upsert_managed_flow(
      v_account, v_user, v_marker,
      jsonb_build_object('name', 'Managed v2', 'description', 'desc ' || v_marker,
        'status', 'active', 'trigger_type', 'manual', 'entry_node_id', 'start'),
      '[{"node_key":"start","node_type":"start","config":{"next_node_key":"end"}},
        {"node_key":"mid","node_type":"send_message","config":{"text":"hi","next_node_key":"end"}},
        {"node_key":"end","node_type":"end","config":{}}]'::jsonb);
    IF v_flow_again <> v_flow
       OR (SELECT COUNT(*) FROM flows WHERE account_id = v_account AND description LIKE '%' || v_marker || '%') <> 1
       OR (SELECT COUNT(*) FROM flow_nodes WHERE flow_id = v_flow) <> 3
       OR (SELECT name FROM flows WHERE id = v_flow) <> 'Managed v2' THEN
      RAISE EXCEPTION 'managed flow upsert is not idempotent';
    END IF;

    -- A different marker never touches the first flow.
    v_flow2 := upsert_managed_flow(
      v_account, v_user, '[NIKA_MANAGED:flow_other_v1]',
      jsonb_build_object('name', 'Other', 'description', '[NIKA_MANAGED:flow_other_v1]',
        'status', 'draft', 'trigger_type', 'manual', 'entry_node_id', 'start'),
      '[{"node_key":"start","node_type":"start","config":{}}]'::jsonb);
    IF v_flow2 = v_flow OR (SELECT COUNT(*) FROM flow_nodes WHERE flow_id = v_flow) <> 3 THEN
      RAISE EXCEPTION 'a different managed marker modified an unrelated flow';
    END IF;

    -- Bad graph (entry missing) raises and leaves the live graph intact.
    BEGIN
      PERFORM upsert_managed_flow(
        v_account, v_user, v_marker,
        jsonb_build_object('name', 'Broken', 'description', v_marker,
          'status', 'active', 'trigger_type', 'manual', 'entry_node_id', 'nope'),
        '[{"node_key":"start","node_type":"start","config":{}}]'::jsonb);
      RAISE EXCEPTION 'bad managed graph was accepted';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'bad managed graph was accepted' THEN RAISE; END IF;
    END;
    IF (SELECT COUNT(*) FROM flow_nodes WHERE flow_id = v_flow) <> 3 THEN
      RAISE EXCEPTION 'failed managed replacement damaged the live graph';
    END IF;

    -- Active run blocks replacement.
    INSERT INTO flow_runs (flow_id, user_id, account_id, contact_id, conversation_id, status, current_node_key)
      VALUES (v_flow, v_user, v_account, v_contact, v_conv, 'active', 'start');
    BEGIN
      PERFORM upsert_managed_flow(
        v_account, v_user, v_marker,
        jsonb_build_object('name', 'Blocked', 'description', v_marker,
          'status', 'active', 'trigger_type', 'manual', 'entry_node_id', 'start'),
        '[{"node_key":"start","node_type":"start","config":{}}]'::jsonb);
      RAISE EXCEPTION 'replacement allowed with an active run';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM LIKE 'replacement allowed%' THEN RAISE; END IF;
    END;

    -- ---------------------------------------------------------------
    -- Managed automation with a nested branch.
    -- ---------------------------------------------------------------
    v_auto := upsert_managed_automation(
      v_account, v_user, '[NIKA_MANAGED:auto_behavior_v1]',
      jsonb_build_object('name', 'Managed auto', 'description', '[NIKA_MANAGED:auto_behavior_v1]',
        'trigger_type', 'business_event', 'trigger_config', '{"event_types":["x"]}'::jsonb,
        'is_active', TRUE),
      jsonb_build_array(
        jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-000000000001', 'step_type', 'condition',
          'position', 0, 'step_config', '{}'::jsonb),
        jsonb_build_object('id', 'aaaaaaaa-0000-0000-0000-000000000002', 'step_type', 'add_tag',
          'parent_step_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'branch', 'yes',
          'position', 0, 'step_config', '{}'::jsonb)));
    v_auto_again := upsert_managed_automation(
      v_account, v_user, '[NIKA_MANAGED:auto_behavior_v1]',
      jsonb_build_object('name', 'Managed auto', 'description', '[NIKA_MANAGED:auto_behavior_v1]',
        'trigger_type', 'business_event', 'is_active', FALSE),
      jsonb_build_array(
        jsonb_build_object('id', 'bbbbbbbb-0000-0000-0000-000000000001', 'step_type', 'send_webhook',
          'position', 0, 'step_config', '{}'::jsonb)));
    IF v_auto_again <> v_auto
       OR (SELECT COUNT(*) FROM automation_steps WHERE automation_id = v_auto) <> 1
       OR (SELECT is_active FROM automations WHERE id = v_auto) IS NOT FALSE THEN
      RAISE EXCEPTION 'managed automation upsert is not idempotent';
    END IF;

    -- Helpers are not callable by ordinary roles.
    IF has_function_privilege('authenticated', 'upsert_managed_flow(uuid,uuid,text,jsonb,jsonb)', 'EXECUTE')
       OR has_function_privilege('anon', 'cleanup_orchestration_data(integer,integer,integer,integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'queue_inbound_debounce(uuid,uuid,uuid,uuid,text,text,boolean,integer)', 'EXECUTE') THEN
      RAISE EXCEPTION 'orchestration RPCs must be service_role only';
    END IF;

    -- Roll every fixture back.
    RAISE EXCEPTION 'orchestration-behavior-rollback';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'orchestration-behavior-rollback' THEN
      RAISE;
    END IF;
  END;

  RAISE NOTICE 'orchestration behaviour verification passed';
END
$$;
