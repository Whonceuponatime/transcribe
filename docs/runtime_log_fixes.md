## A. exact files/functions changed

| File | Function | Change |
|------|----------|--------|
| `pi-trader/index.js` | `hourlyDigest()` | Replace `.catch()` chain on Supabase query builder with `try/catch` blocks |
| `supabase/migrations/041_v2_fills_nonpartial_uuid_index.sql` | — (new file) | Non-partial unique index on `v2_fills.upbit_trade_uuid` |
| `supabase/init_schema.sql` | `v2_fills` index block | Added `idx_v2_fills_upbit_trade_uuid_full` to keep schema in sync |

## B. exact bug explanation

**Bug 1 — hourlyDigest `.catch is not a function`**

`pi-trader/index.js` `hourlyDigest()` called `.catch()` directly on the Supabase query builder:

```js
const { data: diagLogs } = await supabase.from('crypto_bot_logs')
  .select('meta').eq('tag', 'sell_diag').gte('created_at', since1h)
  .order('created_at', { ascending: false }).limit(3)
  .catch(() => ({ data: [] }));   // ← .catch is not a function
```

The Supabase JS v2 query builder is a `PromiseLike` (thenable), not a native `Promise`. Native `Promise` methods (`.catch`, `.finally`) do not exist on the builder until it is awaited or wrapped in `Promise.resolve()`. Calling `.catch()` directly throws `TypeError: ... .catch is not a function`, crashing the digest every hour.

The earlier `Promise.resolve(query).catch(...)` pattern on the snapshot fetch at the same function's top is safe because `Promise.resolve()` converts the thenable into a real Promise before `.catch()` is chained.

**Bug 2 — `persistFill` ON CONFLICT error**

`lib/executionEngine.js` `persistFill()` uses:

```js
.upsert(fillData, { onConflict: 'upbit_trade_uuid', ignoreDuplicates: true })
```

PostgREST translates `onConflict: 'upbit_trade_uuid'` to:

```sql
INSERT INTO v2_fills (...) ON CONFLICT (upbit_trade_uuid) DO NOTHING
```

PostgreSQL can only resolve a bare `ON CONFLICT (column)` clause against a **non-partial** unique constraint or index on that column. The existing index from migration 031 is **partial**:

```sql
CREATE UNIQUE INDEX idx_v2_fills_upbit_trade_uuid
  ON v2_fills(upbit_trade_uuid)
  WHERE upbit_trade_uuid IS NOT NULL;  -- ← partial
```

Because the index has a `WHERE` clause, Postgres cannot match it to `ON CONFLICT (upbit_trade_uuid)` without an identical predicate in the `ON CONFLICT` clause. The result is:

```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```

This fires on every real fill (where `upbit_trade_uuid IS NOT NULL`), meaning the fill row may be inserted successfully but error noise appears in PM2 logs, and any re-run would attempt a duplicate insert with no conflict protection.

## C. exact patch diff

**`pi-trader/index.js` — `hourlyDigest()`**

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

**`supabase/migrations/041_v2_fills_nonpartial_uuid_index.sql` (new file)**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
  ON v2_fills(upbit_trade_uuid);
```

**`supabase/init_schema.sql`**

```diff
+-- Non-partial unique index required so PostgREST ON CONFLICT (upbit_trade_uuid)
+-- can resolve a conflict target.
+CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
+  ON v2_fills(upbit_trade_uuid);
```

## D. exact SQL needed

Run on live Supabase (or apply migration 041):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
  ON v2_fills(upbit_trade_uuid);
```

This is safe on a live table: `CREATE UNIQUE INDEX IF NOT EXISTS` acquires `ShareLock`, not `AccessExclusiveLock`, so reads/writes continue during the build. Building fails only if duplicate non-NULL values already exist in `upbit_trade_uuid` — if it does, identify and remove the duplicates first:

```sql
-- Check for duplicates before creating the index
SELECT upbit_trade_uuid, COUNT(*)
FROM v2_fills
WHERE upbit_trade_uuid IS NOT NULL
GROUP BY upbit_trade_uuid
HAVING COUNT(*) > 1;
```

The partial indexes from migration 031 (`idx_v2_fills_upbit_trade_uuid` and `idx_v2_fills_synthetic_order`) can remain; they enforce their own narrower constraints and do not conflict with the new index.

## E. restart/redeploy steps

1. Apply the SQL (via Supabase dashboard SQL editor or migration runner):
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_fills_upbit_trade_uuid_full
     ON v2_fills(upbit_trade_uuid);
   ```
2. Deploy the updated `pi-trader/index.js` to the live host.
3. Restart PM2:
   ```
   pm2 restart pi-trader
   ```
4. Verify in next hourly cron run (`:00` of the next hour): no `[hourly] Digest error` in PM2 logs.
5. Verify on next real fill: no `persistFill DB error` in PM2 logs.
