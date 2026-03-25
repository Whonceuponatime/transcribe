-- Migration 031: Add upbit_trade_uuid to v2_fills for DB-level idempotency
--
-- Why UNIQUE(order_id) is wrong:
--   One Upbit order can be matched across multiple resting orders (trades).
--   extractFills creates one v2_fills row per trade, all sharing the same order_id.
--   A UNIQUE(order_id) constraint would reject every trade after the first.
--
-- Correct approach:
--   Upbit issues each individual trade a uuid (t.uuid in order response).
--   That is the natural idempotency key for a real fill row.
--   Synthetic fills (created when Upbit returns no trade detail) have no
--   trade UUID — those are protected by a separate partial unique index on
--   (order_id) where upbit_trade_uuid IS NULL.

-- Step 1: Add the column (nullable — existing rows and synthetic fills are NULL)
ALTER TABLE v2_fills
  ADD COLUMN IF NOT EXISTS upbit_trade_uuid TEXT;

-- Step 2: Unique index on real fills (non-NULL upbit_trade_uuid only)
--   Postgres UNIQUE allows multiple NULLs — no conflict for synthetic fill rows.
--   This index is the conflict target for ON CONFLICT (upbit_trade_uuid) DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid
  ON v2_fills(upbit_trade_uuid)
  WHERE upbit_trade_uuid IS NOT NULL;

-- Step 3: Partial unique index for synthetic fills
--   Prevents a second synthetic fill being inserted for the same order when
--   resolveStuckOrders is re-run (no trade UUID available, so step 2 would
--   not catch it). One synthetic fill per order is all that is ever valid.
--
--   DATA CLEANUP REQUIRED before this step if the table is non-empty:
--     DELETE FROM v2_fills f1
--     USING v2_fills f2
--     WHERE f1.upbit_trade_uuid IS NULL
--       AND f2.upbit_trade_uuid IS NULL
--       AND f1.order_id = f2.order_id
--       AND f1.created_at > f2.created_at;
--   (keeps the earliest row per order for synthetic fills)
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_synthetic_order
  ON v2_fills(order_id)
  WHERE upbit_trade_uuid IS NULL;
