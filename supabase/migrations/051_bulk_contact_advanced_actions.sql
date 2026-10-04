-- ============================================================
-- 051_bulk_contact_advanced_actions.sql
-- Advanced account-scoped bulk actions for Contacts:
--   - bulk custom-field set/clear
--   - marketing suppression (DNC)
--   - internal notes
--   - static Smart Lists created from an explicit selection
--
-- Builds on resolve_bulk_contact_ids(...) from migration 050.
-- ============================================================

-- ------------------------------------------------------------
-- Static Smart Lists
-- ------------------------------------------------------------
ALTER TABLE public.smart_lists
  ADD COLUMN IF NOT EXISTS list_type TEXT NOT NULL DEFAULT 'dynamic';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'smart_lists_list_type_check'
      AND conrelid = 'public.smart_lists'::regclass
  ) THEN
    ALTER TABLE public.smart_lists
      ADD CONSTRAINT smart_lists_list_type_check
      CHECK (list_type IN ('dynamic', 'static'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.smart_list_members (
  smart_list_id UUID NOT NULL REFERENCES public.smart_lists(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (smart_list_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_smart_list_members_contact
  ON public.smart_list_members(contact_id);

ALTER TABLE public.smart_list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smart_list_members_select_member" ON public.smart_list_members;
CREATE POLICY "smart_list_members_select_member"
  ON public.smart_list_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.smart_lists sl
      WHERE sl.id = smart_list_members.smart_list_id
        AND is_account_member(sl.account_id, 'viewer')
    )
  );

DROP POLICY IF EXISTS "smart_list_members_insert_agent" ON public.smart_list_members;
CREATE POLICY "smart_list_members_insert_agent"
  ON public.smart_list_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.smart_lists sl
      JOIN public.contacts c ON c.id = smart_list_members.contact_id
      WHERE sl.id = smart_list_members.smart_list_id
        AND sl.account_id = c.account_id
        AND is_account_member(sl.account_id, 'agent')
    )
  );

DROP POLICY IF EXISTS "smart_list_members_delete_agent" ON public.smart_list_members;
CREATE POLICY "smart_list_members_delete_agent"
  ON public.smart_list_members FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.smart_lists sl
      WHERE sl.id = smart_list_members.smart_list_id
        AND is_account_member(sl.account_id, 'agent')
    )
  );

