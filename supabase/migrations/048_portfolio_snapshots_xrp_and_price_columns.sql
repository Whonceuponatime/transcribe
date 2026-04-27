-- Migration 048: portfolio_snapshots_v2 missing columns
--
-- Why: saveV2Snapshot writer (lib/cryptoTraderV2.js:407-438) inserts
-- xrp_value_krw, xrp_pct, and *_price_krw columns for every coin
-- (BTC/ETH/SOL/XRP). None of those columns exist in the table.
-- PostgREST rejects every insert; the bare catch in the writer
-- swallows the error silently. Adding the columns unblocks the
-- writer with no code changes.
--
-- Existing rows: pre-migration rows from before the price loop was
-- added will have NULL for all new columns. That is semantically
-- correct (the bot wasn't tracking those values then).

ALTER TABLE portfolio_snapshots_v2
  ADD COLUMN IF NOT EXISTS xrp_value_krw NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS xrp_pct       NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS btc_price_krw NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS eth_price_krw NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS sol_price_krw NUMERIC(20,4),
  ADD COLUMN IF NOT EXISTS xrp_price_krw NUMERIC(20,4);
