-- ============================================================
-- 050_bulk_contact_actions.sql — account-scoped bulk contact actions
--
-- Adds reusable RPCs for bulk tagging and resolving the current Contacts
-- selection/filter into contact ids. Supports explicit selections and the
-- existing "all matching" search + ANY-tag semantics from Contacts.
-- ============================================================

CREATE OR REPLACE FUNCTION public.resolve_bulk_contact_ids(
  p_account_id UUID,
  p_contact_ids UUID[] DEFAULT NULL,
  p_all_matching BOOLEAN DEFAULT FALSE,
  p_filter_tag_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_search TEXT := NULLIF(BTRIM(p_search), '');
  v_ids UUID[];
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required';
  END IF;

  IF NOT is_account_member(p_account_id, 'viewer') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;

  IF p_all_matching THEN
    SELECT COALESCE(array_agg(c.id ORDER BY c.created_at DESC), ARRAY[]::UUID[])
      INTO v_ids
    FROM public.contacts c
    WHERE c.account_id = p_account_id
      AND (
        v_search IS NULL
        OR c.name ILIKE '%' || v_search || '%'
        OR c.phone ILIKE '%' || v_search || '%'
        OR c.email ILIKE '%' || v_search || '%'
      )
      AND (
        COALESCE(cardinality(p_filter_tag_ids), 0) = 0
        OR EXISTS (
          SELECT 1
          FROM public.contact_tags ct
          WHERE ct.contact_id = c.id
            AND ct.tag_id = ANY(p_filter_tag_ids)
        )
      );
  ELSE
    SELECT COALESCE(array_agg(c.id ORDER BY c.created_at DESC), ARRAY[]::UUID[])
      INTO v_ids
    FROM public.contacts c
    WHERE c.account_id = p_account_id
      AND c.id = ANY(COALESCE(p_contact_ids, ARRAY[]::UUID[]));
  END IF;

  RETURN COALESCE(v_ids, ARRAY[]::UUID[]);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_bulk_contact_ids(UUID, UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_bulk_contact_ids(UUID, UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;


CREATE OR REPLACE FUNCTION public.bulk_update_contact_tags(
  p_account_id UUID,
  p_action TEXT,
  p_tag_ids UUID[],
  p_contact_ids UUID[] DEFAULT NULL,
  p_all_matching BOOLEAN DEFAULT FALSE,
  p_filter_tag_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_contact_ids UUID[];
  v_changed INTEGER := 0;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required';
  END IF;

  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;

  IF p_action NOT IN ('add', 'remove') THEN
    RAISE EXCEPTION 'action must be add or remove';
  END IF;

  IF COALESCE(cardinality(p_tag_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  -- Fail closed if any requested tag belongs to another account.
  IF EXISTS (
    SELECT 1
    FROM unnest(p_tag_ids) requested(tag_id)
    LEFT JOIN public.tags t
      ON t.id = requested.tag_id
     AND t.account_id = p_account_id
    WHERE t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'one or more tags do not belong to this account';
  END IF;

  v_contact_ids := public.resolve_bulk_contact_ids(
    p_account_id,
    p_contact_ids,
    p_all_matching,
    p_filter_tag_ids,
    p_search
  );

  IF COALESCE(cardinality(v_contact_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  IF p_action = 'add' THEN
    INSERT INTO public.contact_tags (contact_id, tag_id)
    SELECT contact_id, tag_id
    FROM unnest(v_contact_ids) contact_id
    CROSS JOIN unnest(p_tag_ids) tag_id
    ON CONFLICT (contact_id, tag_id) DO NOTHING;

    GET DIAGNOSTICS v_changed = ROW_COUNT;
  ELSE
    DELETE FROM public.contact_tags ct
    WHERE ct.contact_id = ANY(v_contact_ids)
      AND ct.tag_id = ANY(p_tag_ids);

    GET DIAGNOSTICS v_changed = ROW_COUNT;
  END IF;

  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_update_contact_tags(UUID, TEXT, UUID[], UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_update_contact_tags(UUID, TEXT, UUID[], UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;
