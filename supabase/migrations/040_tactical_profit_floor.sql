-- Tactical profit-floor partial exit: non-reclaim tactical positions, mid hold before generic harvest.
-- Defaults: 2.5h hold, 12% size (smaller than trim1 25%).

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_tactical_profit_floor_hours    NUMERIC(5,2) DEFAULT 2.5,
  ADD COLUMN IF NOT EXISTS exit_tactical_profit_floor_size_pct NUMERIC(5,2) DEFAULT 12.0;
