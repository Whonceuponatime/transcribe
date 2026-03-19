-- Migration 021: Add micro profit-take tier labels and stop_loss to the level constraint.
-- New tiers: 1.5pct, 3pct, 5pct for frequent small-profit sells on bounces.
-- Also adds rsi_recovery, modest_recovery and stop_loss which may have been missed previously.

ALTER TABLE crypto_profit_take_log DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN (
    -- Micro profit-take tiers (new — captures small bounces frequently)
    '1.5pct', '3pct', '5pct',
    -- Standard profit-take tiers
    '10pct', '20pct', '40pct', '80pct',
    -- RSI signals
    'rsi_ob', 'rsi_ob_strong', 'rsi_recovery',
    -- Technical indicator signals
    'bb_upper', 'macd_bear', 'stochrsi_ob',
    'vwap_above', 'williams_ob', 'cci_ob', 'kimchi_high',
    -- Recovery / moderate signals
    'modest_recovery',
    -- Risk management
    'trailing_stop', 'stop_loss'
  ));
