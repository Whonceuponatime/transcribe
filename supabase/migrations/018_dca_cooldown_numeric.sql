-- Migration 018: Change dca_cooldown_days from INTEGER to NUMERIC so sub-daily
-- values like 0.5 (every 12h) can be stored.
ALTER TABLE crypto_trader_config
  ALTER COLUMN dca_cooldown_days TYPE NUMERIC(6,2) USING dca_cooldown_days::NUMERIC(6,2);

-- Set to 0.5 (twice daily) now that the column accepts decimals.
UPDATE crypto_trader_config SET dca_cooldown_days = 0.5, updated_at = now();
