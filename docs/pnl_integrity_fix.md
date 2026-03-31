# PnL Integrity Fix

## 1. Files / Functions Changed

| File | Function | Change |
|---|---|---|
| `lib/cryptoTraderV2.js` | `applyFillToPosition` | Cost-basis weight changed from `qty_total` to `qty_open` |
| `lib/cryptoTraderV2.js` | `getOrCreatePosition` | State filter expanded from `'open'` to `['open','adopted','partial']` |

---

## 2. Exact Patch Diff

### Fix 1 — `applyFillToPosition` (line ~150)

```diff
- const newCost = ((pos.avg_cost_krw ?? 0) * (pos.qty_total ?? 0) + fill.price_krw * fill.qty)
-                 / (newQty || 1);
+ // Weight avg_cost by qty_open (currently held), NOT qty_total (all-time bought).
+ // qty_total grows on every buy but is never reduced on sells, so using it as the
+ // cost-basis weight inflates avg_cost after any partial trim — the primary bug.
+ const newCost = ((pos.avg_cost_krw ?? 0) * (pos.qty_open ?? 0) + fill.price_krw * fill.qty)
+                 / (newQty || 1);
```

### Fix 2 — `getOrCreatePosition` (line ~181)

```diff
- const { data: existing } = await supabase.from('positions')
-   .select('position_id').eq('asset', asset).eq('strategy_tag', 'tactical').eq('state', 'open')
-   .order('opened_at', { ascending: false }).limit(1).single();
+ // Include 'partial' and 'adopted' — after a trim, the position moves to 'partial'.
+ // Only querying 'open' caused fresh buys after a trim to create a new duplicate
+ // position (avg_cost_krw = 0) instead of routing fills into the existing position.
+ const { data: existing } = await supabase.from('positions')
+   .select('position_id').eq('asset', asset).eq('strategy_tag', 'tactical')
+   .in('state', ['open', 'adopted', 'partial'])
+   .order('opened_at', { ascending: false }).limit(1).single();
```

---

## 3. Bug Explanation

### Bug A — Wrong weight in avg_cost weighted average

**Root cause:** `applyFillToPosition` buy branch used `pos.qty_total` (total units ever purchased) as the weight for the old avg_cost, but the denominator was `pos.qty_open + fill.qty` (units currently held after the new buy). These two quantities diverge after any partial sell: sells reduce `qty_open` but the code never reduced `qty_total`. Every subsequent add-on buy then used an inflated numerator weight, pushing `avg_cost_krw` far above actual cost.

**Example:**
```
After trim1 (sell 25%): qty_open=0.75, qty_total=1.0, avg_cost=100,000
Add-on buy at 95,000 for 0.25:
  WRONG:   (100,000 × 1.0  + 95,000 × 0.25) / 1.0 = 123,750  ← inflated
  CORRECT: (100,000 × 0.75 + 95,000 × 0.25) / 1.0 = 100,000 per unit approx
```

As cycles continued the inflated `avg_cost` diverged further, causing `gainPct` to appear wildly incorrect.

**Why trim reasons showed 198% / 1530%:** Separately, some positions had `qty_total` that drifted to zero or very low values (from FILL_FALLBACK_DIRECT which never set `qty_total`). When `qty_total ≈ 0`, the formula effectively ignored the old cost basis and averaged only the new fill price against the full `qty_open`. The result was a systematically underestimated `avg_cost_krw`. With `avg_cost_krw` far below true cost, `gainPct = (currentPrice - avg_cost) / avg_cost * 100` became absurdly large. Since the trim reason embeds the live `gainPct` at fire time (`trim1_198.08pct_gross`), the corruption was visible in the reason string.

### Bug B — Duplicate tactical positions after trims

**Root cause:** `getOrCreatePosition` queried `.eq('state', 'open')` only. After any partial trim, the position transitions to `state = 'partial'`. A subsequent fresh entry (non-add-on path) called `getOrCreatePosition`, which failed to find the partial position, and inserted a brand-new position row with `avg_cost_krw = 0`, `qty_open = 0`. Fills then landed on this zero-cost shadow position, creating duplicate tactical partials for the same asset and producing instant "infinite" gain calculations against a near-zero cost basis.

---

## 4. SQL / Data Repair for Corrupted Positions

### Step 1 — Identify corrupted positions

