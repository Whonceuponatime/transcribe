-- Migration 037: Add profit-floor harvest config to bot_config
-- Adds two columns that control the time-in-profit harvest exit in signalEngine.js.
-- exit_profit_harvest_hours:    hours a position must be held (above edge) before
--                               the harvest exit fires (default 4h).
-- exit_profit_harvest_size_pct: percent of the position sold on harvest (default 25%).

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_profit_harvest_hours    NUMERIC(5,1) DEFAULT 4.0,
  ADD COLUMN IF NOT EXISTS exit_profit_harvest_size_pct NUMERIC(5,2) DEFAULT 15.0;
