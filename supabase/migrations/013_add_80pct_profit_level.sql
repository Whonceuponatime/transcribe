-- Migration 013: Add 80pct profit-take tier to allowed levels.
-- The +80% profit tier was added to PROFIT_LEVELS; update the DB constraint to allow it.

ALTER TABLE crypto_profit_take_log DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN (
    -- Fixed profit-take tiers (5pct removed — too small, erodes positions)
    '10pct', '20pct', '40pct', '80pct',
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
