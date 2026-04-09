## A. exact files/functions checked

- `lib/cryptoTraderV2.js` — `getV2Config(supabase)` (`bot_config` select); `executeCycleV2()` start (config read); buy loop `buy_checks` / `rsi_threshold` / `effective_bb_threshold` / `effective_ob_imbalance_min`; downtrend reclaim branch (~1155–1196) and new reclaim effective fields on `buy_checks`.
- `lib/signalEngine.js` — `evaluateEntry()` (downtrend pullback uses `effectiveThresholds.effectiveObMin` / `effectiveBbDowntrend` + `entry_rsi_max_downtrend`); `evaluateStarterEntry()` (`starter_ob_imbalance_min`); `evaluateDowntrendReclaimStarter()` (`dt_reclaim_*`, `starter_ob_imbalance_min ?? ob_imbalance_min`).
- `lib/adaptiveThresholds.js` — `computeAdaptiveThresholds()` (adaptive `effectiveBbDowntrend`, `effectiveObMin`; clamps include `adaptive_bb_downtrend_max` default `0.12`).
- `pi-trader/index.js` — `runCycleV2()` → `executeCycleV2()` (no separate config load).
- `api/crypto-trader.js` — `GET` diagnostics handler: maps `context_json.buy_checks` to API rows (including reclaim effective fields after patch).

## B. whether config is live-read or cached

- **Live-read every V2 cycle:** `executeCycleV2()` calls `await getV2Config(supabase)` at the top of each run (`lib/cryptoTraderV2.js` ~418–419). `getV2Config` performs `supabase.from('bot_config').select('*').limit(1).single()` with **no in-process cache** in that module.
- **Restart is not required** for `bot_config` updates to apply to the next cycle; only a process still running **old deployed code** (missing columns or old logic) would ignore new columns.

## C. exact runtime source of each reclaim threshold

| Threshold | Read in code |
|-----------|----------------|
| `starter_ob_imbalance_min` (with fallback) | `lib/signalEngine.js` `evaluateDowntrendReclaimStarter` ~487: `cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45`. Same resolution in reclaim diagnostics in `lib/cryptoTraderV2.js` ~1183. |
| `dt_reclaim_bb_max` | `lib/signalEngine.js` ~491: `cfg.dt_reclaim_bb_max ?? 0.20`. Diagnostics ~1180 in `cryptoTraderV2.js`. |
| `dt_reclaim_rsi_min` / `dt_reclaim_rsi_max` | `lib/signalEngine.js` ~496–497: `cfg.dt_reclaim_rsi_min ?? 30.0`, `cfg.dt_reclaim_rsi_max ?? 48.0`. Diagnostics ~1181–1182 in `cryptoTraderV2.js`. |
| Master switch | `cfg.dt_reclaim_starter_enabled === true` (`signalEngine.js` ~477, `cryptoTraderV2.js` ~1158–1185). |

All values come from the **same** `cfg` object returned by `getV2Config()` for that cycle (PostgREST row → JS object; keys match DB column names).

## D. any stale fallback literals found

- **`-0.6`:** No literal `-0.6` in `lib/` trading code. A displayed **-0.6** in `ob=…<-0.6` style messages is the **resolved** `obMin` at runtime (`starter_ob_imbalance_min ?? ob_imbalance_min ?? -0.45`). If the DB has `starter_ob_imbalance_min = -0.75` but logs still show `-0.6`, the running process may be **old code**, **a different `bot_config` row/host**, or the message was from **before** the DB update.
- **`0.14`:** No `0.14` literal in trading `lib/`. **`effective_bb_threshold` in DECISION_CYCLE** is `cycleAdaptiveThresholds.effectiveBbDowntrend` — adaptive pullback BB cap (base `entry_bb_pct_downtrend` + offsets, clamped by `adaptive_bb_downtrend_max` default **0.12**). That is **not** `dt_reclaim_bb_max`; seeing ~0.12–0.14 is consistent with **pullback/adaptive** logging, not reclaim `%B` max.
- **`<28` / `28`:** Hardcoded only as **defaults** where config is missing: `cfg.entry_rsi_max_downtrend ?? 28` in `lib/signalEngine.js` ~186 and `lib/cryptoTraderV2.js` ~1257 for **`rsi_threshold` display** (pullback downtrend cap). Reclaim RSI band does **not** drive that string.

## E. whether diagnostics are misleading

- **Yes, unless interpreted carefully:** `rsi_threshold` for DOWNTREND is always built from **`entry_rsi_max_downtrend`** (~1255–1257 `cryptoTraderV2.js`), so it stays **“&lt;28”**-style labeling for the **extreme pullback** rule, not **`dt_reclaim_rsi_min`–`dt_reclaim_rsi_max`**.
- **`effective_bb_threshold` / `bb_ok`** reflect **adaptive pullback** BB for the regime (`effectiveBbDowntrend`), not **`dt_reclaim_bb_max`**.
- **`effective_ob_imbalance_min`** in `buy_checks` is the **adaptive** pullback OB floor (`computeAdaptiveThresholds` from **`ob_imbalance_min`**, not `starter_ob_imbalance_min`), so it can look like **-0.6** while reclaim uses **`starter_ob_imbalance_min ?? ob_imbalance_min`** without the adaptive layer.

## F. exact patch diff if diagnostics need to be fixed

Applied: add resolved reclaim thresholds to each DECISION_CYCLE `buy_checks` (and API diagnostics passthrough) so exports show what reclaim logic actually used:

```diff
--- a/lib/cryptoTraderV2.js
+++ b/lib/cryptoTraderV2.js
@@ - ... buy_checks object ...
+          effective_starter_ob_min:      +(cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45),
+          effective_dt_reclaim_bb_max:   +(cfg.dt_reclaim_bb_max ?? 0.20),
+          effective_dt_reclaim_rsi_min:  +(cfg.dt_reclaim_rsi_min ?? 30.0),
+          effective_dt_reclaim_rsi_max:  +(cfg.dt_reclaim_rsi_max ?? 48.0),
```

```diff
--- a/api/crypto-trader.js
+++ b/api/crypto-trader.js
@@ - ... diagnostics map ...
+          effective_starter_ob_min:           bc.effective_starter_ob_min           ?? null,
+          effective_dt_reclaim_bb_max:       bc.effective_dt_reclaim_bb_max           ?? null,
+          effective_dt_reclaim_rsi_min:      bc.effective_dt_reclaim_rsi_min       ?? null,
+          effective_dt_reclaim_rsi_max:      bc.effective_dt_reclaim_rsi_max       ?? null,
```

Optional follow-up (not required for runtime correctness): change `rsi_threshold` when `r === 'DOWNTREND'` to include reclaim band text so the UI stops implying only RSI &lt; 28.
