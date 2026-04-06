# Tactical Profit Floor Exit

## A. exact files/functions changed

| File | Function / location | Change |
|------|---------------------|--------|
| `lib/signalEngine.js` | `getTacticalProfitFloorDiagnostics()` | New: eligibility + blocker aligned with `tactical_floor` exit |
| `lib/signalEngine.js` | `evaluateExit()` | After `reclaim_harvest`, before generic `harvest`: push `tactical_floor` for non-reclaim tactical when guards pass |
| `lib/signalEngine.js` | `module.exports` | Export `getTacticalProfitFloorDiagnostics` |
| `lib/cryptoTraderV2.js` | `executeCycleV2()` sell branch | Call diagnostics; extend `sell_checks` and `EXIT_EVALUATION` `context_json` |
| `supabase/init_schema.sql` | `bot_config` | `exit_tactical_profit_floor_hours`, `exit_tactical_profit_floor_size_pct` |
| `supabase/migrations/040_tactical_profit_floor.sql` | New migration | `ALTER TABLE bot_config ADD COLUMN ...` |

**Audit reference (unchanged wiring unless noted):**

- **Above edge / required edge:** `lib/cryptoTraderV2.js` — `reqEdgePct` from `exit_safety_buffer_pct`; `aboveEdgeVal`; `lib/signalEngine.js` `evaluateExit()` net gate `netGainPct < minNet` before profit exits.
- **Quick trim1 / trim2:** `lib/signalEngine.js` `evaluateExit()` after harvest blocks.
- **Generic harvest:** `lib/signalEngine.js` `evaluateExit()` — trim `harvest`, `exit_profit_harvest_hours` / `exit_profit_harvest_size_pct`.
- **Reclaim harvest:** `lib/signalEngine.js` `evaluateExit()` — trim `reclaim_harvest`, prefix `dt_reclaim_starter`.
- **Blocker `above_edge_no_exit_condition_met` (DECISION_CYCLE):** `lib/cryptoTraderV2.js` when `aboveEdgeVal && !exitFiredVal`.
- **Blocker `above_edge_but_no_exit_condition_met` (EXIT_EVALUATION log):** same branch when `aboveEdge && !exitFired`.
- **`strategy_tag` / `entry_reason`:** `position.strategy_tag`, `position.entry_reason` on DB row; reclaim detection via `entry_reason` prefix in `isDowntrendReclaimStarterPosition()`.

---

## B. exact patch diff

