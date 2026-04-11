# Reconciliation Guarded Auto-Adopt Patch

**Purpose:** Add a self-healing path inside `runReconciliation` that creates a single managed position for each eligible supported asset where the exchange holds a real balance but the DB has zero active positions — resolving the "adoption_not_complete + balance_mismatch" double-freeze without operator intervention.

---

## A. Files / Functions Changed

| File | Change |
|------|--------|
| `lib/reconciliationEngine.js` | Added constants `AUTO_ADOPT_ELIGIBLE`, `AUTO_ADOPT_DUST_MIN`; added functions `emitAutoAdoptSkipped`, `attemptAutoAdopt`; modified `runReconciliation` to call auto-adopt before checks and emit resolution events |

No other files were modified. No schema changes required.

---

## B. Exact Patch Diff

```diff
--- a/lib/reconciliationEngine.js
+++ b/lib/reconciliationEngine.js
@@ -43,6 +43,15 @@ const UPBIT_SYMBOL_MAP = {
   BTC: 'BTC', ETH: 'ETH', SOL: 'SOL',
 };
 
+// ─── Auto-adopt configuration ─────────────────────────────────────────────────
+// Assets eligible for reconciliation-triggered guarded auto-adopt.
+// Kept narrow intentionally — only add assets after explicit operator review.
+const AUTO_ADOPT_ELIGIBLE = new Set(['BTC', 'ETH']);
+
+// Minimum on-exchange qty (exclusive) to treat a holding as non-dust.
+// Sized below Upbit's ₩5K minimum order at typical price floors.
+const AUTO_ADOPT_DUST_MIN = { BTC: 0.000001, ETH: 0.00001 };
+

--- after checkPositionIntegrity() and before runReconciliation() ---

+// ─── Guarded auto-adopt ───────────────────────────────────────────────────────
+
+/** Emit a structured AUTO_ADOPT_SKIPPED event and log to console. */
+async function emitAutoAdoptSkipped(supabase, coin, reason, extra) {
+  console.log(`[reconcile/auto-adopt] SKIPPED ${coin}: ${reason}`);
+  try {
+    await supabase.from('bot_events').insert({
+      event_type:   'AUTO_ADOPT_SKIPPED',
+      severity:     'info',
+      subsystem:    'reconciliation_auto_adopt',
+      message:      `${coin} auto-adopt skipped: ${reason}`,
+      context_json: { asset: coin, reason, ...extra },
+    });
+  } catch (_) {}
+}
+
+/**
+ * Guarded auto-adopt: create exactly one managed `adopted` position for each
+ * eligible asset that passes ALL guards. See guard list below.
+ * Emits AUTO_ADOPT_CONSIDERED / AUTO_ADOPT_SKIPPED / AUTO_ADOPT_CREATED events.
+ */
+async function attemptAutoAdopt(supabase, accounts, supportedCoins) { ... }

--- inside runReconciliation(), after exchange balance fetch, before checks ---

+  // ── Guarded auto-adopt ─────────────────────────────────────────────────────
+  let autoAdoptResult = { adoptedAssets: [], skippedAssets: [] };
+  {
+    const adoptionPreCheck = await checkAdoptionComplete(supabase);
+    if (!adoptionPreCheck.passed) {
+      console.log('[reconcile] No completed adoption_run — evaluating guarded auto-adopt');
+      autoAdoptResult = await attemptAutoAdopt(supabase, accounts, supportedCoins);
+    }
+  }

--- inside runReconciliation(), after `const passed = ...` ---

+  // ── Emit AUTO_ADOPT_RESOLVED_RECONCILIATION per auto-adopted asset ─────────
+  for (const adopted of autoAdoptResult.adoptedAssets) {
+    await supabase.from('bot_events').insert({
+      event_type:   'AUTO_ADOPT_RESOLVED_RECONCILIATION',
+      severity:     passed ? 'info' : 'warn',
+      ...
+    });
+  }
```

The complete verbatim diff is obtainable at any time via:
```
git diff lib/reconciliationEngine.js
```

---

## C. Exact Safe Auto-Adopt Rules

Auto-adopt for an asset fires **only** when ALL five guards pass simultaneously:

| # | Guard | Failure behaviour |
|---|-------|------------------|
| 1 | Asset is in `AUTO_ADOPT_ELIGIBLE` (`BTC`, `ETH`) | Skip — SOL and all other assets never auto-adopt |
| 2 | Exchange `balance + locked > AUTO_ADOPT_DUST_MIN` (BTC: 0.000001, ETH: 0.00001) | Skip — dust or zero balance |
| 3 | Exchange `avg_buy_price > 0` | Skip — cannot create position without cost basis |
| 4 | DB count of `positions` with `state IN ('open','adopted','partial') AND managed = true AND asset = coin` is **zero** | Skip — position already exists; use drift-heal instead |
| 5 | DB count of `orders` with `state IN ('intent_created','submitted','accepted','partially_filled') AND asset = coin` is **zero** | Skip — fill in flight; wait for order resolution first |

Any DB read error in guards 3–5 is treated as **fail-closed** (asset is skipped, freeze preserved).

---

## D. Position Fields for Auto-Adopted Rows

