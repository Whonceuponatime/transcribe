# Sell Realization Patch — Profit-Floor Harvest

## A. Files / Functions Changed

| File | Function / Location | Change |
|------|---------------------|--------|
| `lib/signalEngine.js` | `evaluateExit()` — after net gate, before trim1 | Added `harvest` exit condition |
| `supabase/init_schema.sql` | `bot_config` table definition | Added `exit_profit_harvest_hours`, `exit_profit_harvest_size_pct` columns |
| `supabase/migrations/037_profit_harvest_config.sql` | New migration | `ALTER TABLE bot_config ADD COLUMN IF NOT EXISTS ...` for both new fields |

---

## B. Patch Diff

```diff
--- a/lib/signalEngine.js
+++ b/lib/signalEngine.js
@@ evaluateExit() — after "Gate: net gain must clear safety buffer" @@

   // Gate: net gain must clear safety buffer before any profit exit fires
   if (netGainPct < minNet) return exits;

   const firedTrims = position.fired_trims ?? [];

+  // ── Profit-floor harvest — small realization after sustained above-edge ────
+  // Fires once when the position has been held for exit_profit_harvest_hours
+  // (default 4h) AND net gain is already above the safety buffer, but has not
+  // yet reached the trim1 gross target. Prevents positions from sitting
+  // indefinitely at above_edge_no_exit_condition_met with realized gains of zero.
+  // Guard: only fires before trim1 and only once (harvest in fired_trims).
+  const harvestHours    = cfg.exit_profit_harvest_hours    ?? 4;
+  const harvestSizePct  = cfg.exit_profit_harvest_size_pct ?? 25;
+  const harvestFired    = firedTrims.includes('harvest');
+  if (!harvestFired && !firedTrims.includes('trim1') && heldHours >= harvestHours && gainPct < trim1Target) {
+    exits.push({
+      asset,
+      side:    'sell',
+      sellPct: harvestSizePct,
+      reason:  `harvest_${netGainPct.toFixed(2)}pct_net_${Math.round(heldHours)}h`,
+      trim:    'harvest',
+    });
+  }
+
   // ── Quick Trim 1 — 25% at first profit target ─────────────────────────────
   if (!firedTrims.includes('trim1') && gainPct >= trim1Target) {

--- a/supabase/init_schema.sql
+++ b/supabase/init_schema.sql
@@ bot_config columns @@
   exit_quick_trim1_gross_pct   NUMERIC(6,3)          DEFAULT 0.85,
   exit_quick_trim2_gross_pct   NUMERIC(6,3)          DEFAULT 1.25,
   exit_safety_buffer_pct       NUMERIC(6,3)          DEFAULT 0.10,
+  exit_profit_harvest_hours    NUMERIC(5,1)          DEFAULT 4.0,
+  exit_profit_harvest_size_pct NUMERIC(5,2)          DEFAULT 25.0,
```

---

## C. Old Sell Behavior

Exit conditions evaluated (in order) inside `evaluateExit()`:

1. **regime_break** — fires 50% sell (BTC/ETH) or 100% (SOL) on DOWNTREND; one-shot
2. **time_stop** — fires 50% sell after 30h held with flat PnL; one-shot
3. **Net gate** — if `netGainPct < exit_safety_buffer_pct (0.10%)` → return no exits
4. **trim1** — fires 25% sell when `grossPnL >= exit_quick_trim1_gross_pct (0.85%)`
5. **trim2** — fires 25% sell when trim1 already done AND `grossPnL >= 1.25%`
6. **runner** — fires 100% sell (of remainder) when drop from peak ≥ ATR×1.5

**The gap that caused `above_edge_no_exit_condition_met`:**
- A position with `grossPnL` between ~0.60% and 0.85% is above the net gate (net ≈ 0.10–0.35%) but below trim1 (0.85%).
- No exit condition fires → `evaluateExit` returns `[]` → blocker = `above_edge_no_exit_condition_met`.
- This is a dead zone. With 0.25%/side Upbit fees: any grossPnL in [0.60%, 0.85%) produces above_edge with no exit.

---

## D. New Sell Behavior

A new **`harvest`** exit fires between the net gate and trim1:

**Trigger conditions (all must be true):**
1. `netGainPct >= exit_safety_buffer_pct` (above the net gate — already guaranteed at this point)
2. `heldHours >= exit_profit_harvest_hours` (default: **4 hours**)
3. `fired_trims` does NOT include `harvest` (one-shot guard)
4. `fired_trims` does NOT include `trim1` (harvest is pre-trim1 only; once trim1 fires, harvest is irrelevant)
5. `gainPct < trim1Target` — gross gain is still below the trim1 threshold; if trim1 is already reachable, trim1 fires instead (no competition)

**Action:** sell `exit_profit_harvest_size_pct`% of the position (default: **25%**)

