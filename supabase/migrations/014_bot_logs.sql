-- Migration 014: Structured bot log table for dashboard display.
-- The Pi writes a summary entry after every cycle; the dashboard reads the last N rows.

CREATE TABLE IF NOT EXISTS crypto_bot_logs (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  tag        TEXT,
  message    TEXT NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_logs_created ON crypto_bot_logs(created_at DESC);

ALTER TABLE crypto_bot_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service" ON crypto_bot_logs;
CREATE POLICY "Allow all for service" ON crypto_bot_logs FOR ALL USING (true) WITH CHECK (true);
