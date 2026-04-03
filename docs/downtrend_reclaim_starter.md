# Downtrend Reclaim Starter Patch

## A. Files / Functions Changed

| File | Location | Change |
|------|----------|--------|
| `lib/signalEngine.js` | After `evaluateStarterEntry` (~line 460) | Add new `evaluateDowntrendReclaimStarter` function |
| `lib/signalEngine.js` | `module.exports` | Export `evaluateDowntrendReclaimStarter` |
| `lib/cryptoTraderV2.js` | `!intent && !gatingPos` branch — `r === 'DOWNTREND'` block (~line 1155) | Replace flat `downtrend_starter_blocked` with reclaim-starter attempt + granular blocker diagnostics |
| `supabase/migrations/038_downtrend_reclaim_starter.sql` | New file | Add 5 columns to `bot_config` |
| `supabase/init_schema.sql` | `bot_config` table (~line 769) | Add same 5 columns after `starter_addon_size_mult` |

---

## B. Patch Diff

```diff
--- a/lib/signalEngine.js
+++ b/lib/signalEngine.js

@@ before module.exports @@
+function evaluateDowntrendReclaimStarter(asset, regime, ind, cfg, navKrw) {
+  if (asset === 'SOL') return null;
+  if (cfg.dt_reclaim_starter_enabled !== true) return null;
+
+  const { regime: r } = regime;
+  if (r !== 'DOWNTREND') return null;
+
+  const bbPct = ind.bbPctB;
+  const rsi14 = ind.rsi14;
+  const imbal = ind.obImbalance;
+
+  const obMin = cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45;
+  if (imbal != null && imbal < obMin) return null;
+
+  const bbMax = cfg.dt_reclaim_bb_max ?? 0.20;
+  if (bbPct == null || bbPct >= bbMax) return null;
+
+  const rsiMin = cfg.dt_reclaim_rsi_min ?? 30.0;
+  const rsiMax = cfg.dt_reclaim_rsi_max ?? 48.0;
+  if (rsi14 == null || rsi14 < rsiMin || rsi14 > rsiMax) return null;
+
+  const maxRiskPct = cfg.max_risk_per_signal_pct ?? 2;
+  const sizeMult   = cfg.dt_reclaim_size_mult ?? 0.15;
+  const budgetKrw  = Math.max(0, navKrw * (maxRiskPct / 100) * 0.30 * sizeMult);
+  if (budgetKrw < 5000) return null;
+
+  return {
+    asset,
+    side:         'buy',
+    krwAmount:    budgetKrw,
+    reason:       `dt_reclaim_starter (RSI=${rsi14?.toFixed(1)} %B=${bbPct?.toFixed(3)} OB=${imbal?.toFixed(3)})`,
+    strategy_tag: 'tactical',
+    sizePct:      +(30 * sizeMult).toFixed(1),
+    isStarter:    true,
+    indicators:   { rsi14: rsi14?.toFixed(1), bbPctB: bbPct?.toFixed(3), obImbalance: imbal?.toFixed(3), regime: r },
+  };
+}

 module.exports = {
   computeIndicators,
   evaluateEntry,
   evaluateStarterEntry,
+  evaluateDowntrendReclaimStarter,
   evaluateExit,
   isFullyProtected,
   requiredEdge,
 };
```

```diff
--- a/lib/cryptoTraderV2.js
+++ b/lib/cryptoTraderV2.js

@@ !intent && !gatingPos branch — else (no starterIntent) @@
         } else {
           const r        = regime?.regime ?? 'UNKNOWN';
           const effObMin = cycleAdaptiveThresholds.effectiveObMin;
           if (r === 'DOWNTREND') {
-            buyBlocker = 'signal_not_met:downtrend_starter_blocked';
+            const dtReclaim = signalEngine.evaluateDowntrendReclaimStarter(coin, regime, ind, cfg, portfolio.navKrw);
+            if (dtReclaim) {
+              const lastBuy    = _lastBuyAt.get(coin) ?? 0;
+              const cooldownMs = cfg.starter_cooldown_ms ?? cfg.buy_cooldown_ms ?? BUY_COOLDOWN_MS;
+              if ((Date.now() - lastBuy) < cooldownMs) {
+                const waitMin = Math.ceil((cooldownMs - (Date.now() - lastBuy)) / 60000);
+                buyBlocker = `dt_reclaim_cooldown_${waitMin}min_remaining`;
+              } else {
+                riskResult = riskEngine.allows(dtReclaim, portfolio, cfg);
+                if (!riskResult.ok) {
+                  buyBlocker = riskResult.reason;
+                } else {
+                  starterIntent = dtReclaim;
+                  isStarter     = true;
+                }
+              }
+            } else {
+              // Granular blocker diagnostics
+              const bbPct  = ind.bbPctB;  const rsi14 = ind.rsi14;  const imbal = ind.obImbalance;
+              const bbMax  = cfg.dt_reclaim_bb_max  ?? 0.20;
+              const rsiMin = cfg.dt_reclaim_rsi_min ?? 30.0;
+              const rsiMax = cfg.dt_reclaim_rsi_max ?? 48.0;
+              const obMin  = cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45;
+              if (cfg.dt_reclaim_starter_enabled !== true) {
+                buyBlocker = 'signal_not_met:downtrend_starter_blocked:dt_reclaim_disabled';
+              } else if (coin === 'SOL') {
+                buyBlocker = 'signal_not_met:downtrend_starter_blocked:sol_blocked';
+              } else if (imbal != null && imbal < obMin) {
+                buyBlocker = `signal_not_met:downtrend_starter_blocked:ob=${imbal?.toFixed(2)}<${obMin}`;
+              } else if (bbPct == null || bbPct >= bbMax) {
+                buyBlocker = `signal_not_met:downtrend_starter_blocked:bb_pctB=${bbPct?.toFixed(3)}>=${bbMax}`;
+              } else if (rsi14 == null || rsi14 < rsiMin || rsi14 > rsiMax) {
+                buyBlocker = `signal_not_met:downtrend_starter_blocked:rsi=${rsi14?.toFixed(1)}_band=${rsiMin}-${rsiMax}`;
+              } else {
+                buyBlocker = 'signal_not_met:downtrend_starter_blocked';
+              }
+            }
           } else if (ind.obImbalance != null && ind.obImbalance < effObMin) {
```

