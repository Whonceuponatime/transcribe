-- Migration 022: Add 'debug' level to crypto_bot_logs.
-- Previously only 'info','warn','error' were allowed, which caused sell_diag
-- logs (written at 'debug' level) to silently fail the constraint.

ALTER TABLE crypto_bot_logs DROP CONSTRAINT IF EXISTS crypto_bot_logs_level_check;

ALTER TABLE crypto_bot_logs
  ADD CONSTRAINT crypto_bot_logs_level_check
  CHECK (level IN ('debug', 'info', 'warn', 'error'));