```sql
-- Find duplicate tactical partials for same asset
SELECT asset, strategy_tag, state, COUNT(*) AS cnt,
       array_agg(position_id ORDER BY opened_at) AS position_ids,
       array_agg(qty_open ORDER BY opened_at)    AS qty_opens,
       array_agg(avg_cost_krw ORDER BY opened_at) AS avg_costs
FROM positions
WHERE strategy_tag = 'tactical'
  AND state IN ('open', 'partial', 'adopted')
GROUP BY asset, strategy_tag, state
HAVING COUNT(*) > 1;

-- Find positions with suspect avg_cost (< 1000 KRW for any supported coin — likely corrupted)
SELECT position_id, asset, qty_open, qty_total, avg_cost_krw, state, opened_at, updated_at
FROM positions
WHERE strategy_tag = 'tactical'
  AND state IN ('open', 'partial', 'adopted')
  AND (avg_cost_krw IS NULL OR avg_cost_krw < 1000)
  AND qty_open > 0;

-- Find positions where qty_total < qty_open (should never happen — sell never reduced qty_total)
SELECT position_id, asset, qty_open, qty_total, avg_cost_krw, state
FROM positions
WHERE qty_total < qty_open
  AND state IN ('open', 'partial', 'adopted');
```

### Step 2 — Repair qty_total drift (safe, non-destructive)

`qty_total` was never decremented on sells. For active positions, sync it to at least `qty_open` so future add-on buys use a sane denominator weight:

```sql
-- Bring qty_total in line with qty_open for all non-closed positions
-- where qty_total has drifted below qty_open.
UPDATE positions
SET qty_total  = qty_open,
    updated_at = now()
WHERE state IN ('open', 'partial', 'adopted')
  AND (qty_total IS NULL OR qty_total < qty_open);
```

### Step 3 — Merge duplicate positions (manual, per-asset)

For each asset with duplicates, decide which position is authoritative (usually the one with a valid avg_cost and higher qty_open). Consolidate:

```sql
-- Example: merge a shadow position (bad_id) into the real one (good_id)
-- First, update all orders/fills to point to the real position
UPDATE orders SET position_id = '<good_id>' WHERE position_id = '<bad_id>';
UPDATE v2_fills SET position_id = '<good_id>' WHERE position_id = '<bad_id>';

-- Recalculate good position's qty after merge
UPDATE positions
SET qty_open  = (SELECT SUM(qty) FROM v2_fills WHERE position_id = '<good_id>' AND side = 'buy')
              - COALESCE((SELECT SUM(qty) FROM v2_fills WHERE position_id = '<good_id>' AND side = 'sell'), 0),
    updated_at = now()
WHERE position_id = '<good_id>';

-- Close the bad shadow position
UPDATE positions
SET state = 'closed', closed_at = now(), qty_open = 0, updated_at = now()
WHERE position_id = '<bad_id>';
```

### Step 4 — Manually correct avg_cost_krw where known

If you know the actual fill prices from v2_fills or orders, you can recompute:

```sql
-- Recompute avg_cost from actual buy fills for a position
SELECT
  position_id,
  SUM(price_krw * qty) / NULLIF(SUM(qty), 0) AS correct_avg_cost_krw,
  SUM(qty) AS total_bought
FROM v2_fills
WHERE position_id = '<target_position_id>'
  AND side = 'buy'
GROUP BY position_id;

-- Then apply if the number looks right
UPDATE positions
SET avg_cost_krw = <computed_value>, updated_at = now()
WHERE position_id = '<target_position_id>';
```

---

## 5. Migration / Cleanup Script

No schema migration required — both fixes are code-only (no new columns).

One-time data cleanup (run after deploying the code fix, before restarting Pi):

```sql
-- 1. Sync qty_total for all active non-closed positions
UPDATE positions
SET qty_total  = GREATEST(qty_open, COALESCE(qty_total, 0)),
    updated_at = now()
WHERE state IN ('open', 'partial', 'adopted');

-- 2. Identify suspect positions for manual review
SELECT position_id, asset, qty_open, qty_total, avg_cost_krw, state, opened_at
FROM positions
WHERE state IN ('open', 'partial', 'adopted')
  AND (
    avg_cost_krw < 1000
    OR avg_cost_krw IS NULL
    OR qty_open <= 0
  )
ORDER BY asset, opened_at;

-- 3. After reviewing duplicates, close zero-qty shadow positions
UPDATE positions
SET state = 'closed', closed_at = now(), updated_at = now()
WHERE state IN ('open', 'partial')
  AND qty_open <= 0
  AND strategy_tag = 'tactical';
```
