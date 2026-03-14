-- Signal-driven trading config columns
ALTER TABLE crypto_trader_config
  ADD COLUMN IF NOT EXISTS dip_buy_enabled    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dip_budget_krw     NUMERIC NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS signal_sell_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS signal_buy_enabled  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_dip_run        TIMESTAMPTZ;

-- Expand profit_take_log to support all signal sell labels
ALTER TABLE crypto_profit_take_log
  DROP CONSTRAINT IF EXISTS crypto_profit_take_log_level_check;

ALTER TABLE crypto_profit_take_log
  ADD CONSTRAINT crypto_profit_take_log_level_check
  CHECK (level IN (
    '5pct','10pct','20pct','40pct',
    'rsi_ob','rsi_ob_strong',
    'bb_upper','macd_bear','stochrsi_ob',
    'trailing_stop'
  ));
