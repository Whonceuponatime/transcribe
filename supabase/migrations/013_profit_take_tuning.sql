-- Migration 013: Update profit-take tier constraint to include 80pct tier.
-- The 5pct tier is removed from bot logic but kept in the constraint for historical rows.
-- Run this in your Supabase SQL Editor.

ALTER TABLE crypto_profit_take_log DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN (
    -- Fixed profit-take tiers (5pct kept for historical rows; new logic starts at 10pct)
    '5pct', '10pct', '20pct', '40pct', '80pct',
    -- RSI signals
    'rsi_ob', 'rsi_ob_strong',
    -- Bollinger
    'bb_upper',
    -- MACD
    'macd_bear',
    -- StochRSI
    'stochrsi_ob',
    -- VWAP
    'vwap_above',
    -- Williams %R
    'williams_ob',
    -- CCI
    'cci_ob',
    -- Kimchi premium
    'kimchi_high',
    -- Trailing stop
    'trailing_stop'
  ));
