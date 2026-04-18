ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS target_deployment_pct               numeric DEFAULT 30,
  ADD COLUMN IF NOT EXISTS target_entries_per_position         integer DEFAULT 8,
  ADD COLUMN IF NOT EXISTS exit_tactical_final_exit_hours      numeric DEFAULT 4.0,
  ADD COLUMN IF NOT EXISTS exit_tactical_final_exit_min_net_pct numeric DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS exit_tactical_time_stop_hours       numeric DEFAULT 72.0,
  ADD COLUMN IF NOT EXISTS max_addons_per_position             integer DEFAULT 6;

UPDATE bot_config
SET target_deployment_pct               = 30,
    target_entries_per_position         = 8,
    exit_tactical_final_exit_hours      = 4.0,
    exit_tactical_final_exit_min_net_pct = 0.5,
    exit_tactical_time_stop_hours       = 72.0,
    max_addons_per_position             = 6,
    updated_at                          = NOW()
WHERE id = (SELECT id FROM bot_config LIMIT 1);
