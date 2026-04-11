# Auto-Adopt Execution Fix

## A. Exact Live Reconciliation Entrypoint

`pi-trader/index.js` → `startupSequence()` calls in order:

```
1. reconEngine.loadFreezeState(supabase)          — restore persisted freeze
2. adopter.runAdoption(supabase, coins, 'live')   — portfolioAdopter
3. reconEngine.resolveStuckOrders(supabase)
4. reconEngine.backfillOrphanedFills(supabase)
5. reconEngine.runReconciliation(supabase, coins, 'startup')  ← auto-adopt lives here
```

`pollReconcileTrigger()` (every 10 s) calls `reconEngine.runReconciliation(supabase, coins, 'manual')` via `reconcile('manual')` — same entrypoint.

---

## B. Exact Reason Auto-Adopt Never Executed

**Root cause:** The trigger condition in `runReconciliation` was wrong.

```js
// OLD — BROKEN
const adoptionPreCheck = await checkAdoptionComplete(supabase);
if (!adoptionPreCheck.passed) {          // ← only fires when NO adoption_run exists
  autoAdoptResult = await attemptAutoAdopt(...);
}
```

**Execution path that silently skips auto-adopt:**

| Step | What happened |
|------|--------------|
| `adopter.runAdoption` (step 2) | Found an existing `adoption_runs` row with `status = 'complete'` from a prior deployment → returned `{ alreadyDone: true }` → **skipped position creation** |
| `runReconciliation` (step 5) | `checkAdoptionComplete` queried `adoption_runs` → found the complete row → **returned `{ passed: true }`** |
| Auto-adopt trigger | `!adoptionPreCheck.passed` → **false** → `attemptAutoAdopt` was **never called** |
| `checkBalanceMatch` | Exchange has BTC/ETH, DB has zero positions → **freeze** |

The `adoption_runs` table had a complete record. `checkAdoptionComplete` passed. The guard was `!passed` → dead branch. No `AUTO_ADOPT_CONSIDERED` events were emitted because the function was never reached.

---

## C. Exact Patch Diff

```diff
--- a/lib/reconciliationEngine.js
+++ b/lib/reconciliationEngine.js

@@ attemptAutoAdopt — adoption_run insert block @@

-  // If this insert fails, positions exist but checkAdoptionComplete will still fail.
+  // Skip if a complete run already exists (runAdoption may have recorded one on
+  // a prior startup that returned alreadyDone — no need for a duplicate).
   if (adoptedAssets.length > 0) {
     try {
-      await supabase.from('adoption_runs').insert({ ... });
-      console.log(`[reconcile/auto-adopt] adoption_run created — ...`);
+      const { data: existingRun } = await supabase.from('adoption_runs')
+        .select('id').eq('status', 'complete').limit(1).single();
+      if (!existingRun) {
+        await supabase.from('adoption_runs').insert({ ... });
+        console.log(`[reconcile/auto-adopt] adoption_run created — ...`);
+      } else {
+        console.log(`[reconcile/auto-adopt] complete adoption_run already exists (${existingRun.id}) — skipping duplicate insert`);
+      }
     } catch (err) { ... }
   }

@@ runReconciliation — auto-adopt trigger block @@

-  // OLD: only fires when adoption_run doesn't exist
-  const adoptionPreCheck = await checkAdoptionComplete(supabase);
-  if (!adoptionPreCheck.passed) {
-    autoAdoptResult = await attemptAutoAdopt(supabase, accounts, supportedCoins);
-  }

+  // NEW: fires when any eligible coin has exchange holdings but zero DB positions,
+  // regardless of adoption_run history.
+  let autoAdoptNeeded = false;
+  try {
+    for (const coin of supportedCoins.filter((c) => AUTO_ADOPT_ELIGIBLE.has(c))) {
+      const acc     = accounts.find((a) => a.currency === coin);
+      const exchQty = Number(acc?.balance ?? 0) + Number(acc?.locked ?? 0);
+      if (exchQty <= (AUTO_ADOPT_DUST_MIN[coin] ?? 0.00001)) continue;
+      const { count } = await supabase.from('positions')
+        .select('position_id', { count: 'exact', head: true })
+        .eq('asset', coin)
+        .in('state', ['open', 'adopted', 'partial'])
+        .eq('managed', true);
+      if ((count ?? 1) === 0) {
+        console.log(`[reconcile] auto-adopt trigger: ${coin} — exchange qty=${exchQty} DB managed positions=0`);
+        autoAdoptNeeded = true;
+        break;
+      }
+    }
+  } catch (preCheckErr) {
+    console.warn('[reconcile] auto-adopt pre-check error (skipping auto-adopt):', preCheckErr.message);
+  }
+
+  if (autoAdoptNeeded) {
+    console.log('[reconcile] Exchange holdings with no DB positions found — running guarded auto-adopt');
+    autoAdoptResult = await attemptAutoAdopt(supabase, accounts, supportedCoins);
+  }
```

Full verbatim diff: `git diff lib/reconciliationEngine.js`

---

## D. New Logs Added for Proof

On a restart where the fix fires, PM2 logs will show this sequence in order:

```
[reconcile] auto-adopt trigger: BTC — exchange qty=0.00802427 DB managed positions=0
[reconcile] Exchange holdings with no DB positions found — running guarded auto-adopt
[reconcile/auto-adopt] BTC: evaluating auto-adopt (exchQty=0.00802427 exchAvgCost=...)
[reconcile/auto-adopt] AUTO_ADOPT_CREATED: BTC qty=0.00802427 avg=₩... pos=...
[reconcile/auto-adopt] ETH: evaluating auto-adopt (exchQty=0.26414875 exchAvgCost=...)
[reconcile/auto-adopt] AUTO_ADOPT_CREATED: ETH qty=0.26414875 avg=₩... pos=...
[reconcile/auto-adopt] complete adoption_run already exists (...) — skipping duplicate insert
[reconcile] Auto-adopt created 2 position(s) — proceeding to full reconciliation checks
[reconcile] ✓ All checks passed — trading enabled
```

`bot_events` will contain:
- `AUTO_ADOPT_CONSIDERED` × 2 (one per coin)
- `AUTO_ADOPT_CREATED` × 2
- `AUTO_ADOPT_RESOLVED_RECONCILIATION` × 2 with `reconciliation_resolved: true`
- `RECONCILIATION` with `trading_enabled: true`

If the trigger fires but a guard blocks adoption, you will see `AUTO_ADOPT_SKIPPED` with the exact reason instead of `AUTO_ADOPT_CREATED`.

If the trigger does NOT fire (everything already OK), none of the above events are emitted — that means positions already exist and no action was needed.

---

## E. Deploy / Restart Steps

```
pm2 restart pi-trader
pm2 logs pi-trader --lines 80
```

Watch for `[reconcile] auto-adopt trigger:` within the first 10 seconds. If it appears and is followed by `✓ All checks passed`, the fix worked.

If `auto-adopt trigger` does NOT appear, the pre-check found that DB managed positions already exist for the eligible coins — check:

```sql
SELECT asset, state, origin, managed, qty_open
FROM positions
WHERE asset IN ('BTC','ETH')
  AND state IN ('open','adopted','partial')
  AND managed = true;
```

If that returns rows, the freeze is from a different check (orders, integrity, etc.) — read the `freeze_reasons` in `app_settings` where `key = 'system_freeze'`.
