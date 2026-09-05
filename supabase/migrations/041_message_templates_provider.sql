-- ============================================================
-- Fix: message_templates.provider was referenced by
-- src/app/api/whatsapp/templates/sync/route.ts (added alongside
-- migration 040's gupshup_template_id column) but never actually
-- added to the schema — every Gupshup template sync would have
-- failed on "column provider does not exist". Caught during the real
-- Gupshup sandbox E2E pass (see docs/GUPSHUP_TEST_REPORT.md).
--
-- Backfill: existing rows get 'meta' if they carry a meta_template_id
-- (or neither id — a local-only DRAFT row predates Gupshup entirely),
-- 'gupshup' if they carry a gupshup_template_id.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_templates_provider_chk'
  ) THEN
    ALTER TABLE message_templates
      ADD CONSTRAINT message_templates_provider_chk CHECK (provider IN ('meta', 'gupshup'));
  END IF;
END $$;

UPDATE message_templates
SET provider = 'gupshup'
WHERE gupshup_template_id IS NOT NULL AND provider <> 'gupshup';

CREATE INDEX IF NOT EXISTS idx_message_templates_provider ON message_templates(account_id, provider);
