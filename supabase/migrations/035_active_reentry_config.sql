-- Migration 035: Active re-entry config columns
--
-- Adds four bot_config columns that increase re-entry frequency for small
-- frequent profit without redesigning the core strategy.
--
-- Changes wired in this migration:
--   starter_ob_imbalance_min    — separate, looser OB gate for starter entries
--                                 (signalEngine.js evaluateStarterEntry)
--   adaptive_inactivity_12h_hours — configurable inactivity trigger (was hardcoded 12)
--   adaptive_inactivity_24h_hours — configurable inactivity trigger (was hardcoded 24)
--                                 (adaptiveThresholds.js computeAdaptiveThresholds)
--
-- Prepared (not wired to code yet):
--   starter_cooldown_ms         — separate cooldown for starter entries only;
--                                 column ready for future code wiring

ALTER TABLE bot_config
  -- Starter OB gate: falls back to ob_imbalance_min when NULL.
  -- Set more negative than ob_imbalance_min to allow starters through
  -- moderately sell-heavy books that would block a normal pullback entry.
  -- Recommended live value: -0.60 (vs normal entry default -0.45)
  ADD COLUMN IF NOT EXISTS starter_ob_imbalance_min      NUMERIC(5,3) DEFAULT NULL,

  -- Adaptive inactivity trigger hours (replaces hardcoded 12 / 24).
  -- Lower these to make adaptive loosening kick in sooner.
  -- Recommended live values: 4 / 8
  ADD COLUMN IF NOT EXISTS adaptive_inactivity_12h_hours NUMERIC(5,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS adaptive_inactivity_24h_hours NUMERIC(5,2) DEFAULT NULL,

  -- Prepared: separate cooldown for starter entries.
  -- Not wired to code yet. When wired, starters will use this instead of
  -- buy_cooldown_ms, allowing smaller cooldown for probe entries while
  -- keeping the longer cooldown for full pullback entries.
  ADD COLUMN IF NOT EXISTS starter_cooldown_ms           INTEGER      DEFAULT NULL;

-- Column semantics:
--   starter_ob_imbalance_min      NULL → falls back to ob_imbalance_min (default -0.45)
--   adaptive_inactivity_12h_hours NULL → falls back to hardcoded 12h
--   adaptive_inactivity_24h_hours NULL → falls back to hardcoded 24h
--   starter_cooldown_ms           NULL → not yet wired; ignored by current code