```diff
diff --git a/lib/cryptoTraderV2.js b/lib/cryptoTraderV2.js
index 5a64b946..1da3ffd1 100644
--- a/lib/cryptoTraderV2.js
+++ b/lib/cryptoTraderV2.js
@@ -648,6 +648,14 @@ async function executeCycleV2(supabase, opts = {}) {
           firedTrims,
           exits,
         });
+        const tacticalFloorDiag = signalEngine.getTacticalProfitFloorDiagnostics(position, cfg, {
+          netGainPct,
+          gainPct: gainPctRaw,
+          heldHours: heldHoursDiag,
+          trim1Target: trim1TargetDiag,
+          firedTrims,
+          exits,
+        });
         const regimeBreakHit = exits.some((e) => e.trim === 'regime_break');
         const trailHit       = exits.some((e) => e.trim === 'runner');
 
@@ -682,6 +690,11 @@ async function executeCycleV2(supabase, opts = {}) {
             reclaim_harvest_would_fire: reclaimDiag.reclaim_harvest_would_fire,
             reclaim_harvest_in_exits:   reclaimDiag.reclaim_harvest_in_exits,
             reclaim_harvest_fired:      exitFiredVal && exits[0]?.trim === 'reclaim_harvest',
+            tactical_profit_floor_considered: tacticalFloorDiag.tactical_profit_floor_considered,
+            tactical_profit_floor_blocker:    tacticalFloorDiag.tactical_profit_floor_blocker,
+            tactical_profit_floor_would_fire: tacticalFloorDiag.tactical_profit_floor_would_fire,
+            tactical_profit_floor_in_exits:  tacticalFloorDiag.tactical_profit_floor_in_exits,
+            tactical_profit_floor_fired:      exitFiredVal && exits[0]?.trim === 'tactical_floor',
           };
           if (exitFiredVal && !sellBlocker) {
             cycleDecisions[coin].final_action = 'SELL_TRIGGERED';
@@ -750,6 +763,11 @@ async function executeCycleV2(supabase, opts = {}) {
                 reclaim_harvest_would_fire:   reclaimDiag.reclaim_harvest_would_fire,
                 reclaim_harvest_in_exits:     reclaimDiag.reclaim_harvest_in_exits,
                 reclaim_harvest_fired:        exitFired && exits[0]?.trim === 'reclaim_harvest',
+                tactical_profit_floor_considered: tacticalFloorDiag.tactical_profit_floor_considered,
+                tactical_profit_floor_blocker:      tacticalFloorDiag.tactical_profit_floor_blocker,
+                tactical_profit_floor_would_fire:   tacticalFloorDiag.tactical_profit_floor_would_fire,
+                tactical_profit_floor_in_exits:     tacticalFloorDiag.tactical_profit_floor_in_exits,
+                tactical_profit_floor_fired:        exitFired && exits[0]?.trim === 'tactical_floor',
                 indicators: {
                   rsi:      ind.rsi14?.toFixed(1),
                   bb_pctB:  ind.bbPctB?.toFixed(3),
diff --git a/lib/signalEngine.js b/lib/signalEngine.js
index 9a90e4fb..375f806e 100644
--- a/lib/signalEngine.js
+++ b/lib/signalEngine.js
@@ -351,6 +351,94 @@ function getReclaimHarvestDiagnostics(position, cfg, { netGainPct, gainPct, held
   };
 }
 
+/**
+ * Diagnostics for tactical profit-floor partial exit (non-reclaim tactical only).
+ * Must stay aligned with evaluateExit tactical_floor branch.
+ */
+function getTacticalProfitFloorDiagnostics(position, cfg, { netGainPct, gainPct, heldHours, trim1Target, firedTrims, exits }) {
+  const minNet = cfg.exit_safety_buffer_pct ?? SAFETY_BUFFER_PCT;
+  const tactical = position.strategy_tag === 'tactical';
+  const reclaimOrigin = isDowntrendReclaimStarterPosition(position);
+  const floorInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'tactical_floor');
+
+  if (!tactical) {
+    return {
+      tactical_profit_floor_considered: false,
+      tactical_profit_floor_blocker:    null,
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   false,
+    };
+  }
+
+  if (reclaimOrigin) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    'reclaim_origin_uses_reclaim_harvest',
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   floorInExits,
+    };
+  }
+
+  if (netGainPct == null || gainPct == null) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    'pnl_unavailable',
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   false,
+    };
+  }
+
+  if (netGainPct < minNet) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    'below_net_gate',
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   floorInExits,
+    };
+  }
+  if (firedTrims.includes('tactical_floor')) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    'tactical_floor_already_fired',
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   floorInExits,
+    };
+  }
+  if (firedTrims.includes('trim1')) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    'trim1_already_fired',
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   false,
+    };
+  }
+  if (gainPct >= trim1Target) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    'trim1_gross_threshold_reached',
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   false,
+    };
+  }
+
+  const floorHours = cfg.exit_tactical_profit_floor_hours ?? 2.5;
+  if (heldHours < floorHours) {
+    return {
+      tactical_profit_floor_considered: true,
+      tactical_profit_floor_blocker:    `held_lt_${floorHours}h`,
+      tactical_profit_floor_would_fire: false,
+      tactical_profit_floor_in_exits:   false,
+    };
+  }
+
+  return {
+    tactical_profit_floor_considered: true,
+    tactical_profit_floor_blocker:    null,
+    tactical_profit_floor_would_fire: true,
+    tactical_profit_floor_in_exits:   floorInExits,
+  };
+}
+
 function evaluateExit(position, ind, regime, feeRate, cfg, peakPrice) {
   const exits = [];
   if (!position || position.qty_open <= 0) return exits;
@@ -454,6 +542,28 @@ function evaluateExit(position, ind, regime, feeRate, cfg, peakPrice) {
     });
   }
 
+  // ── Tactical profit floor — non-reclaim tactical only, before generic 4h harvest ──
+  // Banks a small win when above edge but below trim1; reclaim entries use reclaim_harvest.
+  const tacticalFloorHours   = cfg.exit_tactical_profit_floor_hours    ?? 2.5;
+  const tacticalFloorSizePct = cfg.exit_tactical_profit_floor_size_pct ?? 12;
+  const tacticalFloorFired   = firedTrims.includes('tactical_floor');
+  if (
+    position.strategy_tag === 'tactical' &&
+    !isDowntrendReclaimStarterPosition(position) &&
+    !tacticalFloorFired &&
+    !firedTrims.includes('trim1') &&
+    heldHours >= tacticalFloorHours &&
+    gainPct < trim1Target
+  ) {
+    exits.push({
+      asset,
+      side:    'sell',
+      sellPct: tacticalFloorSizePct,
+      reason:  `tactical_floor_${netGainPct.toFixed(2)}pct_net_${(Math.round(heldHours * 10) / 10).toFixed(1)}h`,
+      trim:    'tactical_floor',
+    });
+  }
+
   // ── Profit-floor harvest — small realization after sustained above-edge ────
   // Fires once when the position has been held for exit_profit_harvest_hours
   // (default 4h) AND net gain is already above the safety buffer, but has not
@@ -645,5 +755,6 @@ module.exports = {
   isFullyProtected,
   isDowntrendReclaimStarterPosition,
   getReclaimHarvestDiagnostics,
+  getTacticalProfitFloorDiagnostics,
   requiredEdge,
 };
diff --git a/supabase/init_schema.sql b/supabase/init_schema.sql
index 5af1ca67..94ea2cfe 100644
--- a/supabase/init_schema.sql
+++ b/supabase/init_schema.sql
@@ -707,6 +707,9 @@ CREATE TABLE IF NOT EXISTS bot_config (
   -- Reclaim starter early partial exit (migration 039); sub-hour hold, smaller than trim1
   exit_reclaim_harvest_hours    NUMERIC(5,2)         DEFAULT 0.75,
   exit_reclaim_harvest_size_pct NUMERIC(5,2)         DEFAULT 12.0,
+  -- Tactical profit floor (migration 040); non-reclaim tactical, before generic harvest
+  exit_tactical_profit_floor_hours    NUMERIC(5,2)   DEFAULT 2.5,
+  exit_tactical_profit_floor_size_pct NUMERIC(5,2)   DEFAULT 12.0,
   addon_min_dip_pct            NUMERIC(6,3)          DEFAULT 1.0,
   addon_size_mult              NUMERIC(5,3)          DEFAULT 0.5,
   buy_cooldown_ms              INTEGER               DEFAULT 1800000,
diff --git a/supabase/migrations/040_tactical_profit_floor.sql b/supabase/migrations/040_tactical_profit_floor.sql
new file mode 100644
index 00000000..d3c74cb7
--- /dev/null
+++ b/supabase/migrations/040_tactical_profit_floor.sql
@@ -0,0 +1,6 @@
+-- Tactical profit-floor partial exit: non-reclaim tactical positions, mid hold before generic harvest.
+-- Defaults: 2.5h hold, 12% size (smaller than trim1 25%).
+
+ALTER TABLE bot_config
+  ADD COLUMN IF NOT EXISTS exit_tactical_profit_floor_hours    NUMERIC(5,2) DEFAULT 2.5,
+  ADD COLUMN IF NOT EXISTS exit_tactical_profit_floor_size_pct NUMERIC(5,2) DEFAULT 12.0;
```

