-- Migration 041: Add non-partial unique index on v2_fills.upbit_trade_uuid
--
-- Problem: persistFill() in lib/executionEngine.js uses
--   .upsert(fillData, { onConflict: 'upbit_trade_uuid', ignoreDuplicates: true })
-- PostgREST translates this to:
--   INSERT INTO v2_fills (...) ON CONFLICT (upbit_trade_uuid) DO NOTHING
-- PostgreSQL requires a non-partial unique constraint/index to resolve a bare
-- ON CONFLICT (column) clause. The existing idx_v2_fills_upbit_trade_uuid is
-- a PARTIAL index (WHERE upbit_trade_uuid IS NOT NULL), so Postgres cannot
-- match it, producing:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Fix: add a non-partial unique index on the same column.
-- PostgreSQL allows multiple NULLs in a unique index (NULLs are distinct),
-- so synthetic fills (upbit_trade_uuid IS NULL) are unaffected.
-- The partial indexes from migration 031 remain and continue to enforce their
-- own narrower constraints; this index adds the full-column conflict target.

CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
  ON v2_fills(upbit_trade_uuid);