```diff
--- a/supabase/migrations/038_downtrend_reclaim_starter.sql (new file)
+++ b/supabase/migrations/038_downtrend_reclaim_starter.sql

+ALTER TABLE bot_config
+  ADD COLUMN IF NOT EXISTS dt_reclaim_starter_enabled BOOLEAN      NOT NULL DEFAULT false,
+  ADD COLUMN IF NOT EXISTS dt_reclaim_bb_max          NUMERIC(5,3) NOT NULL DEFAULT 0.20,
+  ADD COLUMN IF NOT EXISTS dt_reclaim_rsi_min         NUMERIC(5,2) NOT NULL DEFAULT 30.0,
+  ADD COLUMN IF NOT EXISTS dt_reclaim_rsi_max         NUMERIC(5,2) NOT NULL DEFAULT 48.0,
+  ADD COLUMN IF NOT EXISTS dt_reclaim_size_mult       NUMERIC(5,3) NOT NULL DEFAULT 0.15;
```

---

## C. Old Downtrend Behavior

**`evaluateStarterEntry`:** returns `null` immediately when `regime === 'DOWNTREND'` (line 419). No path exists to generate a starter intent in downtrend.

**`evaluateEntry` downtrend path:** requires ALL of:
- %B < `entry_bb_pct_downtrend` (default 0.05 — extreme lower band)
- RSI < `entry_rsi_max_downtrend` (default 28 — very oversold)
- `relVol > 2.0` — volume spike required

In practice, %B ≈ 0.10–0.20 and RSI ≈ 40–45 (the near-miss values observed) pass none of these gates.

**`cryptoTraderV2.js` diagnostic branch:** when `r === 'DOWNTREND'` and both `intent` and `starterIntent` are null, the blocker is always the opaque string `signal_not_met:downtrend_starter_blocked` — no sub-reason explaining which specific condition failed.

**Result:** 0 buys across 1000 cycles despite free KRW available and BTC indicators near-miss.

---

## D. New Downtrend Behavior

### Signal path added: `evaluateDowntrendReclaimStarter`

Fires when **all** of the following hold:

| Condition | Default | Config column |
|-----------|---------|---------------|
| Asset is BTC or ETH (not SOL) | hardcoded | — |
| `dt_reclaim_starter_enabled = true` | `false` | `dt_reclaim_starter_enabled` |
| OB imbalance ≥ floor | `starter_ob_imbalance_min` or `ob_imbalance_min` (-0.45) | `starter_ob_imbalance_min` |
| %B < threshold | 0.20 | `dt_reclaim_bb_max` |
| RSI within reclaim band | 30–48 | `dt_reclaim_rsi_min` / `dt_reclaim_rsi_max` |
| Budget ≥ 5,000 KRW | hardcoded (Upbit min) | — |

**Sizing:** `navKrw × (max_risk_per_signal_pct/100) × 0.30 × dt_reclaim_size_mult`
- Defaults: `NAV × 2% × 30% × 0.15 = 0.09% NAV` (e.g., ≈9,000 KRW on 10M NAV)
- Compare: normal range starter = `NAV × 2% × 40% × 0.25 = 0.20% NAV` — 2× larger
- Compare: downtrend pullback entry = `NAV × 2% × 30% = 0.60% NAV` — 7× larger

### Execution path in `cryptoTraderV2.js`

When `r === 'DOWNTREND'` and no pullback or normal starter intent was produced:
1. Call `evaluateDowntrendReclaimStarter(coin, …)` → `dtReclaim`
2. If `dtReclaim` returned a signal: check cooldown → check risk engine → set `starterIntent = dtReclaim`, `isStarter = true` (proceeds to submission exactly like a normal starter)
3. If `dtReclaim` returned `null`: emit a **granular blocker string** identifying the exact failed condition

### Add-on prevention

