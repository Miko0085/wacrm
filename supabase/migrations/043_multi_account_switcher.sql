-- ============================================================
-- 043_multi_account_switcher.sql
--
-- Additive many-to-many account memberships. The legacy
-- profiles.account_id/account_role columns remain intact so code from
-- before this migration can still run after a code rollback.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.account_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role account_role_enum NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_user
  ON public.account_memberships(user_id, created_at, account_id);
CREATE INDEX IF NOT EXISTS idx_account_memberships_account_role
  ON public.account_memberships(account_id, role);

DROP TRIGGER IF EXISTS set_updated_at ON public.account_memberships;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.account_memberships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Every existing single-account user becomes the first membership row.
INSERT INTO public.account_memberships (account_id, user_id, role, created_at)
SELECT p.account_id, p.user_id, p.account_role, p.created_at
FROM public.profiles p
ON CONFLICT (account_id, user_id) DO UPDATE
SET role = EXCLUDED.role;

-- The old schema assumed one owned account per user. Multi-account users
-- may receive ownership later, so keep a lookup index without uniqueness.
DROP INDEX IF EXISTS public.idx_accounts_one_per_owner;
CREATE INDEX IF NOT EXISTS idx_accounts_owner_user_id
  ON public.accounts(owner_user_id);

-- All existing tenant RLS policies call this helper. Repointing the helper
-- upgrades those policies without a destructive policy rewrite.
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.account_memberships m
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
      AND CASE m.role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >= CASE min_role
             WHEN 'owner'  THEN 4
             WHEN 'admin'  THEN 3
             WHEN 'agent'  THEN 2
             WHEN 'viewer' THEN 1
           END
  );
$$;

ALTER FUNCTION public.is_account_member(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_account_member(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_my_account_memberships(
  p_user_id UUID DEFAULT auth.uid()
) RETURNS TABLE(
  id UUID,
  account_id UUID,
  user_id UUID,
  role account_role_enum,
  created_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT m.id, m.account_id, m.user_id, m.role, m.created_at
  FROM public.account_memberships m
  WHERE m.user_id = COALESCE(p_user_id, auth.uid())
    AND COALESCE(p_user_id, auth.uid()) = auth.uid()
  ORDER BY m.created_at ASC, m.account_id ASC;
$$;
ALTER FUNCTION public.list_my_account_memberships(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_my_account_memberships(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_my_account_memberships(UUID) TO authenticated, service_role;

-- Storage paths are account-scoped (`account-<uuid>/...`). The older
-- policies looked only at profiles.account_id, which would reject a member
-- after switching to a second account. Repoint writes to membership RLS.
DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media" ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.accounts a
      WHERE ('account-' || a.id::text) = (storage.foldername(name))[1]
        AND public.is_account_member(a.id))
    OR auth.uid()::text = (storage.foldername(name))[1]
  )
);
DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media" ON storage.objects FOR UPDATE
USING (
  bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.accounts a
      WHERE ('account-' || a.id::text) = (storage.foldername(name))[1]
        AND public.is_account_member(a.id))
    OR auth.uid()::text = (storage.foldername(name))[1]
  )
);
DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media" ON storage.objects FOR DELETE
USING (
  bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.accounts a
      WHERE ('account-' || a.id::text) = (storage.foldername(name))[1]
        AND public.is_account_member(a.id))
    OR auth.uid()::text = (storage.foldername(name))[1]
  )
);

DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media" ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'chat-media' AND EXISTS (SELECT 1 FROM public.accounts a
    WHERE ('account-' || a.id::text) = (storage.foldername(name))[1]
      AND public.is_account_member(a.id))
);
DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media" ON storage.objects FOR UPDATE
USING (
  bucket_id = 'chat-media' AND EXISTS (SELECT 1 FROM public.accounts a
    WHERE ('account-' || a.id::text) = (storage.foldername(name))[1]
      AND public.is_account_member(a.id))
);
DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media" ON storage.objects FOR DELETE
USING (
  bucket_id = 'chat-media' AND EXISTS (SELECT 1 FROM public.accounts a
    WHERE ('account-' || a.id::text) = (storage.foldername(name))[1]
      AND public.is_account_member(a.id))
);

ALTER TABLE public.account_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_memberships_select ON public.account_memberships;
DROP POLICY IF EXISTS account_memberships_insert ON public.account_memberships;
DROP POLICY IF EXISTS account_memberships_update ON public.account_memberships;
DROP POLICY IF EXISTS account_memberships_delete ON public.account_memberships;

CREATE POLICY account_memberships_select ON public.account_memberships FOR SELECT
  USING (user_id = auth.uid() OR public.is_account_member(account_id));
CREATE POLICY account_memberships_insert ON public.account_memberships FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'admin'));
CREATE POLICY account_memberships_update ON public.account_memberships FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
CREATE POLICY account_memberships_delete ON public.account_memberships FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

-- A member roster now spans memberships rather than profile.account_id.
-- Keep self-read and allow profile reads when caller and target share at
-- least one account. Writes remain self-only and privilege columns retain
-- the protection added in migration 034.
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles FOR SELECT
USING (
  auth.uid() = user_id
  OR EXISTS (
    SELECT 1
    FROM public.account_memberships mine
    JOIN public.account_memberships theirs
      ON theirs.account_id = mine.account_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = profiles.user_id
  )
);

