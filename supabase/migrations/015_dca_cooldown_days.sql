-- Migration 015: Add dca_cooldown_days column (default 1 = daily DCA).
ALTER TABLE crypto_trader_config
  ADD COLUMN IF NOT EXISTS dca_cooldown_days INTEGER NOT NULL DEFAULT 1;

-- Set existing rows to daily
UPDATE crypto_trader_config SET dca_cooldown_days = 1;