-- Replace the Smart List resolver so both dynamic and static lists use the
-- same broadcast/count APIs. Existing dynamic lists keep identical behavior.
CREATE OR REPLACE FUNCTION public.resolve_smart_list_contacts(
  p_smart_list_id UUID,
  p_limit INT DEFAULT 500,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH selected_list AS (
    SELECT sl.*
    FROM smart_lists sl
    WHERE sl.id = p_smart_list_id
      AND is_account_member(sl.account_id, 'viewer')
  ),
  matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    JOIN selected_list sl ON sl.account_id = c.account_id
    WHERE
      (
        sl.list_type = 'static'
        AND EXISTS (
          SELECT 1
          FROM smart_list_members sm
          WHERE sm.smart_list_id = sl.id
            AND sm.contact_id = c.id
        )
      )
      OR
      (
        sl.list_type = 'dynamic'
        AND (
          cardinality(sl.include_tag_ids) = 0
          OR (
            sl.match_mode = 'any'
            AND EXISTS (
              SELECT 1
              FROM contact_tags ct
              WHERE ct.contact_id = c.id
                AND ct.tag_id = ANY(sl.include_tag_ids)
            )
          )
          OR (
            sl.match_mode = 'all'
            AND NOT EXISTS (
              SELECT 1
              FROM unnest(sl.include_tag_ids) required_tag(tag_id)
              WHERE NOT EXISTS (
                SELECT 1
                FROM contact_tags ct
                WHERE ct.contact_id = c.id
                  AND ct.tag_id = required_tag.tag_id
              )
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM contact_tags excluded
          WHERE excluded.contact_id = c.id
            AND excluded.tag_id = ANY(sl.exclude_tag_ids)
        )
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 500))
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

CREATE OR REPLACE FUNCTION public.count_smart_list_contacts(
  p_smart_list_id UUID
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(max(r.total_count), 0)::BIGINT
  FROM resolve_smart_list_contacts(p_smart_list_id, 1, 0) r;
$$;

CREATE OR REPLACE FUNCTION public.create_static_smart_list_from_selection(
  p_account_id UUID,
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_contact_ids UUID[] DEFAULT NULL,
  p_all_matching BOOLEAN DEFAULT FALSE,
  p_filter_tag_ids UUID[] DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
  v_list_id UUID;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'account_id is required';
  END IF;
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;
  IF char_length(BTRIM(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'smart list name must be between 1 and 120 characters';
  END IF;

  v_ids := public.resolve_bulk_contact_ids(
    p_account_id,
    p_contact_ids,
    p_all_matching,
    p_filter_tag_ids,
    p_search
  );

  IF COALESCE(cardinality(v_ids), 0) = 0 THEN
    RAISE EXCEPTION 'selection is empty';
  END IF;

  INSERT INTO public.smart_lists (
    account_id,
    name,
    description,
    match_mode,
    include_tag_ids,
    exclude_tag_ids,
    list_type,
    created_by
  )
  VALUES (
    p_account_id,
    BTRIM(p_name),
    NULLIF(BTRIM(COALESCE(p_description, '')), ''),
    'all',
    ARRAY[]::UUID[],
    ARRAY[]::UUID[],
    'static',
    auth.uid()
  )
  RETURNING id INTO v_list_id;

  INSERT INTO public.smart_list_members (smart_list_id, contact_id)
  SELECT v_list_id, id
  FROM unnest(v_ids) id
  ON CONFLICT DO NOTHING;

  RETURN v_list_id;
END;
$$;

-- ------------------------------------------------------------
-- Bulk custom field set / clear
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bulk_set_contact_custom_field(
  p_account_id UUID,
  p_custom_field_id UUID,
  p_value TEXT DEFAULT NULL,
  p_clear BOOLEAN DEFAULT FALSE,
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
  v_ids UUID[];
  v_changed INTEGER := 0;
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.custom_fields cf
    WHERE cf.id = p_custom_field_id
      AND cf.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'custom field does not belong to this account';
  END IF;

  v_ids := public.resolve_bulk_contact_ids(
    p_account_id,
    p_contact_ids,
    p_all_matching,
    p_filter_tag_ids,
    p_search
  );

  IF COALESCE(cardinality(v_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  IF p_clear THEN
    DELETE FROM public.contact_custom_values ccv
    WHERE ccv.custom_field_id = p_custom_field_id
      AND ccv.contact_id = ANY(v_ids);
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  ELSE
    INSERT INTO public.contact_custom_values (contact_id, custom_field_id, value)
    SELECT id, p_custom_field_id, COALESCE(p_value, '')
    FROM unnest(v_ids) id
    ON CONFLICT (contact_id, custom_field_id)
    DO UPDATE SET value = EXCLUDED.value;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  END IF;

  RETURN v_changed;
END;
$$;

-- ------------------------------------------------------------
-- Bulk marketing suppression / DNC
-- Backup DB-level mutation helper. The Contacts UI uses the server API
-- route so contact.opted_out webhooks are emitted to downstream CRM too.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bulk_suppress_marketing(
  p_account_id UUID,
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
  v_ids UUID[];
  v_changed INTEGER := 0;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;

  v_ids := public.resolve_bulk_contact_ids(
    p_account_id,
    p_contact_ids,
    p_all_matching,
    p_filter_tag_ids,
    p_search
  );

  UPDATE public.contacts c
  SET wa_marketing_status = 'OPTED_OUT',
      wa_opt_out_at = v_now,
      wa_consent_source = 'wacrm_bulk_dnc',
      updated_at = v_now
  WHERE c.account_id = p_account_id
    AND c.id = ANY(v_ids)
    AND c.wa_marketing_status IS DISTINCT FROM 'OPTED_OUT';

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$$;

-- ------------------------------------------------------------
-- Bulk internal notes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bulk_add_contact_note(
  p_account_id UUID,
  p_note TEXT,
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
  v_ids UUID[];
  v_changed INTEGER := 0;
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'insufficient account permissions';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'note cannot be empty';
  END IF;

  v_ids := public.resolve_bulk_contact_ids(
    p_account_id,
    p_contact_ids,
    p_all_matching,
    p_filter_tag_ids,
    p_search
  );

  INSERT INTO public.contact_notes (contact_id, user_id, note_text)
  SELECT id, auth.uid(), BTRIM(p_note)
  FROM unnest(v_ids) id;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.create_static_smart_list_from_selection(UUID, TEXT, TEXT, UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_static_smart_list_from_selection(UUID, TEXT, TEXT, UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_set_contact_custom_field(UUID, UUID, TEXT, BOOLEAN, UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_set_contact_custom_field(UUID, UUID, TEXT, BOOLEAN, UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_suppress_marketing(UUID, UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_suppress_marketing(UUID, UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.bulk_add_contact_note(UUID, TEXT, UUID[], BOOLEAN, UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_add_contact_note(UUID, TEXT, UUID[], BOOLEAN, UUID[], TEXT) TO authenticated;
