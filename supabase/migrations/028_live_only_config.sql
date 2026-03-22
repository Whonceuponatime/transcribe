-- Migration 028: Live-only production config.
-- Adds granular trading controls to replace the paper/shadow/live mode field.
-- The bot is now always live — paper/shadow modes are removed from execution paths.
--
-- New controls:
--   trading_enabled  — master switch (replaces kill switch concept for V2)
--   buys_enabled     — allow new buy orders to be placed
--   sells_enabled    — allow sell orders to be placed
--
-- The 'mode' column is retained for audit log compatibility but its value is
-- always 'live'. The paper/shadow check is removed from execution code.

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS trading_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS buys_enabled    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sells_enabled   BOOLEAN NOT NULL DEFAULT true;

-- Set the existing row to live + all controls enabled
UPDATE bot_config
  SET mode            = 'live',
      trading_enabled = true,
      buys_enabled    = true,
      sells_enabled   = true,
      updated_at      = now();
