# Reclaim Sell Realization Patch

## A. exact files/functions changed

| File | Function / location | Change |
|------|---------------------|--------|
| `lib/signalEngine.js` | `isDowntrendReclaimStarterPosition()` | New: `entry_reason` prefix `dt_reclaim_starter` |
| `lib/signalEngine.js` | `getReclaimHarvestDiagnostics()` | New: reclaim harvest eligibility + blocker for logs |
| `lib/signalEngine.js` | `evaluateExit()` | After net gate, before generic `harvest`: push `reclaim_harvest` exit when reclaim-origin and guards pass |
| `lib/signalEngine.js` | `module.exports` | Export `isDowntrendReclaimStarterPosition`, `getReclaimHarvestDiagnostics` |
| `lib/cryptoTraderV2.js` | `executeCycleV2()` sell branch | Call `getReclaimHarvestDiagnostics`; extend `sell_checks` and `EXIT_EVALUATION` `context_json` |
| `supabase/init_schema.sql` | `bot_config` | Columns `exit_reclaim_harvest_hours`, `exit_reclaim_harvest_size_pct` |
| `supabase/migrations/039_reclaim_harvest_exit.sql` | New migration | `ALTER TABLE bot_config ADD COLUMN ...` |

**Related (audit only — unchanged this patch):**

- Quick trim 1 / trim 2 / runner: `lib/signalEngine.js` → `evaluateExit()`
- Profit-floor harvest: `lib/signalEngine.js` → `evaluateExit()` (runs after `reclaim_harvest` in the exits array)
- `above_edge_no_exit_condition_met`: `lib/cryptoTraderV2.js` when `aboveEdgeVal && !exitFiredVal`
- Final sell reason: `cycleDecisions[coin].final_reason` = `sell:${exits[0]?.reason}` when eligible
- `entry_reason` on positions: set on buy fill in `lib/executionEngine.js` / reconciliation; read on position rows in V2 sell loop

---

## B. exact patch diff