This path is inside the `!intent && !gatingPos` branch — it only fires when the portfolio is flat for that coin. The `!intent && gatingPos` branch (existing position) still calls `evaluateStarterEntry` which returns null in DOWNTREND; the downtrend reclaim function is NOT called there, so no add-ons happen in downtrend.

### New `buy_checked`/`final_reason` diagnostic values

| Value | Meaning |
|-------|---------|
| `dt_reclaim_starter (RSI=X %B=Y OB=Z)` | Reclaim starter passed all checks, order submitted |
| `dt_reclaim_cooldown_Nmin_remaining` | Reclaim signal met but buy cooldown not yet elapsed |
| `signal_not_met:downtrend_starter_blocked:dt_reclaim_disabled` | Config gate: `dt_reclaim_starter_enabled` is false |
| `signal_not_met:downtrend_starter_blocked:sol_blocked` | SOL — never allowed |
| `signal_not_met:downtrend_starter_blocked:ob=X<Y` | OB imbalance too sell-heavy |
| `signal_not_met:downtrend_starter_blocked:bb_pctB=X>=Y` | %B above reclaim threshold (price not low enough in band) |
| `signal_not_met:downtrend_starter_blocked:rsi=X_band=A-B` | RSI outside reclaim window |
| `signal_not_met:downtrend_starter_blocked` | No specific sub-condition identified (fallback) |

---

## E. SQL / Config Needed

### 1. Run migration (once, in Supabase SQL editor)

```sql
-- supabase/migrations/038_downtrend_reclaim_starter.sql
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS dt_reclaim_starter_enabled BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dt_reclaim_bb_max          NUMERIC(5,3) NOT NULL DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS dt_reclaim_rsi_min         NUMERIC(5,2) NOT NULL DEFAULT 30.0,
  ADD COLUMN IF NOT EXISTS dt_reclaim_rsi_max         NUMERIC(5,2) NOT NULL DEFAULT 48.0,
  ADD COLUMN IF NOT EXISTS dt_reclaim_size_mult       NUMERIC(5,3) NOT NULL DEFAULT 0.15;
```

### 2. Enable and tune (after observing diagnostics)

```sql
-- Enable with defaults (conservative: %B < 0.20, RSI 30–48, 0.09% NAV per entry)
UPDATE bot_config
SET dt_reclaim_starter_enabled = true
WHERE true;

-- Optional tuning examples:
-- Widen RSI band slightly (RSI 28–50):
UPDATE bot_config SET dt_reclaim_rsi_min = 28, dt_reclaim_rsi_max = 50 WHERE true;

-- Tighten %B gate (require deeper in lower band):
UPDATE bot_config SET dt_reclaim_bb_max = 0.15 WHERE true;

-- Make entries even smaller (0.10% NAV):
UPDATE bot_config SET dt_reclaim_size_mult = 0.10 WHERE true;
```

### 3. Verify diagnostics after enabling

```sql
-- Check first N reclaim decisions
SELECT
  created_at,
  message,
  context_json->'final_reason'   AS final_reason,
  context_json->'buy_checks'     AS buy_checks,
  context_json->'regime'         AS regime
FROM bot_events
WHERE event_type = 'DECISION_CYCLE'
  AND message LIKE '%BTC%'
  AND context_json->>'regime' = 'DOWNTREND'
ORDER BY created_at DESC
LIMIT 20;

-- Check actual dt_reclaim orders placed
SELECT created_at, asset, side, krw_amount, reason
FROM bot_events
WHERE event_type = 'ORDER_SUBMITTED'
  AND context_json->>'reason' LIKE 'dt_reclaim_starter%'
ORDER BY created_at DESC;
```

---

## F. Risks / Limitations

| Risk | Detail |
|------|--------|
| **Downtrend is adversarial** | Reclaim attempts can fail; price may continue lower after entry. This is intentional and the small size (default ≈0.09% NAV) limits max damage per entry. |
| **No add-ons** | By design, `evaluateDowntrendReclaimStarter` is only called in the flat-portfolio branch. Existing downtrend positions will not receive follow-up buys via this path. |
| **No vol-spike requirement** | Unlike `evaluateEntry`'s downtrend path (which requires `relVol > 2.0`), the reclaim starter relies on %B + RSI only. If volume is absent, the reclaim may be a false setup. Consider adding a `relVol` check if false signals are observed. |
| **Cooldown shared with normal buys** | Uses `starter_cooldown_ms` (falls back to `buy_cooldown_ms`). If a normal buy fires shortly before a reclaim window, the reclaim will wait the full cooldown. This is safe. |
| **Sell logic unchanged** | All exit conditions, stop-loss, profit targets, and sell signals are untouched. A reclaim starter position exits exactly like any other tactical position. |
| **Disabled by default** | `dt_reclaim_starter_enabled = false` until explicitly enabled via SQL. No behaviour change on deploy until the config UPDATE is run. |
| **SOL always blocked** | `asset === 'SOL'` returns null at the top of the function — no config flag can override this. |
| **RSI 30–48 window may still miss** | If BTC RSI is 40–45 and %B is 0.12 but config is still at defaults, the entry WILL fire once enabled. Confirm near-miss diagnostics first before enabling. |