-- New signups still receive their personal account/profile, plus the
-- membership row that is now the source of truth.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.account_memberships (account_id, user_id, role)
  VALUES (v_account_id, NEW.id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile/membership for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- Invitation redemption now adds a membership. It deliberately keeps the
-- personal account and legacy profile pointer, making the operation
-- non-destructive and allowing the old code to keep working after rollback.
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv public.account_invitations%ROWTYPE;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM public.account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_memberships
    WHERE account_id = v_inv.account_id AND user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.account_memberships (account_id, user_id, role)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role);

  UPDATE public.account_invitations
  SET accepted_at = NOW(), accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- Account-explicit member management avoids accidentally applying a role
-- change to whichever legacy account happens to be stored on profiles.
CREATE OR REPLACE FUNCTION public.set_account_member_role(
  p_account_id UUID,
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  SELECT role INTO v_caller_role FROM public.account_memberships
  WHERE account_id = p_account_id AND user_id = auth.uid();
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_target_role FROM public.account_memberships
  WHERE account_id = p_account_id AND user_id = p_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' OR p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to change the owner' USING ERRCODE = '22023';
  END IF;
  UPDATE public.account_memberships SET role = p_new_role
  WHERE account_id = p_account_id AND user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_account_member_role(UUID, UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_account_member_role(UUID, UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_account_member_role(UUID, UUID, account_role_enum) TO authenticated;

CREATE OR REPLACE FUNCTION public.remove_account_membership(
  p_account_id UUID,
  p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_fallback public.account_memberships%ROWTYPE;
  v_profile public.profiles%ROWTYPE;
  v_new_account_id UUID;
BEGIN
  SELECT role INTO v_caller_role FROM public.account_memberships
  WHERE account_id = p_account_id AND user_id = auth.uid();
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_target_role FROM public.account_memberships
  WHERE account_id = p_account_id AND user_id = p_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.account_memberships
  WHERE account_id = p_account_id AND user_id = p_user_id;

  SELECT * INTO v_profile FROM public.profiles WHERE user_id = p_user_id;
  IF v_profile.account_id = p_account_id THEN
    SELECT * INTO v_fallback FROM public.account_memberships
    WHERE user_id = p_user_id ORDER BY created_at, account_id LIMIT 1;
    IF v_fallback.id IS NULL THEN
      INSERT INTO public.accounts(name, owner_user_id)
      VALUES (COALESCE(NULLIF(v_profile.full_name, ''), v_profile.email, 'My account'), p_user_id)
      RETURNING id INTO v_new_account_id;
      INSERT INTO public.account_memberships(account_id, user_id, role)
      VALUES (v_new_account_id, p_user_id, 'owner')
      RETURNING * INTO v_fallback;
    END IF;
    UPDATE public.profiles
    SET account_id = v_fallback.account_id, account_role = v_fallback.role
    WHERE user_id = p_user_id;
  END IF;
END;
$$;

ALTER FUNCTION public.remove_account_membership(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_membership(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_membership(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership_for_account(
  p_account_id UUID,
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_role account_role_enum;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.account_memberships
    WHERE account_id = p_account_id AND user_id = auth.uid() AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;
  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;
  SELECT role INTO v_target_role FROM public.account_memberships
  WHERE account_id = p_account_id AND user_id = p_new_owner_user_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  UPDATE public.account_memberships SET role = 'admin'
  WHERE account_id = p_account_id AND user_id = auth.uid();
  UPDATE public.account_memberships SET role = 'owner'
  WHERE account_id = p_account_id AND user_id = p_new_owner_user_id;
  UPDATE public.accounts SET owner_user_id = p_new_owner_user_id WHERE id = p_account_id;

  -- Keep legacy profile values coherent when either profile points here.
  UPDATE public.profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = p_account_id;
  UPDATE public.profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = p_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership_for_account(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership_for_account(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership_for_account(UUID, UUID) TO authenticated;

-- Presence is active-account-specific. A separate RPC preserves the old
-- touch_presence signature for rollback compatibility.
CREATE OR REPLACE FUNCTION public.touch_account_presence(
  p_account_id UUID,
  p_status TEXT DEFAULT 'online'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.member_presence (user_id, account_id, status, last_seen_at)
  VALUES (auth.uid(), p_account_id, p_status, NOW())
  ON CONFLICT (user_id) DO UPDATE SET
    account_id = EXCLUDED.account_id,
    status = EXCLUDED.status,
    last_seen_at = NOW();
END;
$$;

ALTER FUNCTION public.touch_account_presence(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.touch_account_presence(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_account_presence(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags_for_account(
  p_account_id UUID,
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE c.account_id = p_account_id
      AND ct.tag_id = ANY(p_tag_ids)
      AND (p_search IS NULL OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%')
  ), page AS (
    SELECT id, count(*) OVER() AS total_count FROM matched
    ORDER BY created_at DESC, id LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags_for_account(UUID, UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags_for_account(UUID, UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags_for_account(UUID, UUID[], TEXT, INT, INT) TO authenticated;
