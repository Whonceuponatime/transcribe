-- Migration 025: Enhanced portfolio adoption metadata and reconciliation tracking.
--
-- Adds full position metadata as required by the adoption spec:
--   origin, managed, supported_universe, current_mark_price,
--   estimated_market_value, adoption_timestamp
--
-- Adds 'unassigned' to strategy_tag so adopted holdings are not
-- prematurely classified as core or tactical.
--
-- Creates reconciliation_checks table to track every startup reconciliation
-- attempt, its outcome, and any freeze conditions detected.

-- ── Position metadata ─────────────────────────────────────────────────────────

-- origin: who created this position record
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'bot_managed'
    CHECK (origin IN ('bot_managed','adopted_at_startup'));

-- managed: whether the bot actively applies strategy logic to this position
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT true;

-- supported_universe: whether the asset is in the active strategy coins list
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS supported_universe BOOLEAN NOT NULL DEFAULT true;

-- current_mark_price: price at the time of last adoption or snapshot update
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS current_mark_price NUMERIC(20,4);

-- estimated_market_value: qty × current_mark_price at time of adoption
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS estimated_market_value NUMERIC(20,4);

-- adoption_timestamp: when this position was imported (null for bot-created)
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS adoption_timestamp TIMESTAMPTZ;

-- ── Extend strategy_tag to include 'unassigned' ───────────────────────────────
-- Adopted positions start as 'unassigned' until the operator or strategy
-- explicitly classifies them as core or tactical.
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_strategy_tag_check;
ALTER TABLE positions ADD CONSTRAINT positions_strategy_tag_check
  CHECK (strategy_tag IN ('core','tactical','unassigned'));

-- ── reconciliation_checks ─────────────────────────────────────────────────────
-- One row per startup reconciliation attempt.
-- status = passed  → safe to trade
-- status = frozen  → trading blocked; freeze_reasons explains why
-- status = failed  → reconciliation could not complete (exchange error etc.)
CREATE TABLE IF NOT EXISTS reconciliation_checks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','passed','frozen','failed')),
  -- Human-readable list of reasons the system is frozen (empty = clean)
  freeze_reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Snapshot of exchange balances at reconciliation time
  exchange_balances    JSONB,
  -- Snapshot of DB position balances at reconciliation time
  internal_balances    JSONB,
  -- Any balance discrepancies found { asset: { exchange_qty, db_qty, diff } }
  discrepancies        JSONB,
  -- How many open/unresolved orders were detected
  open_orders_found    INTEGER NOT NULL DEFAULT 0,
  -- Checklist of individual checks and their pass/fail status
  checks_run           JSONB,
  -- Whether trading was enabled or blocked as a result
  trading_enabled      BOOLEAN NOT NULL DEFAULT false,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recon_checks_status  ON reconciliation_checks(status, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_checks_run_at  ON reconciliation_checks(run_at DESC);

ALTER TABLE reconciliation_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service" ON reconciliation_checks;
CREATE POLICY "Allow all for service" ON reconciliation_checks FOR ALL USING (true) WITH CHECK (true);

-- ── Extend adoption_runs with unsupported detail ──────────────────────────────
-- These columns may already exist from migration 024; ADD IF NOT EXISTS is safe.
ALTER TABLE adoption_runs
  ADD COLUMN IF NOT EXISTS reconciliation_id UUID REFERENCES reconciliation_checks(id);
