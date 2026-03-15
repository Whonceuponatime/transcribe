-- Migration 011: Capital % mode — budget scales automatically with KRW balance.
-- Run this in your Supabase SQL Editor.

ALTER TABLE crypto_trader_config
  ADD COLUMN IF NOT EXISTS capital_pct_mode  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dca_pct_of_krw    NUMERIC NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS dip_pct_of_krw    NUMERIC NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS max_dca_krw       NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_dip_krw       NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN crypto_trader_config.capital_pct_mode IS
  'When true, DCA and dip-buy budgets are calculated as % of available KRW balance instead of fixed amounts.';
COMMENT ON COLUMN crypto_trader_config.dca_pct_of_krw IS
  'Percentage of available KRW to spend on weekly DCA (e.g. 20 = 20%).';
COMMENT ON COLUMN crypto_trader_config.dip_pct_of_krw IS
  'Percentage of available KRW to spend per dip-buy signal (e.g. 10 = 10%).';
COMMENT ON COLUMN crypto_trader_config.max_dca_krw IS
  'Maximum KRW cap per DCA cycle regardless of % (0 = no cap).';
COMMENT ON COLUMN crypto_trader_config.max_dip_krw IS
  'Maximum KRW cap per dip-buy cycle regardless of % (0 = no cap).';
