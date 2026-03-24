-- Migration 030: Enforce bot_config as a strict singleton table.
--
-- Problem: INSERT INTO bot_config DEFAULT VALUES ON CONFLICT DO NOTHING uses a
-- random UUID primary key, so the ON CONFLICT clause can never trigger. Each
-- migration run that includes this INSERT adds a new row. With multiple rows,
-- LIMIT 1 reads without ORDER BY are non-deterministic.
--
-- Fix:
--   1. Delete all rows except the most recently updated one.
--   2. Add a unique index on a constant expression so that only one row can
--      ever exist. Any future INSERT will fail with a unique-constraint error
--      before it touches the table.
--   3. Add an explicit updated_at trigger so every UPDATE stamps the row.

-- Step 1: keep only the most recently updated row
DELETE FROM bot_config
WHERE id NOT IN (
  SELECT id FROM bot_config ORDER BY updated_at DESC NULLS LAST LIMIT 1
);

-- Step 2: singleton constraint — unique index on a constant (only 1 row allowed)
-- Any subsequent INSERT will hit: "duplicate key value violates unique constraint"
CREATE UNIQUE INDEX IF NOT EXISTS bot_config_singleton
  ON bot_config ((true));

-- Step 3: add new strategy-tuning columns introduced by the quick-profit rotation update.
-- These columns were previously only hardcoded defaults in signalEngine.js / cryptoTraderV2.js.
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_quick_trim1_gross_pct NUMERIC(6,3) DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS exit_quick_trim2_gross_pct NUMERIC(6,3) DEFAULT 1.25,
  ADD COLUMN IF NOT EXISTS exit_safety_buffer_pct     NUMERIC(6,3) DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS addon_min_dip_pct          NUMERIC(6,3) DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS addon_size_mult            NUMERIC(5,3) DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS buy_cooldown_ms            INTEGER      DEFAULT 1800000,
  ADD COLUMN IF NOT EXISTS sell_cooldown_ms           INTEGER      DEFAULT 600000;

-- Step 4: write all tuned thresholds onto the surviving row
UPDATE bot_config SET
  entry_bb_pct_uptrend       = 0.45,
  entry_rsi_min_uptrend      = 42,
  entry_rsi_max_uptrend      = 55,
  entry_bb_pct_range         = 0.30,
  entry_rsi_max_range        = 45,
  ob_imbalance_min           = -0.45,
  exit_quick_trim1_gross_pct = 0.85,
  exit_quick_trim2_gross_pct = 1.25,
  exit_safety_buffer_pct     = 0.10,
  addon_min_dip_pct          = 1.0,
  addon_size_mult            = 0.5,
  buy_cooldown_ms            = 1800000,
  sell_cooldown_ms           = 600000,
  max_entries_per_coin_24h   = 3,
  updated_at                 = now();
