-- Migration 010: Add new signal sell labels and app_settings key for USD/KRW rate.
-- Run this in your Supabase SQL Editor.

-- Drop old constraint and add updated one with all signal sell levels
ALTER TABLE crypto_profit_take_log DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN (
    -- Fixed profit-take tiers
    '5pct', '10pct', '20pct', '40pct',
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
