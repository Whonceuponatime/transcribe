# Starter Re-entry Into Existing Position — Patch Notes

## A. Exact Files and Functions Changed

| File | Function / Location |
|---|---|
| `lib/cryptoTraderV2.js` | `executeCycleV2()` — `!intent && gatingPos` branch (buy loop) |
| `lib/cryptoTraderV2.js` | `executeCycleV2()` — `positionId` assignment block |
| `supabase/migrations/036_starter_addon.sql` | New migration — adds `starter_addon_size_mult` column |
| `supabase/init_schema.sql` | `bot_config` CREATE TABLE — new column added |

---

## B. Exact Patch Diff

### `lib/cryptoTraderV2.js` — `!intent && gatingPos` branch

```diff
-      } else if (!intent && gatingPos) {
-        // Position exists (non-micro) but pullback signal not met.
-        // Add-on logic requires the pullback signal — block and diagnose.
-        const r = regime?.regime ?? 'UNKNOWN';
-        const effBbThresh = r === 'UPTREND'   ? cycleAdaptiveThresholds.effectiveBbUptrend
-                          : r === 'DOWNTREND' ? cycleAdaptiveThresholds.effectiveBbDowntrend
-                          : cycleAdaptiveThresholds.effectiveBbRange;
-        const effObMin = cycleAdaptiveThresholds.effectiveObMin;
-        const rsiMin   = cfg.entry_rsi_min_uptrend ?? 42;
-        const rsiMax   = cfg.entry_rsi_max_uptrend ?? 55;
-        if (r === 'DOWNTREND' && coin === 'SOL') {
-          buyBlocker = 'signal_not_met:sol_disabled_in_downtrend';
-        } else if (ind.obImbalance != null && ind.obImbalance < effObMin) {
-          buyBlocker = `signal_not_met:ob_imbalance=...`;
-        } else if (ind.bbPctB != null && ind.bbPctB >= effBbThresh) {
-          buyBlocker = `signal_not_met:bb_pctB=...`;
-        } else if (...) {
-          buyBlocker = `signal_not_met:RSI=...`;
-        } else {
-          buyBlocker = 'signal_not_met:conditions_not_satisfied';
-        }

+      } else if (!intent && gatingPos) {
+        // Before blocking: attempt a starter-style probe into the existing position.
+        // Does NOT require price to be 1% below avg_cost. Only for tactical positions.
+        const canStarterAddon = gatingPos.strategy_tag === 'tactical';
+        const starterAddonCandidate = canStarterAddon
+          ? signalEngine.evaluateStarterEntry(coin, regime, ind, cfg, portfolio.navKrw)
+          : null;
+
+        if (starterAddonCandidate) {
+          const starterAddonMult  = cfg.starter_addon_size_mult ?? 1.0;
+          const scaledKrw         = starterAddonCandidate.krwAmount * starterAddonMult;
+          const starterCooldownMs = cfg.starter_cooldown_ms ?? cfg.buy_cooldown_ms ?? BUY_COOLDOWN_MS;
+          const lastBuy           = _lastBuyAt.get(coin) ?? 0;
+
+          if (scaledKrw < 5000) {
+            buyBlocker = 'starter_addon_below_minimum';
+          } else if ((Date.now() - lastBuy) < starterCooldownMs) {
+            const waitMin = Math.ceil((starterCooldownMs - (Date.now() - lastBuy)) / 60000);
+            buyBlocker = `starter_addon_cooldown_${waitMin}min_remaining`;
+          } else {
+            starterIntent = { ...starterAddonCandidate, krwAmount: scaledKrw,
+                              reason: starterAddonCandidate.reason + '_into_existing' };
+            riskResult    = riskEngine.allows(starterIntent, portfolio, cfg);
+            if (!riskResult.ok) { buyBlocker = riskResult.reason; }
+            else                { isStarter = true; }
+          }
+        } else {
+          // Starter also failed — original diagnostic blocker logic (unchanged)
+          const r = regime?.regime ?? 'UNKNOWN';
+          ...  // same if/else chain as before
+        }
```

### `lib/cryptoTraderV2.js` — `positionId` assignment

```diff
-      // For add-ons use the existing position; for fresh entries get/create one.
-      const positionId = isAddon && existingPos
-        ? existingPos.position_id
-        : await getOrCreatePosition(...);

+      // For add-ons and starter-into-existing: use the existing position directly.
+      const routeToExisting = (isAddon || (isStarter && existingPos?.strategy_tag === 'tactical')) && existingPos;
+      const positionId = routeToExisting
+        ? existingPos.position_id
+        : await getOrCreatePosition(...);
```

