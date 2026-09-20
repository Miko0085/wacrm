-- Only the root main account may manage its direct sub-accounts.
DROP FUNCTION IF EXISTS public.list_sub_accounts();

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
REVOKE ALL ON FUNCTION public.list_sub_accounts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_sub_accounts(UUID) TO authenticated;
