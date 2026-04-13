-- Migration 043: Fix adopted positions stuck with strategy_tag='unassigned' / state='adopted'
--
-- Auto-adopt (reconciliation + startup) now creates positions as
-- strategy_tag='tactical', state='open' so they enter the sell cycle
-- immediately. This migration fixes the two currently stuck positions
-- and any other active positions still tagged 'unassigned'.

-- ── Fix the two known stuck positions ─────────────────────────────────────────
UPDATE positions
SET    strategy_tag = 'tactical',
       state        = 'open',
       updated_at   = now()
WHERE  position_id IN (
         'b1802411-e5b7-4032-9176-b8500ed90d2a',   -- BTC
         'bd7a577e-25ee-4717-af22-5d39a9454da7'     -- ETH
       )
  AND  state != 'closed';

-- ── Catch-all: fix any other active unassigned positions ──────────────────────
UPDATE positions
SET    strategy_tag = 'tactical',
       state        = CASE WHEN state = 'adopted' THEN 'open' ELSE state END,
       updated_at   = now()
WHERE  strategy_tag = 'unassigned'
  AND  state IN ('open', 'adopted', 'partial')
  AND  managed = true;
