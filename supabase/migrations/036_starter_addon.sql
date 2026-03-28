-- Migration 036: starter_addon_size_mult
--
-- Adds the config column that scales the size of a starter-style re-entry
-- into an existing position (the new !intent && gatingPos path added in
-- cryptoTraderV2.js). NULL falls back to 1.0 (same size as a flat-portfolio
-- starter — already smaller than a normal add-on).
--
-- starter_cooldown_ms was already added (schema-only) in migration 035.
-- It is now wired in code and takes effect without a schema change.
-- Set it explicitly if you want a shorter cooldown for starters vs the
-- normal buy_cooldown_ms. NULL = use buy_cooldown_ms.

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS starter_addon_size_mult NUMERIC(5,3) DEFAULT NULL;

-- Column semantics:
--   NULL  → falls back to 1.0 (no additional downscale beyond starter budget)
--   0.50  → half the normal starter budget for re-entries into existing positions
--   1.0   → same size as a flat-portfolio starter
