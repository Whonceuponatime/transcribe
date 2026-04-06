-- Reclaim-aware partial harvest: earlier small sell for dt_reclaim_starter positions only.
-- Defaults: 0.75h hold, 12% size (smaller than trim1 25%).

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_reclaim_harvest_hours    NUMERIC(5,2) DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS exit_reclaim_harvest_size_pct NUMERIC(5,2) DEFAULT 12.0;