```diff
diff --git a/lib/cryptoTraderV2.js b/lib/cryptoTraderV2.js
index 56e6a436..5a64b946 100644
--- a/lib/cryptoTraderV2.js
+++ b/lib/cryptoTraderV2.js
@@ -636,6 +636,18 @@ async function executeCycleV2(supabase, opts = {}) {
         const aboveEdgeVal = netGainPct != null && netGainPct >= reqEdgePct;
         const exitFiredVal = exits.length > 0;
         const firedTrims   = position.fired_trims ?? [];
+        const trim1TargetDiag = cfg.exit_quick_trim1_gross_pct ?? 0.85;
+        const heldHoursDiag = position.opened_at
+          ? (Date.now() - new Date(position.opened_at).getTime()) / 3600000
+          : 0;
+        const reclaimDiag = signalEngine.getReclaimHarvestDiagnostics(position, cfg, {
+          netGainPct,
+          gainPct: gainPctRaw,
+          heldHours: heldHoursDiag,
+          trim1Target: trim1TargetDiag,
+          firedTrims,
+          exits,
+        });
         const regimeBreakHit = exits.some((e) => e.trim === 'regime_break');
         const trailHit       = exits.some((e) => e.trim === 'runner');
 
@@ -664,6 +676,12 @@ async function executeCycleV2(supabase, opts = {}) {
             bb_pctB:                ind.bbPctB != null ? +ind.bbPctB.toFixed(3) : null,
             final_sell_eligible:    exitFiredVal,
             final_sell_blocker:     sellBlocker,
+            reclaim_origin:         reclaimDiag.reclaim_origin,
+            reclaim_harvest_considered: reclaimDiag.reclaim_harvest_considered,
+            reclaim_harvest_blocker:    reclaimDiag.reclaim_harvest_blocker,
+            reclaim_harvest_would_fire: reclaimDiag.reclaim_harvest_would_fire,
+            reclaim_harvest_in_exits:   reclaimDiag.reclaim_harvest_in_exits,
+            reclaim_harvest_fired:      exitFiredVal && exits[0]?.trim === 'reclaim_harvest',
           };
           if (exitFiredVal && !sellBlocker) {
             cycleDecisions[coin].final_action = 'SELL_TRIGGERED';
@@ -726,6 +744,12 @@ async function executeCycleV2(supabase, opts = {}) {
                 eligible:           exitFired,
                 blocker_summary:    blockerSummary,
                 exits_triggered:    exits.map((e) => ({ reason: e.reason, sell_pct: e.sellPct, trim: e.trim })),
+                reclaim_origin:               reclaimDiag.reclaim_origin,
+                reclaim_harvest_considered:   reclaimDiag.reclaim_harvest_considered,
+                reclaim_harvest_blocker:      reclaimDiag.reclaim_harvest_blocker,
+                reclaim_harvest_would_fire:   reclaimDiag.reclaim_harvest_would_fire,
+                reclaim_harvest_in_exits:     reclaimDiag.reclaim_harvest_in_exits,
+                reclaim_harvest_fired:        exitFired && exits[0]?.trim === 'reclaim_harvest',
                 indicators: {
                   rsi:      ind.rsi14?.toFixed(1),
                   bb_pctB:  ind.bbPctB?.toFixed(3),
diff --git a/lib/signalEngine.js b/lib/signalEngine.js
index 803d6af9..9a90e4fb 100644
--- a/lib/signalEngine.js
+++ b/lib/signalEngine.js
@@ -259,6 +259,98 @@ function isFullyProtected(position) {
   );
 }
 
+/** True when the position was opened via evaluateDowntrendReclaimStarter (reason prefix match). */
+function isDowntrendReclaimStarterPosition(position) {
+  const r = position?.entry_reason;
+  return typeof r === 'string' && r.startsWith('dt_reclaim_starter');
+}
+
+/**
+ * Diagnostics for reclaim-aware partial harvest (DECISION_CYCLE / EXIT_EVALUATION).
+ * Must stay aligned with evaluateExit reclaim_harvest branch.
+ */
+function getReclaimHarvestDiagnostics(position, cfg, { netGainPct, gainPct, heldHours, trim1Target, firedTrims, exits }) {
+  const minNet = cfg.exit_safety_buffer_pct ?? SAFETY_BUFFER_PCT;
+  const reclaimOrigin = isDowntrendReclaimStarterPosition(position);
+  const reclaimInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'reclaim_harvest');
+
+  if (!reclaimOrigin) {
+    return {
+      reclaim_origin:               false,
+      reclaim_harvest_considered:   false,
+      reclaim_harvest_blocker:      null,
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     false,
+    };
+  }
+
+  if (netGainPct == null || gainPct == null) {
+    return {
+      reclaim_origin:               true,
+      reclaim_harvest_considered:   true,
+      reclaim_harvest_blocker:      'pnl_unavailable',
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     false,
+    };
+  }
+
+  if (netGainPct < minNet) {
+    return {
+      reclaim_origin:               true,
+      reclaim_harvest_considered:   true,
+      reclaim_harvest_blocker:      'below_net_gate',
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     reclaimInExits,
+    };
+  }
+  if (firedTrims.includes('reclaim_harvest')) {
+    return {
+      reclaim_origin:               true,
+      reclaim_harvest_considered:   true,
+      reclaim_harvest_blocker:      'reclaim_harvest_already_fired',
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     reclaimInExits,
+    };
+  }
+  if (firedTrims.includes('trim1')) {
+    return {
+      reclaim_origin:               true,
+      reclaim_harvest_considered:   true,
+      reclaim_harvest_blocker:      'trim1_already_fired',
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     false,
+    };
+  }
+  if (gainPct >= trim1Target) {
+    return {
+      reclaim_origin:               true,
+      reclaim_harvest_considered:   true,
+      reclaim_harvest_blocker:      'trim1_gross_threshold_reached',
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     false,
+    };
+  }
+
+  const reclaimHours = cfg.exit_reclaim_harvest_hours ?? 0.75;
+  if (heldHours < reclaimHours) {
+    return {
+      reclaim_origin:               true,
+      reclaim_harvest_considered:   true,
+      reclaim_harvest_blocker:      `held_lt_${reclaimHours}h`,
+      reclaim_harvest_would_fire:   false,
+      reclaim_harvest_in_exits:     false,
+    };
+  }
+
+  return {
+    reclaim_origin:               true,
+    reclaim_harvest_considered:   true,
+    reclaim_harvest_blocker:      null,
+    reclaim_harvest_would_fire:   true,
+    reclaim_harvest_in_exits:     reclaimInExits,
+  };
+}
+
 function evaluateExit(position, ind, regime, feeRate, cfg, peakPrice) {
   const exits = [];
   if (!position || position.qty_open <= 0) return exits;
@@ -339,6 +431,29 @@ function evaluateExit(position, ind, regime, feeRate, cfg, peakPrice) {
 
   const firedTrims = position.fired_trims ?? [];
 
+  // ── Reclaim starter partial harvest — earlier, smaller than trim1 / generic harvest ──
+  // Positions from dt_reclaim_starter only: bank a small gain after a short hold while
+  // still below trim1 gross, without waiting exit_profit_harvest_hours (default 4h).
+  // trim name reclaim_harvest is distinct from harvest; one-shot via fired_trims.
+  const reclaimHarvestHours   = cfg.exit_reclaim_harvest_hours    ?? 0.75;
+  const reclaimHarvestSizePct = cfg.exit_reclaim_harvest_size_pct ?? 12;
+  const reclaimHarvestFired   = firedTrims.includes('reclaim_harvest');
+  if (
+    isDowntrendReclaimStarterPosition(position) &&
+    !reclaimHarvestFired &&
+    !firedTrims.includes('trim1') &&
+    heldHours >= reclaimHarvestHours &&
+    gainPct < trim1Target
+  ) {
+    exits.push({
+      asset,
+      side:    'sell',
+      sellPct: reclaimHarvestSizePct,
+      reason:  `reclaim_harvest_${netGainPct.toFixed(2)}pct_net_${Math.round(heldHours * 60)}m`,
+      trim:    'reclaim_harvest',
+    });
+  }
+
   // ── Profit-floor harvest — small realization after sustained above-edge ────
   // Fires once when the position has been held for exit_profit_harvest_hours
   // (default 4h) AND net gain is already above the safety buffer, but has not
@@ -528,5 +643,7 @@ module.exports = {
   evaluateDowntrendReclaimStarter,
   evaluateExit,
   isFullyProtected,
+  isDowntrendReclaimStarterPosition,
+  getReclaimHarvestDiagnostics,
   requiredEdge,
 };
diff --git a/supabase/init_schema.sql b/supabase/init_schema.sql
index 5568879c..5af1ca67 100644
--- a/supabase/init_schema.sql
+++ b/supabase/init_schema.sql
@@ -704,6 +704,9 @@ CREATE TABLE IF NOT EXISTS bot_config (
   exit_safety_buffer_pct       NUMERIC(6,3)          DEFAULT 0.10,
   exit_profit_harvest_hours    NUMERIC(5,1)          DEFAULT 4.0,
   exit_profit_harvest_size_pct NUMERIC(5,2)          DEFAULT 15.0,
+  -- Reclaim starter early partial exit (migration 039); sub-hour hold, smaller than trim1
+  exit_reclaim_harvest_hours    NUMERIC(5,2)         DEFAULT 0.75,
+  exit_reclaim_harvest_size_pct NUMERIC(5,2)         DEFAULT 12.0,
   addon_min_dip_pct            NUMERIC(6,3)          DEFAULT 1.0,
   addon_size_mult              NUMERIC(5,3)          DEFAULT 0.5,
   buy_cooldown_ms              INTEGER               DEFAULT 1800000,
diff --git a/supabase/migrations/039_reclaim_harvest_exit.sql b/supabase/migrations/039_reclaim_harvest_exit.sql
new file mode 100644
index 00000000..addcf1a9
--- /dev/null
+++ b/supabase/migrations/039_reclaim_harvest_exit.sql
@@ -0,0 +1,6 @@
+-- Reclaim-aware partial harvest: earlier small sell for dt_reclaim_starter positions only.
+-- Defaults: 0.75h hold, 12% size (smaller than trim1 25%).
+
+ALTER TABLE bot_config
+  ADD COLUMN IF NOT EXISTS exit_reclaim_harvest_hours    NUMERIC(5,2) DEFAULT 0.75,
+  ADD COLUMN IF NOT EXISTS exit_reclaim_harvest_size_pct NUMERIC(5,2) DEFAULT 12.0;
```

