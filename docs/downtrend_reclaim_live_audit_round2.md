## A. exact files/functions checked

- `lib/cryptoTraderV2.js` — `getV2Config()` (loads `bot_config`); `executeCycleV2()` buy loop: `!intent && gatingPos` (starter-into-existing); `!intent && !gatingPos` → `evaluateStarterEntry()` then `r === 'DOWNTREND'` → `signalEngine.evaluateDowntrendReclaimStarter()`; reclaim rejection diagnostics (~lines 1155–1196); `buy_checks` / `rsi_threshold` / `effective_bb_threshold` (~lines 1250–1308).
- `lib/signalEngine.js` — `evaluateEntry()` DOWNTREND branch (pullback: `entry_rsi_max_downtrend`, `entry_bb_pct_downtrend`, `relVol`); `evaluateStarterEntry()` (returns `null` for `DOWNTREND`); `evaluateDowntrendReclaimStarter()` (OB via `starter_ob_imbalance_min ?? ob_imbalance_min`, `%B` via `dt_reclaim_bb_max`, RSI via `dt_reclaim_rsi_min` / `dt_reclaim_rsi_max`, gate `dt_reclaim_starter_enabled === true`).
- `lib/adaptiveThresholds.js` — `computeAdaptiveThresholds()` — `effectiveBbDowntrend` clamped with `adaptive_bb_downtrend_max` default `0.12`.
- `pi-trader/index.js` — `runCycleV2()` → `traderV2.executeCycleV2(supabase, opts)` (live V2 scheduler entry).
- `api/crypto-trader.js` — DECISION_CYCLE shaping for dashboard (`effective_bb_threshold`, `final_reason` / `buy_blocker`).
- `supabase/init_schema.sql` / `supabase/migrations/038_downtrend_reclaim_starter.sql` — `dt_reclaim_*` columns, defaults (`dt_reclaim_starter_enabled` default `false`).

## B. exact live branch currently running

- **V2 runtime path (this repo):** `pi-trader/index.js` → `runCycleV2()` → `lib/cryptoTraderV2.js` `executeCycleV2()`. No separate “reclaim-only” branch: reclaim is the `DOWNTREND` arm inside `else if (!intent && !gatingPos)` after `evaluateStarterEntry` returns `null`.
- **Git branch name** is not encoded in the runtime; workspace snapshot was `main` tracking `origin/main`. **Which git branch the live host runs** must be read on that host (`git rev-parse --abbrev-ref HEAD` / deploy manifest).

## C. exact reason reclaim is not live

- **Config gate:** `evaluateDowntrendReclaimStarter()` and the diagnostic block both require `cfg.dt_reclaim_starter_enabled === true` (`lib/signalEngine.js` ~477, `lib/cryptoTraderV2.js` ~1158–1185). Schema default is `false` (`init_schema.sql` / migration `038`). If live `bot_config` never sets it to `true`, reclaim never returns an intent and `starter_met` stays `false`.
- **If live rows include `signal_not_met:downtrend_starter_blocked:dt_reclaim_disabled`:** reclaim code is deployed but the **master switch is off** in DB.
- **If live rows include `signal_not_met:downtrend_starter_blocked:ob=...<...` (e.g. `ob=-0.82<-0.6`):** that string is only emitted **after** the `dt_reclaim_starter_enabled !== true` check fails (i.e. flag is **true** on that cycle). Then `evaluateDowntrendReclaimStarter` returned `null` because **OB &lt; `starter_ob_imbalance_min ?? ob_imbalance_min`** (~487–488 `signalEngine.js`). Reclaim **is** on the decision path but **never clears** to a buy.
- **Not “unwired”:** the final buy path already sets `starterIntent = dtReclaim` and `isStarter = true` when reclaim returns non-null and risk passes (`lib/cryptoTraderV2.js` ~1159–1173). No additional wiring step is missing in code.
- **Display vs strategy:** `rsi_threshold` and `effective_bb_threshold` in `buy_checks` still describe the **pullback/adaptive** story for DOWNTREND (`entry_rsi_max_downtrend` → `"<28"` and adaptive downtrend BB cap ~`0.12`), not the reclaim-only thresholds (`dt_reclaim_*`). That makes dashboards look “stuck on &lt;28” even when reclaim logic is what failed.

## D. exact reason ob=-0.6 appears while rsi remains &lt;28

- **`ob=-0.82<-0.6` source:** `lib/cryptoTraderV2.js` ~1183–1189:  
  `buyBlocker = \`signal_not_met:downtrend_starter_blocked:ob=${imbal?.toFixed(2)}<${obMin}\``  
  with `obMin = cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45`. The printed **-0.6** means live config resolves `obMin` to **-0.6** (typically `starter_ob_imbalance_min` or `ob_imbalance_min` in `bot_config`).
- **`rsi_threshold: "<28"` source:** `lib/cryptoTraderV2.js` ~1255–1257: for non-UPTREND, non-RANGE (i.e. **DOWNTREND**), `rsi_threshold` is always `` `<${cfg.entry_rsi_max_downtrend ?? 28}` `` — the **pullback** downtrend RSI cap from `evaluateEntry`, **not** `dt_reclaim_rsi_min`–`dt_reclaim_rsi_max` (30–48 defaults). So RSI can be in the reclaim band in the market while the row still shows **&lt;28** as the labeled “threshold.”
- **No contradiction in code:** one field is a **fixed UI label** for the extreme pullback rule; the other is a **reclaim failure reason** from a different gate.

## E. exact patch diff needed

**Minimal behavior (turn reclaim on in live DB):**

```sql
UPDATE bot_config
SET dt_reclaim_starter_enabled = true
WHERE true;  -- adjust if non-singleton
```

**If migration 038 was never applied on live**, run `supabase/migrations/038_downtrend_reclaim_starter.sql` (or equivalent) first so the column exists.

**Optional minimal clarity patch (dashboard only — does not change entries):** in `lib/cryptoTraderV2.js`, replace the single-line `rsiThreshold` for DOWNTREND so it does not imply only the &lt;28 pullback when reclaim is enabled, e.g. build `rsi_threshold` from `dt_reclaim_rsi_min` / `dt_reclaim_rsi_max` when `cfg.dt_reclaim_starter_enabled === true`, else keep `` `<${cfg.entry_rsi_max_downtrend ?? 28}` ``.

**If reclaim is enabled but OB blocks (e.g. `-0.82 < -0.6`):** entry logic is already reclaim; “fix” is not more wiring but **either** looser OB for starters (`starter_ob_imbalance_min` / `ob_imbalance_min`) **or** accepting no buy until the book improves — that is strategy tuning, not wiring.

## F. exact SQL/config needed if any

- **Required for reclaim to ever fire:** `dt_reclaim_starter_enabled = true` in `bot_config` (see **E**).
- **Schema:** columns from migration `038` / `init_schema.sql`: `dt_reclaim_starter_enabled`, `dt_reclaim_bb_max`, `dt_reclaim_rsi_min`, `dt_reclaim_rsi_max`, `dt_reclaim_size_mult`.
- **Explains `ob` vs -0.45 default:** live `starter_ob_imbalance_min` or `ob_imbalance_min` set to **-0.6** (so the diagnostic prints `...<-0.6`).
- **`effective_bb_threshold` ~0.12 on rows:** `adaptive_bb_downtrend_max` default and `computeAdaptiveThresholds()` — used for **logged** pullback/adaptive BB; reclaim uses **`dt_reclaim_bb_max`** inside `evaluateDowntrendReclaimStarter` only (`lib/signalEngine.js` ~491–492).
