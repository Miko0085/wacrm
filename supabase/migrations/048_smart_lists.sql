-- ============================================================
-- 048_smart_lists.sql — dynamic saved contact segments
--
-- Smart lists store rules, never a materialized contact snapshot.
-- Membership is evaluated against contact_tags when previewing or
-- sending a broadcast, so contacts automatically enter/leave lists
-- as their tags change.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.smart_lists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  description TEXT,
  match_mode TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  include_tag_ids UUID[] NOT NULL DEFAULT '{}'::UUID[],
  exclude_tag_ids UUID[] NOT NULL DEFAULT '{}'::UUID[],
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smart_lists_account_name
  ON public.smart_lists(account_id, name);

ALTER TABLE public.smart_lists ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON public.smart_lists;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.smart_lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS "smart_lists_select_member" ON public.smart_lists;
CREATE POLICY "smart_lists_select_member"
  ON public.smart_lists FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

DROP POLICY IF EXISTS "smart_lists_insert_agent" ON public.smart_lists;
CREATE POLICY "smart_lists_insert_agent"
  ON public.smart_lists FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS "smart_lists_update_agent" ON public.smart_lists;
CREATE POLICY "smart_lists_update_agent"
  ON public.smart_lists FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS "smart_lists_delete_agent" ON public.smart_lists;
CREATE POLICY "smart_lists_delete_agent"
  ON public.smart_lists FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Evaluate one smart list dynamically. Pagination keeps large audiences
-- below PostgREST response limits; total_count is repeated per row so the
-- UI can show an exact live size without a second scan.
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
  ),
  matched AS (
    SELECT c.id, c.created_at
    FROM contacts c
    JOIN selected_list sl ON sl.account_id = c.account_id
    WHERE
      (
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
  SELECT count(*)
  FROM resolve_smart_list_contacts(p_smart_list_id, 1, 0);
$$;

-- The resolver's total_count cannot be used by count(*) above because its
-- page is intentionally one row. Return that row's exact window count.
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

REVOKE ALL ON FUNCTION public.resolve_smart_list_contacts(UUID, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_smart_list_contacts(UUID, INT, INT) TO authenticated;
REVOKE ALL ON FUNCTION public.count_smart_list_contacts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_smart_list_contacts(UUID) TO authenticated;
