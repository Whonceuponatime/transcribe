-- Migration 016: Re-enable capital_pct_mode so DCA/dip budgets scale with KRW balance.
-- With capital_pct_mode = false the bot was using a fixed ₩100K budget even when
-- ₩2M+ was available — causing very slow cash redeployment.
UPDATE crypto_trader_config
SET
  capital_pct_mode = true,
  dca_pct_of_krw   = 20,   -- spend 20% of available KRW per DCA (₩400K at ₩2M balance)
  dip_pct_of_krw   = 10,   -- spend 10% of available KRW per dip signal
  updated_at       = now();
