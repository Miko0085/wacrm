-- Root main account with unlimited, non-nested sub-accounts.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS parent_account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_accounts_parent_account_id
  ON public.accounts(parent_account_id);

CREATE OR REPLACE FUNCTION public.create_sub_account(p_name TEXT)
RETURNS public.accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  root public.accounts;
  created public.accounts;
BEGIN
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(trim(p_name)) > 80 THEN
    RAISE EXCEPTION 'Sub-account name must be between 1 and 80 characters';
  END IF;

  SELECT a.* INTO root
  FROM public.accounts a
  WHERE a.owner_user_id = auth.uid()
    AND a.parent_account_id IS NULL
    AND public.is_account_member(a.id, 'admin')
  ORDER BY a.created_at ASC, a.id ASC
  LIMIT 1;

  IF root.id IS NULL THEN
    RAISE EXCEPTION 'Only an owner/admin of the main account can create sub-accounts';
  END IF;

  INSERT INTO public.accounts(name, owner_user_id, parent_account_id)
  VALUES (trim(p_name), auth.uid(), root.id)
  RETURNING * INTO created;

  INSERT INTO public.account_memberships(account_id, user_id, role)
  VALUES (created.id, auth.uid(), 'owner');

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_sub_accounts(p_parent_account_id UUID DEFAULT NULL)
RETURNS SETOF public.accounts
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT child.*
  FROM public.accounts root
  JOIN public.accounts child ON child.parent_account_id = root.id
  WHERE (p_parent_account_id IS NULL OR root.id = p_parent_account_id)
    AND root.owner_user_id = auth.uid()
    AND root.parent_account_id IS NULL
    AND public.is_account_member(root.id, 'admin')
  ORDER BY child.created_at ASC, child.id ASC;
$$;

REVOKE ALL ON FUNCTION public.create_sub_account(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_sub_accounts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_sub_account(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_sub_accounts(UUID) TO authenticated;
