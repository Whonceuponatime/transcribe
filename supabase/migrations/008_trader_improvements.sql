-- Trader v2: smarter DCA gates, trailing stop, bear market detection

ALTER TABLE crypto_trader_config
  ADD COLUMN IF NOT EXISTS fear_greed_gate_enabled   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS trailing_stop_enabled      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS trailing_stop_pct          NUMERIC NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS bear_market_pause_enabled  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS min_signal_score           INTEGER NOT NULL DEFAULT 0;

-- Update level constraint to new realistic thresholds + trailing stop
ALTER TABLE crypto_profit_take_log
  DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log
  ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN ('5pct', '10pct', '20pct', '40pct', 'trailing_stop'));
