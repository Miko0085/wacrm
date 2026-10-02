-- ============================================================
-- 044_sub_accounts_rpc.sql
-- Missing sub-account primitives required by
-- /api/account/sub-accounts.
-- Additive and rollback-safe.
-- ============================================================

ALTER TABLE public.accounts
ADD COLUMN IF NOT EXISTS parent_account_id UUID
REFERENCES public.accounts(id)
ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_parent_account_id
ON public.accounts(parent_account_id);

CREATE OR REPLACE FUNCTION public.list_sub_accounts(
  p_parent_account_id UUID
)
RETURNS TABLE(
  id UUID,
  name TEXT,
  owner_user_id UUID,
  parent_account_id UUID,
  default_currency TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_account_member(p_parent_account_id, 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.name,
    a.owner_user_id,
    a.parent_account_id,
    a.default_currency,
    a.created_at,
    a.updated_at
  FROM public.accounts a
  WHERE a.parent_account_id = p_parent_account_id
  ORDER BY a.created_at ASC, a.id ASC;
END;
$$;

ALTER FUNCTION public.list_sub_accounts(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_sub_accounts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_sub_accounts(UUID)
  TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.create_sub_account(
  p_name TEXT
)
RETURNS public.accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_parent_account_id UUID;
  v_account public.accounts%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized'
      USING ERRCODE = '42501';
  END IF;

  IF NULLIF(BTRIM(p_name), '') IS NULL THEN
    RAISE EXCEPTION 'Sub-account name is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT m.account_id
  INTO v_parent_account_id
  FROM public.account_memberships m
  JOIN public.accounts a ON a.id = m.account_id
  WHERE m.user_id = v_user_id
    AND m.role IN ('owner', 'admin')
    AND a.parent_account_id IS NULL
  ORDER BY m.created_at ASC, m.account_id ASC
  LIMIT 1;

  IF v_parent_account_id IS NULL THEN
    RAISE EXCEPTION 'No eligible main account found'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.accounts (
    name,
    owner_user_id,
    parent_account_id
  )
  VALUES (
    BTRIM(p_name),
    v_user_id,
    v_parent_account_id
  )
  RETURNING * INTO v_account;

  INSERT INTO public.account_memberships (
    account_id,
    user_id,
    role
  )
  VALUES (
    v_account.id,
    v_user_id,
    'owner'
  );

  RETURN v_account;
END;
$$;

ALTER FUNCTION public.create_sub_account(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_sub_account(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_sub_account(TEXT)
  TO authenticated, service_role;