---

## C. exact old behavior

- After the net gate, profit exits for non-reclaim tactical positions were: **reclaim_harvest** (skipped), then **harvest** at `exit_profit_harvest_hours` (default 4h), then **trim1** / **trim2** / **runner**.
- **Reclaim-origin** tactical positions used **reclaim_harvest** only for the early partial path; other tactical positions had **no** exit between “above edge, below trim1” and the 4h **harvest** unless trim levels hit.
- `above_edge_no_exit_condition_met` / `above_edge_but_no_exit_condition_met` still applied whenever no exit row was produced while above edge.

---

## D. exact new tactical profit-floor behavior

- **Who:** `strategy_tag === 'tactical'` and **not** `dt_reclaim_starter` reclaim origin (`!isDowntrendReclaimStarterPosition`). Reclaim entries keep using **reclaim_harvest** only for that early path.
- **When (all):** past net gate; `!fired_trims.includes('tactical_floor')`; `!fired_trims.includes('trim1')`; `gainPct < trim1Target`; `heldHours >= exit_tactical_profit_floor_hours` (default **2.5**).
- **Action:** sell `exit_tactical_profit_floor_size_pct`% (default **12%**); trim key **`tactical_floor`** (one-shot via `fired_trims`).
- **Reason:** `tactical_floor_<net>pct_net_<hours>h` (hours one decimal).
- **Ordering:** Inserted **after** `reclaim_harvest`, **before** generic `harvest`; first matching exit in `exits` runs per cycle. **Regime-break** exits still return earlier in `evaluateExit` (unchanged).
- **Losses:** no sell below net gate; rule only runs after the existing net gate.

---

## E. exact SQL/config needed

1. Apply migration `040_tactical_profit_floor.sql` (or fresh `init_schema.sql`).

2. Optional tuning:

```sql
UPDATE bot_config SET
  exit_tactical_profit_floor_hours    = 2.5,
  exit_tactical_profit_floor_size_pct = 12.0
WHERE true;
```

---

## F. risks / limitations

- **Core / unassigned:** `strategy_tag` not `tactical` → rule does not apply (`tactical_profit_floor_considered: false`).
- **Reclaim overlap:** Reclaim-origin tactical positions are excluded from **tactical_floor**; they rely on **reclaim_harvest** first.
- **Same cycle as harvest:** If both **tactical_floor** and **harvest** qualify, **tactical_floor** is first in `exits`; generic **harvest** runs on a later cycle if still eligible.
- **Cooldown:** Not a protective exit; subject to `sell_cooldown_ms` like other trims.
- **SOL / assets:** Scoped by **tactical** tag only, not by coin (BTC/ETH-only not applied).
