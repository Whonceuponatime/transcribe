-- Migration 033: Starter (rotation) entry configuration
--
-- Adds three bot_config columns that control the small starter-entry mode.
-- When enabled, the bot opens a small position in UPTREND/RANGE even when
-- the full pullback signal (BB %B + RSI) is not met, as long as:
--   - No open position exists for the symbol
--   - OB imbalance quality gate passes
--   - RSI is not extreme overbought (< starter_rsi_max)
--   - Risk engine and cooldown allow it
--
-- Disable this mode entirely with: starter_entry_enabled = false

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS starter_entry_enabled BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS starter_size_mult     NUMERIC(5,3) NOT NULL DEFAULT 0.25,
  ADD COLUMN IF NOT EXISTS starter_rsi_max       NUMERIC(5,2) NOT NULL DEFAULT 70;

-- starter_entry_enabled : false = disabled, true = active
-- starter_size_mult      : fraction of normal entry budget (default 0.25 = 25%)
--                          Normal uptrend budget = NAV × max_risk_per_signal_pct × 50%
--                          Starter uptrend = that × 0.25 ≈ 0.25% NAV at defaults
-- starter_rsi_max        : RSI above this value blocks the starter (overbought guard)
