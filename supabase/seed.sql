-- Local-only fixture for `supabase db reset`.
-- All values are fake. Login: multi-account@example.local / Password123!

DO $$
DECLARE
  v_user UUID := '00000000-0000-0000-0000-000000000001';
  v_a UUID := '10000000-0000-0000-0000-000000000001';
  v_b UUID := '10000000-0000-0000-0000-000000000002';
  v_c UUID := '10000000-0000-0000-0000-000000000003';
  v_personal UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_user) THEN
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
      v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'multi-account@example.local', crypt('Password123!', gen_salt('bf')),
      NOW(), '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Multi Account Tester"}'::jsonb, NOW(), NOW()
    );
  END IF;

  -- GoTrue scans token columns as strings; local fixture users must use
  -- empty strings rather than NULL for those legacy token fields.
  UPDATE auth.users
  SET confirmation_token = COALESCE(confirmation_token, ''),
      recovery_token = COALESCE(recovery_token, ''),
      email_change = COALESCE(email_change, ''),
      email_change_token_new = COALESCE(email_change_token_new, ''),
      email_change_token_current = COALESCE(email_change_token_current, ''),
      phone_change = COALESCE(phone_change, ''),
      phone_change_token = COALESCE(phone_change_token, '')
  WHERE id = v_user;

  INSERT INTO accounts (id, name, owner_user_id)
  VALUES
    (v_a, 'Sub-account 1', v_user),
    (v_b, 'Sub-account 2', v_user),
    (v_c, 'Sub-account 3', v_user)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, owner_user_id = EXCLUDED.owner_user_id;

  UPDATE accounts SET parent_account_id = NULL WHERE id = v_a;
  UPDATE accounts SET parent_account_id = v_a WHERE id IN (v_b, v_c);

  INSERT INTO account_memberships (account_id, user_id, role)
  VALUES (v_a, v_user, 'owner'), (v_b, v_user, 'admin'), (v_c, v_user, 'viewer')
  ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  UPDATE profiles
  SET full_name = 'Multi Account Tester',
      email = 'multi-account@example.local',
      account_id = v_a,
      account_role = 'owner'
  WHERE user_id = v_user;

  SELECT id INTO v_personal FROM accounts
  WHERE owner_user_id = v_user AND id NOT IN (v_a, v_b, v_c)
  ORDER BY created_at LIMIT 1;
  IF v_personal IS NOT NULL THEN
    DELETE FROM accounts WHERE id = v_personal;
  END IF;

  INSERT INTO contacts (id, account_id, user_id, phone, name)
  VALUES
    ('20000000-0000-0000-0000-000000000001', v_a, v_user, '+971500000001', 'Dubai Contact'),
    ('20000000-0000-0000-0000-000000000002', v_b, v_user, '+79160000002', 'Moscow Contact'),
    ('20000000-0000-0000-0000-000000000003', v_c, v_user, '+971500000003', 'Abu Dhabi Contact')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO whatsapp_config (
    id, account_id, user_id, provider, gupshup_api_key,
    gupshup_app_id, gupshup_app_name, gupshup_source_phone_number,
    gupshup_webhook_token, status
  ) VALUES
    ('30000000-0000-0000-0000-000000000001', v_a, v_user, 'gupshup', 'local-fake-key-a', 'local-app-a', 'Sub-account 1', '+971500000001', 'local-webhook-token-a', 'disconnected'),
    ('30000000-0000-0000-0000-000000000002', v_b, v_user, 'gupshup', 'local-fake-key-b', 'local-app-b', 'Sub-account 2', '+79160000002', 'local-webhook-token-b', 'disconnected'),
    ('30000000-0000-0000-0000-000000000003', v_c, v_user, 'gupshup', 'local-fake-key-c', 'local-app-c', 'Sub-account 3', '+971500000003', 'local-webhook-token-c', 'disconnected')
  ON CONFLICT (id) DO NOTHING;
END $$;
