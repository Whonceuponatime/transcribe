-- Migration 042: raise daily turnover cap from 80% to 150% of NAV
--
-- The cap was previously set to 80 during BTC/ETH-only mode configuration.
-- With NAV at ~₩2.19M the 80% cap (₩1.75M) was blocking new buys even when
-- ₩1.3M+ in free KRW was available. Raising to 150% gives meaningful headroom
-- while still preventing runaway churn on a single trading day.
--
-- No schema change — daily_turnover_cap_pct already exists as NUMERIC(5,2).
-- riskEngine.js already reads this field dynamically against live navKrw.

UPDATE bot_config
SET    daily_turnover_cap_pct = 150,
       updated_at             = NOW()
WHERE  id = (SELECT id FROM bot_config LIMIT 1);
