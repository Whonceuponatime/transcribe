-- Migration 034: micro_position_bypass_krw
--
-- Adds a config field that allows a tiny probe position to be bypassed
-- when evaluating the add-on dip% requirement.
--
-- When micro_position_bypass_krw > 0 and an existing position's notional
-- value (qty_open × current price) is below this threshold, the bot
-- treats it as if no position exists for add-on gating only. All other
-- gates (cooldown, risk engine, exposure caps) remain active.
--
-- Default 0 = disabled (no change to current add-on behaviour).
-- Recommended first test value: 60000 (₩60,000)

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS micro_position_bypass_krw NUMERIC(12,4) NOT NULL DEFAULT 0;
