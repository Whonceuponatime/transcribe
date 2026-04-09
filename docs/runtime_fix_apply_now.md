## A. exact source files to edit

| File | What changed |
|------|-------------|
| `pi-trader/index.js` | `hourlyDigest()`: invalid `.catch()` chains replaced with `try/catch`; `runCycleV2()`: `result.mode ?? 'paper'` → `result.mode ?? result.execution_mode ?? 'unknown'` |
| `supabase/migrations/041_v2_fills_nonpartial_uuid_index.sql` | New migration — non-partial unique index on `v2_fills(upbit_trade_uuid)` |
| `supabase/init_schema.sql` | New index added to schema baseline |

All three are already committed and pushed to `origin/main` (commit `88d61cff`).  
The Pi has not yet pulled — it is still running the pre-fix source.

## B. exact patch diff

### `pi-trader/index.js` — `hourlyDigest()` (chained .catch removal)

```diff
-    const { data: snapRow } = await Promise.resolve(
-      supabase.from('app_settings').select('value')
-        .eq('key', 'crypto_portfolio_snapshot').single()
-    ).catch(() => ({ data: null }));
+    let snapRow = null;
+    try {
+      const { data } = await supabase.from('app_settings').select('value')
+        .eq('key', 'crypto_portfolio_snapshot').single();
+      snapRow = data;
+    } catch (_) {}
     const snap = snapRow?.value ?? null;

-    const { data: diagLogs } = await supabase.from('crypto_bot_logs')
-      .select('meta').eq('tag', 'sell_diag').gte('created_at', since1h)
-      .order('created_at', { ascending: false }).limit(3)
-      .catch(() => ({ data: [] }));
+    let diagLogs = [];
+    try {
+      const { data: _diagData } = await supabase.from('crypto_bot_logs')
+        .select('meta').eq('tag', 'sell_diag').gte('created_at', since1h)
+        .order('created_at', { ascending: false }).limit(3);
+      diagLogs = _diagData ?? [];
+    } catch (_) {}
```

### `pi-trader/index.js` — `runCycleV2()` (mode fallback)

```diff
-      const mode = result.mode ?? 'paper';
+      const mode = result.mode ?? result.execution_mode ?? 'unknown';
```

### `supabase/migrations/041_v2_fills_nonpartial_uuid_index.sql` (new file)

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
  ON v2_fills(upbit_trade_uuid);
```

## C. exact SQL to run

**Step 1 — check for duplicate non-NULL upbit_trade_uuid before creating the index (run first):**

```sql
SELECT upbit_trade_uuid, COUNT(*)
FROM v2_fills
WHERE upbit_trade_uuid IS NOT NULL
GROUP BY upbit_trade_uuid
HAVING COUNT(*) > 1;
```

Expected result: zero rows. If any rows appear, remove duplicates before continuing:

```sql
-- Keep the earliest row per duplicate uuid, delete the rest
DELETE FROM v2_fills
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY upbit_trade_uuid ORDER BY created_at) AS rn
    FROM v2_fills
    WHERE upbit_trade_uuid IS NOT NULL
  ) sub
  WHERE rn > 1
);
```

**Step 2 — create the non-partial unique index:**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
  ON v2_fills(upbit_trade_uuid);
```

This resolves `ON CONFLICT (upbit_trade_uuid)` in `persistFill()`:

```js
// lib/executionEngine.js ~line 69
.upsert(fillData, { onConflict: 'upbit_trade_uuid', ignoreDuplicates: true })
```

The existing partial indexes (`idx_v2_fills_upbit_trade_uuid` and `idx_v2_fills_synthetic_order` from migration 031) remain and are not dropped.

## D. exact restart commands

Run on the Pi over SSH:

```bash
cd ~/transcribe          # or wherever the repo lives on the Pi
git pull origin main
pm2 restart crypto-trader
pm2 logs crypto-trader --lines 30
```

## E. exact post-fix verification commands

```bash
# 1. Confirm new code is on disk
grep -n "result.execution_mode" pi-trader/index.js
# expected: line showing result.mode ?? result.execution_mode ?? 'unknown'

grep -n "let diagLogs" pi-trader/index.js
# expected: line showing 'let diagLogs = [];' inside hourlyDigest

# 2. Confirm PM2 is running the new code
pm2 show crypto-trader | grep "script path\|status\|restarts"

# 3. Watch for absence of the two errors after next hourly cron tick (:00)
pm2 logs crypto-trader --lines 100 | grep -E "Digest error|persistFill DB error"
# expected: no matches

# 4. Confirm the index exists in Supabase (run in SQL editor)
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'v2_fills'
  AND indexname LIKE '%upbit_trade_uuid%';
-- expected: 3 rows — idx_v2_fills_upbit_trade_uuid (partial),
--           idx_v2_fills_synthetic_order (partial),
--           idx_v2_fills_upbit_trade_uuid_full (non-partial, NEW)
```