**Reason string in logs/diagnostics:** `harvest_<net_pnl>pct_net_<held_hours>h`  
Example: `harvest_0.18pct_net_5h`

**Exit ordering (updated):**

1. regime_break (unchanged)
2. time_stop (unchanged)
3. net gate (unchanged)
4. **harvest** ← NEW: fires once after 4h above edge, before trim1
5. trim1 (unchanged — still fires at 0.85% gross regardless of harvest)
6. trim2 (unchanged)
7. runner (unchanged)

**Key behavioral properties:**
- Harvest fires at most once per position (guarded by `fired_trims.includes('harvest')`)
- Harvest and trim1 cannot fire in the same cycle (only `exits[0]` executes per cycle). If both conditions are met in the same cycle, harvest fires first (it appears first in the exits array); trim1 fires the next eligible cycle.
- Once trim1 fires, harvest is permanently skipped (`!firedTrims.includes('trim1')` guard).
- Harvest does not prevent trim2 or runner — those depend on trim1 being in `fired_trims`.
- Harvest respects `sell_cooldown_ms` and all existing execution guards.
- The `harvest` trim name is recorded in `position.fired_trims` via the existing trim-recording logic in the execution engine.

**Scenario walkthrough:**

| Scenario | Before patch | After patch |
|----------|-------------|-------------|
| grossPnL 0.70%, held 5h | `above_edge_no_exit_condition_met` | harvest fires → 25% sold |
| grossPnL 0.90%, held 1h | trim1 fires → 25% sold | trim1 fires → 25% sold (unchanged) |
| grossPnL 0.90%, held 5h | trim1 fires → 25% sold | trim1 fires → 25% sold (harvest skipped: gainPct >= trim1Target) |
| grossPnL 0.30%, held 5h | below net gate, no exit | below net gate, no exit (unchanged) |
| grossPnL 0.70%, held 2h | `above_edge_no_exit_condition_met` | `above_edge_no_exit_condition_met` (harvest waits for 4h) |

---

## E. Config Values / SQL Required

### 1. Apply migration to live DB

```sql
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_profit_harvest_hours    NUMERIC(5,1) DEFAULT 4.0,
  ADD COLUMN IF NOT EXISTS exit_profit_harvest_size_pct NUMERIC(5,2) DEFAULT 25.0;
```

### 2. Set live bot_config values

```sql
UPDATE bot_config
SET
  exit_profit_harvest_hours    = 4.0,
  exit_profit_harvest_size_pct = 15.0
WHERE id = 'cd8b5fea-4c43-4642-8b63-d1c3a95dc5ab';
```

### 3. Verify

```sql
SELECT
  id,
  exit_profit_harvest_hours,
  exit_profit_harvest_size_pct,
  exit_quick_trim1_gross_pct,
  exit_quick_trim2_gross_pct,
  exit_safety_buffer_pct
FROM bot_config
WHERE id = 'cd8b5fea-4c43-4642-8b63-d1c3a95dc5ab';
```

### 4. Config defaults (no SQL required if defaults are acceptable)

| Field | Default | Tunable |
|-------|---------|---------|
| `exit_profit_harvest_hours` | 4.0 h | Yes — lower to harvest sooner, raise to be more patient |
| `exit_profit_harvest_size_pct` | 15.0 % | Yes — lower for smaller realized gains, raise for bigger exits |

The code uses `cfg.exit_profit_harvest_hours ?? 4` and `cfg.exit_profit_harvest_size_pct ?? 25`, so the columns are optional — hardcoded defaults apply if the columns don't exist yet.

---

## F. Risks / Limitations

| Risk | Detail |
|------|--------|
| **Harvests early runner positions** | A position at 0.70% after 4h gets 25% sold. If price then moves to 2%+, only 75% participates in the full upside. Acceptable trade-off for guaranteed realized gains. |
| **No trim2/runner lock-out** | After harvest fires, trim1 can still fire (at 0.85%), trim2 at 1.25%, runner after that. The full exit ladder is intact — harvest is additive, not replacing. |
| **Uses `heldHours` not `above_edge_duration`** | Harvest fires based on total position age, not time-above-edge. A position opened 4h ago at -0.5% that just turned +0.20% will fire harvest immediately. This is acceptable — the position was below edge recently and a small harvest is still profit. |
| **One-shot only** | After harvest fires once, it will not fire again even if the position is later re-averaged or held longer. The design assumes trim1/trim2/runner handles subsequent exits. |
| **Sell cooldown applies** | If a sell just happened (`sell_cooldown_ms`, default 600s), harvest will be queued but blocked by cooldown. It fires on the next eligible cycle. |
| **`fired_trims` column must exist** | `position.fired_trims` is assumed to be a JSONB array (already exists in schema). The `harvest` string is appended by `executionEngine` after a confirmed fill, same as all other trim names. |
| **No new columns required at runtime** | The two new `bot_config` columns have in-code defaults. The migration is required only to enable SQL-level tuning. |
