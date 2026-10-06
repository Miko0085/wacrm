-- 053_business_events.sql
-- Durable, account-scoped business events used as the decoupling layer
-- between AI/Flows and downstream Automations/integrations.

CREATE TABLE IF NOT EXISTS business_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'system',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_events_account_type_time
  ON business_events(account_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_business_events_contact_time
  ON business_events(contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view business events" ON business_events;
CREATE POLICY "Account members can view business events"
  ON business_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM account_members am
      WHERE am.account_id = business_events.account_id
        AND am.user_id = auth.uid()
    )
  );

-- Writes are server-side through the service role only.