---

## C. exact old behavior

- After the net PnL gate (`netGainPct >= exit_safety_buffer_pct`), exits were evaluated in order: generic **harvest** (4h hold, size from config), **trim1** (25% at gross ≥ `exit_quick_trim1_gross_pct`), **trim2**, **runner**.
- There was **no** reclaim-entry-specific partial sell; reclaim-origin positions used the same harvest/trim rules as other tactical positions.
- `above_edge_no_exit_condition_met` applied when net was above the buffer but no exit row was produced (unchanged condition wiring).

---

## D. exact new reclaim-aware sell behavior

- **Identification:** `positions.entry_reason` is a string starting with `dt_reclaim_starter` (matches `evaluateDowntrendReclaimStarter` reason prefix).
- **New exit** (only if all hold):
  1. Reclaim-origin position.
  2. `reclaim_harvest` not already in `fired_trims`.
  3. `trim1` not in `fired_trims`.
  4. `heldHours >= exit_reclaim_harvest_hours` (default **0.75**).
  5. `gainPct < trim1` gross target (trim1 not yet reached).
  6. Net gate already passed (`netGainPct >=` safety buffer) — enforced because this block runs only after the gate.
- **Action:** sell `exit_reclaim_harvest_size_pct`% of position (default **12%**); **smaller than trim1 (25%)** and **smaller than typical regime-break BTC/ETH (50%)**.
- **Trim key:** `reclaim_harvest` (recorded in `fired_trims` like other named trims).
- **Reason string:** `reclaim_harvest_<net>pct_net_<minutes>m` (e.g. `reclaim_harvest_0.18pct_net_45m`).
- **Ordering:** `reclaim_harvest` is pushed **before** generic `harvest` and **before** trim1; one exit executes per coin per cycle (`exits[0]`).
- **Losses:** no change — sub-threshold net PnL returns before this block; no sell at a loss from this rule.

---

## E. exact SQL/config needed

1. Apply migration `039_reclaim_harvest_exit.sql` on the database (or rely on fresh deploy from `init_schema.sql` for new environments).

2. Optional tuning on singleton `bot_config`:

```sql
UPDATE bot_config SET
  exit_reclaim_harvest_hours    = 0.75,
  exit_reclaim_harvest_size_pct = 12.0
WHERE true;
```

Defaults match code fallbacks if columns are unset.

---

## F. risks / limitations

- **Prefix coupling:** Relies on `entry_reason` prefix `dt_reclaim_starter`; if the entry reason string changes format, detection breaks until updated.
- **Still one sell per cycle:** If `reclaim_harvest` and `harvest` both qualify, `reclaim_harvest` runs first; generic harvest waits for a later cycle.
- **Cooldown:** `reclaim_harvest` is not classified as a protective exit; normal `sell_cooldown_ms` applies (same as harvest/trim).
- **BTC reclaim:** Same rule applies to any reclaim-origin position (ETH-focused intent; BTC reclaim remains valid if entries exist).
- **Adds-on / mixed cost basis:** Not addressed; only `entry_reason` prefix is used.
