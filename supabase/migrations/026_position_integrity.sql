-- Migration 026: Position integrity hardening for limited live trading.
--
-- 1. Consistency check: adopted_at_startup positions must have adoption_timestamp
-- 2. strategy_tag default is now 'unassigned' (was left ambiguous before)
-- 3. managed and supported_universe are enforced NOT NULL (belt + suspenders)
-- 4. operator_classified_at: records when an operator explicitly classified a position
-- 5. operator_note: free-text field for classification reason / manual cost basis note

-- ── Constraint: adopted positions must have a timestamp ──────────────────────
-- Prevents the bot from creating an adopted record without recording when it happened.
-- This constraint catches code bugs where origin is set but adoption_timestamp is omitted.
ALTER TABLE positions
  DROP CONSTRAINT IF EXISTS positions_adopted_has_timestamp;
ALTER TABLE positions
  ADD  CONSTRAINT positions_adopted_has_timestamp
    CHECK (origin != 'adopted_at_startup' OR adoption_timestamp IS NOT NULL);

-- ── Ensure strategy_tag default is unassigned ─────────────────────────────────
-- Prior schema (023) had no default; 025 added the column. Explicitly set default
-- so any new position created without a tag gets 'unassigned' rather than NULL.
ALTER TABLE positions
  ALTER COLUMN strategy_tag SET DEFAULT 'unassigned';

-- ── Ensure managed and supported_universe cannot be null ─────────────────────
-- 025 added these as NOT NULL DEFAULT. This statement is idempotent but makes the
-- intent explicit for fresh installs that replay all migrations.
ALTER TABLE positions
  ALTER COLUMN managed           SET NOT NULL,
  ALTER COLUMN supported_universe SET NOT NULL;

-- ── Operator classification tracking ─────────────────────────────────────────
-- Records when and how the operator explicitly classified an adopted position.
-- operator_classified_at is null for bot-managed positions.
-- operator_note is free text: e.g. "purchased before bot deploy, keep as core"
ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS operator_classified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_note          TEXT;
