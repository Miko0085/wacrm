-- ============================================================
-- 049_bulk_contact_delete.sql — safe account-scoped bulk deletion
--
-- Supports both explicit selected contact ids and "all matching"
-- deletion using the same search + ANY-tag semantics as Contacts.
-- RLS remains active (SECURITY INVOKER) and account_id is mandatory.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_contacts_bulk(
  p_account_id UUID,
  p_contact_ids UUID[] DEFAULT NULL,
  p_all_matching BOOLEAN DEFAULT FALSE,
  p_tag_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER := 0;
  v_search TEXT := NULLIF(BTRIM(p_search), '');
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required';
  END IF;

  -- Fail closed when the caller is not allowed to mutate this account.
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;

  IF p_all_matching THEN
    DELETE FROM public.contacts c
    WHERE c.account_id = p_account_id
      AND (
        v_search IS NULL
        OR c.name ILIKE '%' || v_search || '%'
        OR c.phone ILIKE '%' || v_search || '%'
        OR c.email ILIKE '%' || v_search || '%'
      )
      AND (
        COALESCE(cardinality(p_tag_ids), 0) = 0
        OR EXISTS (
          SELECT 1
          FROM public.contact_tags ct
          WHERE ct.contact_id = c.id
            AND ct.tag_id = ANY(p_tag_ids)
        )
      );
  ELSE
    IF COALESCE(cardinality(p_contact_ids), 0) = 0 THEN
      RETURN 0;
    END IF;

    DELETE FROM public.contacts c
    WHERE c.account_id = p_account_id
      AND c.id = ANY(p_contact_ids);
  END IF;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_contacts_bulk(UUID, UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_contacts_bulk(UUID, UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;
