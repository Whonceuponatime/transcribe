-- Phase 2 of ladder_exhausted_exit: expose underwater-branch tunables on the
-- dashboard. Phase 1 (commit b99aad94) added code reads via
-- `cfg.<key> ?? <default>` so these columns can be missing and the engine
-- still runs on code defaults. Adding the columns allows the PATCH endpoint
-- and dashboard to write them without a code redeploy.
--
-- Defaults match the code defaults in lib/signalEngine.js so existing
-- behavior is preserved on the singleton row.

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_ladder_exhausted_underwater_enabled       boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS exit_ladder_exhausted_underwater_min_loss_pct  numeric DEFAULT -2.0,
  ADD COLUMN IF NOT EXISTS exit_ladder_exhausted_underwater_min_age_hours numeric DEFAULT 96.0;

UPDATE bot_config
SET exit_ladder_exhausted_underwater_enabled       = true,
    exit_ladder_exhausted_underwater_min_loss_pct  = -2.0,
    exit_ladder_exhausted_underwater_min_age_hours = 96.0,
    updated_at                                     = NOW()
WHERE id = (SELECT id FROM bot_config LIMIT 1);
