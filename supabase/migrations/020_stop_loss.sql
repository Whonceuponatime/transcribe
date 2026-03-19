-- Migration 020: Add stop_loss_pct column.
-- 0 = disabled (default). Set to e.g. 5 to sell 50% of any position
-- that drops more than 5% AND has been held for at least 24 hours.
ALTER TABLE crypto_trader_config
  ADD COLUMN IF NOT EXISTS stop_loss_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