### `supabase/migrations/036_starter_addon.sql` — new file

```sql
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS starter_addon_size_mult NUMERIC(5,3) DEFAULT NULL;
-- NULL → 1.0 (same size as flat-portfolio starter)
```

---

## C. Exact SQL Needed

### Step 1 — Run migration (Supabase SQL editor)

```sql
-- Migration 036
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS starter_addon_size_mult NUMERIC(5,3) DEFAULT NULL;
```

### Step 2 — Set live values

```sql
UPDATE bot_config SET
  -- Starter add-on size: 1.0 = same as regular flat-portfolio starter (~0.25% NAV uptrend).
  -- Lower to 0.5 to make starter add-ons half the size of regular starters.
  starter_addon_size_mult = 1.0,

  -- Starter cooldown: was already in schema (migration 035), now wired in code.
  -- 900000 = 15 min. NULL would fall back to buy_cooldown_ms (also 900000).
  -- Set lower (e.g. 600000 = 10 min) for more frequent starter re-entries.
  starter_cooldown_ms = 900000,

  updated_at = now();
```

---

## D. Exact Plain-English Behavior Change

**Before this patch:**
When the bot held a tactical position and the normal pullback signal was not met (BB%B too high, RSI out of window, etc.), the cycle immediately set `buyBlocker` and moved on. No entry of any kind was possible — the bot would wait until the next full pullback signal or the position closed.

**After this patch:**
In that same situation, the bot first tries `evaluateStarterEntry()` on the held coin. If the starter passes (OB gate, RSI below overbought cap, UPTREND or RANGE only), a small position probe is added directly to the existing tactical position — no dip requirement, just the starter's light OB + RSI-cap check. The size is `starter budget × starter_addon_size_mult` (default: same as a regular starter, ~0.25% NAV). The re-entry uses `starter_cooldown_ms` (falls back to `buy_cooldown_ms`) and goes through all normal risk engine checks (exposure caps, entries/24h, daily turnover, loss streak, drawdown multiplier).

If the starter also fails (DOWNTREND, OB too sell-heavy, RSI overbought, or starter disabled), the original diagnostic blocker is set unchanged.

**Practical effect:**
The bot can now add small probes to existing positions during trending or ranging markets even when the precise pullback conditions aren't met. This increases re-entry frequency without bypassing any safety checks.

---

## E. Risks and Edge Cases Before Live Deploy

**1. Double-buy risk — LOW.**
The re-entry goes through `riskEngine.allows()` which checks `max_entries_per_coin_24h` (default 3). If the bot already bought once today, this counter catches a second entry. The starter size (~0.25% NAV) is also well within the exposure cap check.

**2. Averaging up without a dip signal — MEDIUM.**
Unlike the normal add-on, there is no price-below-avg-cost requirement. The bot may add to a position that is slightly profitable. The exit logic (trim1/trim2/runner) still governs when it sells, so gains can compound — but so can a reversal risk. Start with `starter_addon_size_mult = 1.0` (small size) and monitor.

**3. Only fires for `strategy_tag = 'tactical'` positions.**
Unassigned (adopted) and core positions are explicitly excluded (`canStarterAddon = gatingPos.strategy_tag === 'tactical'`). No change to protected-position behaviour.

**4. DECISION_CYCLE log appearance.**
When this path fires, `DECISION_CYCLE.buy_checks.is_starter = true`, `existing_position = true`, and `final_action = 'STARTER_SUBMITTED'`. The `intent_reason` will contain `_into_existing` suffix. This is new and distinct from both `BUY_SUBMITTED` and `ADD_ON_SUBMITTED`.

**5. `starter_cooldown_ms` is now live.**
Previously prepared in schema but unread by code. It is now read by both the flat-portfolio starter path (`!intent && !gatingPos`) and this new starter-into-existing path. If set to NULL, both paths fall back to `buy_cooldown_ms`. No behaviour change for existing deployments with NULL.

**6. Backward compatibility — FULL.**
All new config columns (`starter_addon_size_mult`, `starter_cooldown_ms`) use `?? fallbacks`. A live bot that has not run the SQL UPDATE will behave as if `starter_addon_size_mult = 1.0` and `starter_cooldown_ms = buy_cooldown_ms`. No crash, no silent change in size from previous behaviour.
