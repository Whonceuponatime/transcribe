# Starter Re-entry Diagnostics — Patch Notes

## A. Exact Files and Functions Changed

| File | Location |
|---|---|
| `lib/cryptoTraderV2.js` | `executeCycleV2()` — 5 tracking variables added after `let starterIntent = null` |
| `lib/cryptoTraderV2.js` | `executeCycleV2()` — `!intent && gatingPos` branch: variables wired at each decision point |
| `lib/cryptoTraderV2.js` | `executeCycleV2()` — `buy_checks` object: 7 new fields appended |

No schema changes. No trading logic changes. No new config columns.

---

## B. Exact Patch Diff

### Tracking variables (added after `let starterIntent = null`)

```diff
+      // Starter-into-existing diagnostics (new !intent && gatingPos path).
+      let starterIntoExistingAttempted  = false;
+      let starterIntoExistingPassed     = false;
+      let starterIntoExistingBlocker    = null;
+      let starterAddonSizeMultEffective = null;
+      let starterCooldownMsEffective    = null;
```

### Wiring in `!intent && gatingPos` branch

```diff
+        starterIntoExistingAttempted = canStarterAddon;
         ...
+          starterAddonSizeMultEffective = +starterAddonMult.toFixed(3);
+          starterCooldownMsEffective    = starterCooldownMs;
           if (scaledKrw < 5000) {
             buyBlocker = 'starter_addon_below_minimum';
+            starterIntoExistingBlocker = buyBlocker;
           } else if (...cooldown...) {
             buyBlocker = `starter_addon_cooldown_${waitMin}min_remaining`;
+            starterIntoExistingBlocker = buyBlocker;
           } else {
             riskResult = riskEngine.allows(starterIntent, portfolio, cfg);
             if (!riskResult.ok) {
               buyBlocker = riskResult.reason;
+              starterIntoExistingBlocker = buyBlocker;
             } else {
               isStarter = true;
+              starterIntoExistingPassed = true;
             }
           }
         } else {
+          starterIntoExistingBlocker = canStarterAddon
+            ? 'starter_eval_returned_null'
+            : 'position_not_tactical';
           // ... original buyBlocker diagnostic (unchanged)
```

### New fields in `buy_checks`

```diff
+          starter_into_existing_attempted:   starterIntoExistingAttempted,
+          starter_into_existing_passed:      starterIntoExistingPassed,
+          starter_into_existing_blocker:     starterIntoExistingBlocker,
+          starter_addon_size_mult_effective: starterAddonSizeMultEffective,
+          starter_cooldown_ms_effective:     starterCooldownMsEffective,
+          existing_position_strategy_tag:    existingPos?.strategy_tag ?? null,
+          route_to_existing_position:        !!(isAddon || (isStarter && existingPos?.strategy_tag === 'tactical')) && !!existingPos,
```

---

## C. Plain-English Meaning of Each Field

### `starter_into_existing_attempted` — boolean

`true` when the bot was in the `!intent && gatingPos` branch (normal pullback signal not met, position exists) AND the position's `strategy_tag` was `tactical`. Means `evaluateStarterEntry()` was actually called for this coin this cycle.

`false` in all other branches (fresh entry, flat portfolio, normal add-on, buys disabled). Also `false` when the position is `unassigned` or `core` — those are excluded from the new path.

---

### `starter_into_existing_passed` — boolean

`true` only when the starter-into-existing path cleared ALL gates: `evaluateStarterEntry()` returned a candidate, `scaledKrw >= ₩5,000`, cooldown elapsed, and `riskEngine.allows()` returned ok. Means an order was (or will be) submitted via this path.

`false` on every other outcome, including all non-`!intent && gatingPos` branches.

---

### `starter_into_existing_blocker` — string | null

The exact string reason the path was blocked, or `null` when the path passed or was not entered.

Possible values:
| Value | Meaning |
|---|---|
| `null` | Not in this branch, or path passed (`starter_into_existing_passed = true`) |
| `'position_not_tactical'` | Position exists but is `unassigned` or `core` — starter add-on not attempted |
| `'starter_eval_returned_null'` | `evaluateStarterEntry()` returned null (OB gate, RSI overbought, DOWNTREND, or `starter_entry_enabled=false`) |
| `'starter_addon_below_minimum'` | Scaled budget < ₩5,000 — below Upbit minimum |
| `'starter_addon_cooldown_Xmin_remaining'` | Cooldown hasn't elapsed yet; X = minutes remaining |
| `'<riskEngine reason>'` | riskEngine.allows() blocked it (exposure cap, loss streak, entries/24h, etc.) |

---

### `starter_addon_size_mult_effective` — number | null

The actual multiplier applied to the starter budget for this re-entry path. Populated only when `evaluateStarterEntry()` returned a candidate (i.e., after `canStarterAddon = true` and the OB/RSI/regime checks passed). `null` on all other branches.

Value = `cfg.starter_addon_size_mult ?? 1.0`. At default 1.0 the size equals a flat-portfolio starter; at 0.5 it is half that.

---

### `starter_cooldown_ms_effective` — number | null

The actual cooldown value used for the starter-into-existing path. Populated alongside `starter_addon_size_mult_effective`.

Value = `cfg.starter_cooldown_ms ?? cfg.buy_cooldown_ms ?? 1800000`. This is the first cycle where `starter_cooldown_ms` is wired; previously it was schema-only.

---

### `existing_position_strategy_tag` — string | null

The `strategy_tag` of the existing position for this coin (`'tactical'`, `'unassigned'`, `'core'`), or `null` when no position exists. Populated on every cycle regardless of branch. Lets you verify at a glance why `starter_into_existing_attempted` is false when you expect it to be true.

---

### `route_to_existing_position` — boolean

`true` when the buy (if it proceeds) will add a fill to the EXISTING position rather than creating a new one. Specifically: `true` for normal add-ons (`isAddon`) AND for the new starter-into-existing path (`isStarter && existingPos.strategy_tag === 'tactical'`). `false` for fresh pullback entries and flat-portfolio starters (those go through `getOrCreatePosition`).

This is the single field that confirms the fill will land on the existing position_id without opening a second position for the same coin.

---

## D. Edge Cases

**1. Fields are always present in `buy_checks`, never missing.**
All 7 variables are initialised to `false` / `null` before the branch logic runs. Coins that never enter the `!intent && gatingPos` branch will show `starter_into_existing_attempted: false` and nulls for the rest — never undefined.

**2. `starter_into_existing_blocker` can be set even when `starter_into_existing_attempted = false`.**
When `canStarterAddon = false` (position is not tactical), `starterIntoExistingAttempted` is `false` but `starterIntoExistingBlocker` is set to `'position_not_tactical'`. This is intentional — it tells you the path was considered but skipped at the eligibility check, not that the path was invisible.

**3. `route_to_existing_position` is computed pre-execution.**
It is an expression that mirrors what the execution layer will do, computed at the same point the `buy_checks` object is built (before `executeBuy` is called). If a subsequent error prevents the buy, the field still shows `true` because it reflects intent, not confirmed outcome. Check `final_action = 'STARTER_SUBMITTED'` + `result.ok` for confirmed execution.

**4. No new bot_events rows.**
All 7 fields live inside the existing `DECISION_CYCLE` event's `context_json.buy_checks`. No new event type is introduced. The diagnostic export query used in previous audits already captures the full `buy_checks` blob.

**5. No SQL migration needed.**
These fields are written into `context_json` (JSONB) on the existing `bot_events` table. No schema change required.