| Column | Value | Reason |
|--------|-------|--------|
| `asset` | exchange `currency` | Identity |
| `strategy_tag` | `'unassigned'` | Safe default; `checkOwnershipClarity` accepts it; bot promotes to `'tactical'` on first action |
| `qty_open` | `acc.balance + acc.locked` | Full exchange qty; matches `checkBalanceMatch` comparison |
| `qty_total` | same as `qty_open` | First adoption — no partial sells yet |
| `avg_cost_krw` | `acc.avg_buy_price` (numeric) | Exchange-reported cost basis; `syncPositionsFromExchange` keeps it updated every tick |
| `realized_pnl` | `0` | No fills recorded for pre-existing holdings |
| `entry_reason` | `'reconciliation_auto_adopt'` | Distinguishes this path from manual `adopted_at_startup` and bot `bot_managed` opens |
| `state` | `'adopted'` | Only valid active non-bot state; included in `checkBalanceMatch`, `getOpenPositions`, dashboard |
| `origin` | `'adopted_at_startup'` | Only schema-valid non-bot origin (CHECK constraint); `operator_note` distinguishes auto from manual |
| `managed` | `true` | Bot must be able to manage it; required by `getOpenPositions` filter |
| `supported_universe` | `true` | Required by `checkPositionIntegrity` for managed positions |
| `adoption_timestamp` | `now()` | **Mandatory** — `positions_adopted_has_timestamp` constraint rejects null when `origin = 'adopted_at_startup'` |
| `operator_note` | `'auto_adopted_by_reconciliation_engine'` | Distinguishes from a manual SQL adoption (`docs/manual_adopt_live_holdings.md`) |

A corresponding `adoption_runs` row with `status = 'complete'` is inserted atomically after all positions are created so `checkAdoptionComplete` passes on the same reconciliation cycle.

---

## E. Cases That Still Remain Frozen

Auto-adopt does **not** clear these; they require operator intervention:

| Condition | Why frozen |
|-----------|-----------|
| SOL or any non-BTC/ETH asset has a balance mismatch | Not in `AUTO_ADOPT_ELIGIBLE`; add to the set only after explicit review |
| Exchange `avg_buy_price = 0` or missing | No cost basis — cannot create a valid position |
| Exchange balance ≤ dust threshold | Rounding artifact; not worth adopting |
| DB already has an active managed position but qty doesn't match | Use drift auto-heal (already in `checkBalanceMatch`) or operator fix |
| Pending/unresolved orders exist for the asset | Fill may change the qty; wait for `resolveStuckOrders` to complete first |
| Any guard DB read fails | Fail-closed by design |
| `adoption_runs` insert succeeds but position insert fails | Position not created; freeze preserved |
| `adoption_runs` insert fails after position created | Position exists but `checkAdoptionComplete` still fails; operator inserts one `adoption_runs` row manually (see `docs/manual_adopt_live_holdings.md`) |
| `checkNoUnresolvedOrders` fails globally | Unrelated orders blocking trading |
| `checkPositionIntegrity` or `checkOwnershipClarity` flags something else | Pre-existing metadata problem |
| Exchange unreachable | Exchange fetch fails before auto-adopt can run |

---

## F. SQL / Config Needed

**No schema migration required.** All fields used (`adopted_at_startup`, `unassigned`, `adopted`) are already valid values in the existing CHECK constraints.

No `app_settings` or config table changes needed.

**Verification query after a bot restart where auto-adopt fires:**

```sql
-- Confirm auto-adopted positions
SELECT position_id, asset, state, origin, strategy_tag,
       qty_open, avg_cost_krw, adoption_timestamp, operator_note, entry_reason
FROM positions
WHERE entry_reason = 'reconciliation_auto_adopt'
ORDER BY created_at DESC;

-- Confirm adoption_run created by auto-adopt
SELECT id, status, adopted_count, adopted_assets, completed_at
FROM adoption_runs
ORDER BY run_at DESC
LIMIT 5;

-- Confirm structured events emitted
SELECT event_type, message, created_at
FROM bot_events
WHERE subsystem = 'reconciliation_auto_adopt'
ORDER BY created_at DESC
LIMIT 20;
```

**If auto-adopt fires and adoption_runs insert fails** (edge case), run manually:

```sql
INSERT INTO adoption_runs (status, adopted_count, skipped_count, unsupported_count, adopted_assets, completed_at)
VALUES ('complete', 2, 0, 0, '["BTC","ETH"]'::jsonb, now());
```

---

## G. Deploy / Restart Steps

1. The changes are live in `lib/reconciliationEngine.js` — no npm install or build step required (pure JS).
2. **Do not clear the freeze manually.** Let the bot restart trigger `runReconciliation` automatically.
3. Restart the bot process. The startup sequence calls:
   - `resolveStuckOrders` (clears any stuck orders first)
   - `backfillOrphanedFills` (repairs missing fills)
   - `runReconciliation` ← auto-adopt fires here if eligible
4. On the next reconciliation cycle, watch logs for:
   ```
   [reconcile] No completed adoption_run — evaluating guarded auto-adopt
   [reconcile/auto-adopt] AUTO_ADOPT_CREATED: BTC qty=0.00802427 avg=₩... pos=...
   [reconcile/auto-adopt] AUTO_ADOPT_CREATED: ETH qty=0.26414875 avg=₩... pos=...
   [reconcile/auto-adopt] adoption_run created — 2 asset(s) adopted
   [reconcile] ✓ All checks passed — trading enabled
   ```
5. Confirm in Supabase dashboard: two `positions` rows with `entry_reason = 'reconciliation_auto_adopt'` and one `adoption_runs` row with `status = 'complete'`.
6. Confirm `bot_events` contains `AUTO_ADOPT_RESOLVED_RECONCILIATION` with `reconciliation_resolved: true` for each asset.

**To expand auto-adopt to SOL in the future**, add `'SOL'` to `AUTO_ADOPT_ELIGIBLE` in `lib/reconciliationEngine.js` and add a dust threshold entry to `AUTO_ADOPT_DUST_MIN`. No other changes needed.
