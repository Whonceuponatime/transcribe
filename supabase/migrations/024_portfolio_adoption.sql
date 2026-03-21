-- Migration 024: First-deployment portfolio adoption.
--
-- Adds the 'adopted' position state so the bot can safely import pre-existing
-- Upbit holdings without treating them as freshly-opened strategy positions.
--
-- adopted  = imported from live account at startup; not created by the bot
-- open     = created by the bot (normal strategy position)
-- closed   = fully exited
-- partial  = partially exited

-- ── Extend positions state constraint ────────────────────────────────────────
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_state_check;
ALTER TABLE positions ADD CONSTRAINT positions_state_check
  CHECK (state IN ('open','closed','partial','adopted'));

-- Column to track which adoption run imported this position
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS adoption_run_id UUID;

-- ── adoption_runs ─────────────────────────────────────────────────────────────
-- One row per adoption attempt. Idempotency: if a completed run exists the
-- adopter will skip re-importing rather than creating duplicate positions.
CREATE TABLE IF NOT EXISTS adoption_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','complete','failed')),
  adopted_count       INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  unsupported_count   INTEGER NOT NULL DEFAULT 0,
  unsupported_assets  JSONB,   -- [ { currency, balance, avg_buy_price } ]
  adopted_assets      JSONB,   -- [ { currency, qty, avg_cost_krw, position_id } ]
  error_message       TEXT,
  run_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_adoption_runs_status ON adoption_runs(status, run_at DESC);

ALTER TABLE adoption_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service" ON adoption_runs;
CREATE POLICY "Allow all for service" ON adoption_runs FOR ALL USING (true) WITH CHECK (true);
