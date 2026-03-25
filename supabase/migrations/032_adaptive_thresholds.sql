-- Migration 032: Adaptive entry threshold configuration fields
--
-- Adds optional bot_config columns that control the bounded adaptive layer
-- for BB %B and order-book imbalance entry thresholds.
-- All columns have safe defaults; existing rows are unaffected until updated.
-- Set adaptive_thresholds_enabled = false to disable the layer entirely.

-- ── Enable / disable toggle ──────────────────────────────────────────────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_thresholds_enabled BOOLEAN NOT NULL DEFAULT true;

-- ── BB %B loosen offsets (positive, applied when inactive or flat) ───────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_bb_12h_offset  NUMERIC(5,3) NOT NULL DEFAULT 0.04,
  ADD COLUMN IF NOT EXISTS adaptive_bb_24h_offset  NUMERIC(5,3) NOT NULL DEFAULT 0.07,
  ADD COLUMN IF NOT EXISTS adaptive_bb_flat_offset NUMERIC(5,3) NOT NULL DEFAULT 0.03;

-- ── BB %B tighten offsets (positive magnitude, subtracted when risk is on) ───
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_bb_vol_offset  NUMERIC(5,3) NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS adaptive_bb_risk_offset NUMERIC(5,3) NOT NULL DEFAULT 0.08;

-- ── BB %B hard clamps (absolute, per regime) ─────────────────────────────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_bb_uptrend_min   NUMERIC(5,3) NOT NULL DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS adaptive_bb_uptrend_max   NUMERIC(5,3) NOT NULL DEFAULT 0.60,
  ADD COLUMN IF NOT EXISTS adaptive_bb_range_min     NUMERIC(5,3) NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS adaptive_bb_range_max     NUMERIC(5,3) NOT NULL DEFAULT 0.50,
  ADD COLUMN IF NOT EXISTS adaptive_bb_downtrend_min NUMERIC(5,3) NOT NULL DEFAULT 0.02,
  ADD COLUMN IF NOT EXISTS adaptive_bb_downtrend_max NUMERIC(5,3) NOT NULL DEFAULT 0.12;

-- ── OB imbalance loosen offsets (positive, moves min toward 0) ───────────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_ob_12h_offset  NUMERIC(5,3) NOT NULL DEFAULT 0.04,
  ADD COLUMN IF NOT EXISTS adaptive_ob_24h_offset  NUMERIC(5,3) NOT NULL DEFAULT 0.07,
  ADD COLUMN IF NOT EXISTS adaptive_ob_flat_offset NUMERIC(5,3) NOT NULL DEFAULT 0.03;

-- ── OB imbalance tighten offsets (positive magnitude, subtracted) ────────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_ob_vol_offset  NUMERIC(5,3) NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS adaptive_ob_risk_offset NUMERIC(5,3) NOT NULL DEFAULT 0.08;

-- ── OB imbalance hard clamps (absolute) ──────────────────────────────────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_ob_floor NUMERIC(5,3) NOT NULL DEFAULT -0.70,
  ADD COLUMN IF NOT EXISTS adaptive_ob_ceil  NUMERIC(5,3) NOT NULL DEFAULT -0.15;

-- ── ATR% threshold for "elevated volatility" trigger ─────────────────────────
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS adaptive_atr_high_pct NUMERIC(5,2) NOT NULL DEFAULT 3.00;
