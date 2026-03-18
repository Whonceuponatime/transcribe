-- Migration 015: Add recovery sell signal labels to constraint.
--
-- New signals added in lib/cryptoTrader.js:
--   • SIGNAL_RSI_RECOVERY   (label: rsi_recovery)
--     RSI bounced above 62 AND price above VWAP — closes the pullback buy cycle
--     without requiring extreme RSI 75+ overbought in range-bound markets.
--   • SIGNAL_MODEST_RECOVERY (label: modest_recovery)
--     gain ≥ 3% + RSI > 58 + MACD histogram positive — catches moderate bounces
--     after dip buys in sideways/bear markets.

ALTER TABLE crypto_profit_take_log DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN (
    -- Fixed profit-take tiers
    '5pct', '10pct', '20pct', '40pct', '80pct',
    -- RSI signals
    'rsi_ob', 'rsi_ob_strong', 'rsi_recovery',
    -- Recovery signals
    'modest_recovery',
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
