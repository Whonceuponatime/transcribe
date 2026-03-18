-- Migration 019: Reduce DCA % to avoid over-deploying cash too fast.
-- 30% DCA every 12h means spending 60%+ of KRW per day into a falling market.
-- 10% DCA every 12h = 20% per day which is still aggressive but gives room to breathe.
-- The cash reserve floor fix in code will also prevent DCA when KRW < 15% of portfolio.
UPDATE crypto_trader_config
SET
  dca_pct_of_krw = 10,
  dip_pct_of_krw = 8,
  updated_at = now();
