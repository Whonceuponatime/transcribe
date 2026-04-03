-- Migration 038: Downtrend reclaim starter config
--
-- Adds five columns to bot_config that control a cautious probe entry for
-- BTC/ETH when regime = DOWNTREND and price shows a sane reclaim setup.
-- Disabled by default (dt_reclaim_starter_enabled = false).
--
-- dt_reclaim_starter_enabled : master switch; must be set true to activate
-- dt_reclaim_bb_max          : max %B allowed (price must be in lower band)
-- dt_reclaim_rsi_min         : RSI floor of sane reclaim window
-- dt_reclaim_rsi_max         : RSI ceiling of sane reclaim window
-- dt_reclaim_size_mult       : fraction of the 30%-downtrend budget used for sizing
--                              (default 0.15 → ~0.09% NAV per entry vs ~0.20% for
--                              a normal range starter)

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS dt_reclaim_starter_enabled BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dt_reclaim_bb_max          NUMERIC(5,3) NOT NULL DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS dt_reclaim_rsi_min         NUMERIC(5,2) NOT NULL DEFAULT 30.0,
  ADD COLUMN IF NOT EXISTS dt_reclaim_rsi_max         NUMERIC(5,2) NOT NULL DEFAULT 48.0,
  ADD COLUMN IF NOT EXISTS dt_reclaim_size_mult       NUMERIC(5,3) NOT NULL DEFAULT 0.15;
