-- ============================================================
-- Gupshup WhatsApp provider support.
--
-- Makes `whatsapp_config` provider-aware (Meta Cloud API | Gupshup)
-- instead of assuming Meta, and adds a minimal, provider-independent
-- consent model to `contacts` (WACRM had none before this migration —
-- see docs/GUPSHUP_INTEGRATION_AUDIT.md §15).
--
-- Design choice: ONE `whatsapp_config` row per account (unchanged from
-- migration 017's `UNIQUE(account_id)`), with a `provider` column
-- selecting which credential set is active. Meta and Gupshup
-- credential columns live side by side on the same row rather than in
-- separate rows/tables, so switching `provider` back and forth never
-- deletes the other provider's saved credentials (requirement: "Не
-- удалять Meta credentials автоматически при switch").
--
-- `phone_number_id` / `access_token` were NOT NULL (migration 001) —
-- relaxed to nullable here since a Gupshup-only account has neither.
-- A CHECK constraint enforces that whichever provider is ACTIVE has
-- its own credentials present, so the nullability can't silently drift
-- into "connected but unusable".
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS gupshup_api_key TEXT,
  ADD COLUMN IF NOT EXISTS gupshup_app_id TEXT,
  ADD COLUMN IF NOT EXISTS gupshup_app_name TEXT,
  ADD COLUMN IF NOT EXISTS gupshup_source_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS gupshup_connected_at TIMESTAMPTZ,
  -- Secret path segment for this account's Gupshup webhook URL
  -- (/api/whatsapp/gupshup/webhook/<token>). Gupshup callbacks carry
  -- no HMAC signature (unlike Meta's x-hub-signature-256) — an
  -- unguessable per-account token in the URL itself is the
  -- documented, real security boundary. See docs/GUPSHUP_INTEGRATION.md
  -- ("Webhook security").
  ADD COLUMN IF NOT EXISTS gupshup_webhook_token TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_provider_chk'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_chk CHECK (provider IN ('meta', 'gupshup'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_provider_credentials_chk'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provider_credentials_chk CHECK (
        (provider = 'meta' AND phone_number_id IS NOT NULL AND access_token IS NOT NULL)
        OR
        (provider = 'gupshup' AND gupshup_api_key IS NOT NULL AND gupshup_source_phone_number IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_gupshup_webhook_token
  ON whatsapp_config(gupshup_webhook_token)
  WHERE gupshup_webhook_token IS NOT NULL;

-- ============================================================
-- message_templates: parallel Gupshup template id.
--
-- Mirrors `meta_template_id` — a nullable, provider-specific id column
-- rather than a generalized (provider, provider_template_id) pair, to
-- match the existing column-per-provider shape of this table and avoid
-- touching every other column's semantics.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS gupshup_template_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_templates_gupshup_template_id
  ON message_templates(gupshup_template_id)
  WHERE gupshup_template_id IS NOT NULL;

-- ============================================================
-- contacts: minimal, provider-independent WhatsApp marketing consent.
--
-- WACRM had NO opt-in/opt-out tracking at all before this migration
-- (neither Meta nor Gupshup) — this is net-new, not a migrated Meta
-- concept. `UNKNOWN` (default) means "no explicit signal either way";
-- broadcasts still send to UNKNOWN contacts (matches today's existing
-- behavior for every current install), but OPTED_OUT contacts are
-- hard-suppressed from marketing broadcasts at the DB-adjacent
-- enforcement layer (see src/lib/whatsapp/broadcast-core.ts), not just
-- filtered in the UI.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_marketing_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS wa_opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_opt_out_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_consent_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_wa_marketing_status_chk'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_wa_marketing_status_chk
      CHECK (wa_marketing_status IN ('OPTED_IN', 'OPTED_OUT', 'UNKNOWN'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_wa_marketing_status
  ON contacts(account_id, wa_marketing_status);
