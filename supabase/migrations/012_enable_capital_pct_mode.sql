-- Migration 012: Switch existing config row to capital % mode
-- Run this once in the Supabase SQL editor.
-- After this the bot budgets auto-scale with your live Upbit KRW balance.

UPDATE crypto_trader_config
SET
  capital_pct_mode = true,
  dca_pct_of_krw   = 20,   -- spend 20% of available KRW per DCA cycle
  dip_pct_of_krw   = 10,   -- spend 10% of available KRW per dip-buy signal
  max_dca_krw      = 0,    -- 0 = no cap (scales freely with balance)
  max_dip_krw      = 0,    -- 0 = no cap
  updated_at       = now();
