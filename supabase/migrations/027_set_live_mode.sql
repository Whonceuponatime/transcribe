-- Migration 027: Set V2 engine to live mode permanently.
-- This changes the default for new installs and updates the existing row.
-- After this runs, V2 will place real orders on Upbit.
-- V1 is automatically suppressed when mode = live (isV1Suppressed() check).

ALTER TABLE bot_config
  ALTER COLUMN mode SET DEFAULT 'live';

UPDATE bot_config
  SET mode = 'live', updated_at = now();
