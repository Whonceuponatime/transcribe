-- Migration 017: Deploy cash faster by running DCA twice daily (every 12h).
-- With ~₩2M sitting in KRW, the bot needs to redeploy faster.
-- dca_cooldown_days = 0.5 means DCA runs when 12+ hours have elapsed since last run.
UPDATE crypto_trader_config
SET
  dca_cooldown_days = 0.5,
  updated_at        = now();
