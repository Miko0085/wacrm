-- 054_telegram_connections.sql
-- Account-scoped Telegram Bot API connections for notifications.

CREATE TABLE IF NOT EXISTS telegram_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  default_chat_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_connections_account
  ON telegram_connections(account_id, created_at);

ALTER TABLE telegram_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Account members can view telegram connections" ON telegram_connections;
CREATE POLICY "Account members can view telegram connections"
  ON telegram_connections FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM account_memberships am
      WHERE am.account_id = telegram_connections.account_id
        AND am.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Account admins can manage telegram connections" ON telegram_connections;
CREATE POLICY "Account admins can manage telegram connections"
  ON telegram_connections FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM account_memberships am
      WHERE am.account_id = telegram_connections.account_id
        AND am.user_id = auth.uid()
        AND am.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM account_memberships am
      WHERE am.account_id = telegram_connections.account_id
        AND am.user_id = auth.uid()
        AND am.role IN ('owner', 'admin')
    )
  );

DROP TRIGGER IF EXISTS set_updated_at ON telegram_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON telegram_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
