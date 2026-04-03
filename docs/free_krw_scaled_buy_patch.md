# Free-KRW Scaled Buy Patch

## A. Files / Functions Changed

| File | Location | Change |
|------|----------|--------|
| `lib/cryptoTraderV2.js` | Buy cycle — free KRW guard (~line 1303) | `const effectiveKrw` → `let effectiveKrw` |
| `lib/cryptoTraderV2.js` | Buy cycle — free KRW guard (~line 1321) | Replace hard-block with scale-down + re-check |
| `lib/cryptoTraderV2.js` | `buy_checks` block (~line 1223) | `cash_ok` threshold corrected to `>= 5000` |
| `lib/cryptoTraderV2.js` | Buy submission result block (~line 1362) | Write `krw_size_mode` to `cycleDecisions` on successful submit |

---

## B. Patch Diff

```diff
--- a/lib/cryptoTraderV2.js
+++ b/lib/cryptoTraderV2.js

@@ effectiveKrw declaration @@
-      const effectiveKrw = Math.min(
+      let effectiveKrw = Math.min(
         activeIntent.krwAmount * (riskResult.sizeMult ?? 1),
         riskResult.cappedKrw ?? activeIntent.krwAmount,
       );

@@ free KRW guard @@
-      // ── Free KRW guard — skip before submission if balance is insufficient ──
+      // ── Free KRW guard — scale down or block before submission ───────────────
       const MIN_UPBIT_ORDER_KRW = 5000;
       if (freeKrwAvail < MIN_UPBIT_ORDER_KRW) {
         // hard block — free KRW below Upbit minimum (unchanged)
         ...
         continue;
       }
-      if (effectiveKrw > freeKrwAvail) {
-        const freeKrwBlocker = `insufficient_free_krw:requested=...`;
-        summary.skipped.push(...);
-        cycleDecisions[coin].final_action = 'NO_ACTION';
-        cycleDecisions[coin].final_reason = `buy_blocked:${freeKrwBlocker}`;
-        continue;
-      }
+      let krwSizeMode = 'full_size';
+      if (effectiveKrw > freeKrwAvail) {
+        const originalKrw = effectiveKrw;
+        effectiveKrw = freeKrwAvail;
+        if (effectiveKrw < MIN_UPBIT_ORDER_KRW) {
+          // Edge case: freeKrwAvail just above 5k but effectiveKrw was larger
+          const freeKrwBlocker = `blocked_below_min_after_scaling:...`;
+          summary.skipped.push(...);
+          cycleDecisions[coin].final_action = 'NO_ACTION';
+          cycleDecisions[coin].final_reason = `buy_blocked:${freeKrwBlocker}`;
+          continue;
+        }
+        krwSizeMode = `scaled_down_to_free_krw:original=${Math.round(originalKrw)}_scaled=${Math.round(effectiveKrw)}_available=${Math.round(freeKrwAvail)}_reserve=${Math.round(reserveKrw)}`;
+        console.log(`[v2] BUY ${coin} — ${krwSizeMode}`);
+        if (cycleDecisions[coin]) {
+          cycleDecisions[coin].krw_size_mode = krwSizeMode;
+        }
+      }

@@ buy_checks cash_ok @@
-          cash_ok:           freeKrwAvail > 0,
+          cash_ok:           freeKrwAvail >= 5000,

@@ successful submit result @@
+          if (krwSizeMode !== 'full_size') {
+            cycleDecisions[coin].krw_size_mode = krwSizeMode;
+          }
```

---

## C. Old Behavior

After risk sizing (`effectiveKrw` = risk-adjusted buy amount):

1. If `freeKrwAvail < 5000` → hard block (`below_min_order`)
2. If `effectiveKrw > freeKrwAvail` → **hard block** with reason `insufficient_free_krw:requested=X_available=Y_reserve=Z`
3. Order submitted only if `effectiveKrw <= freeKrwAvail`

Result: when signal is valid and risk allows a ~30–75k KRW buy but only ~14–15k KRW is free (rest is in reserve), the buy is **skipped entirely** every cycle. No capital is deployed despite a valid signal.

---

## D. New Behavior

1. If `freeKrwAvail < 5000` → hard block (unchanged — absolute floor)
2. If `effectiveKrw > freeKrwAvail`:
   - **Scale down**: `effectiveKrw = freeKrwAvail`
   - Re-check: if scaled amount is still `< 5000`, hard block with `blocked_below_min_after_scaling` (edge-case safety net — in practice this cannot happen since the first check already passed)
   - Otherwise: proceed to submission with the scaled-down amount
   - Console log: `[v2] BUY BTC — scaled_down_to_free_krw:original=75000_scaled=14500_available=14500_reserve=18000`
   - `cycleDecisions[coin].krw_size_mode` set to the scale-down string (visible in DECISION_CYCLE export)
3. If `effectiveKrw <= freeKrwAvail` → full-size submission, `krw_size_mode = 'full_size'` (not written to decision to reduce noise)

**Three diagnostic outcomes:**

| `krw_size_mode` | Meaning |
|----------------|---------|
| `full_size` | Order used full risk-sized amount; free KRW was sufficient |
| `scaled_down_to_free_krw:original=X_scaled=Y_...` | Order placed at Y KRW (reduced from X to fit free balance) |
| `blocked_below_min_after_scaling:...` | Free KRW is above 5k absolute minimum but scaled size fell below it (should not occur under normal conditions) |

**`cash_ok` in `buy_checks`:**
- Now correctly reflects `freeKrwAvail >= 5000` (the actual gate), not the old `freeKrwAvail > 0` which was always true.

---

## E. SQL / Config

No SQL or config changes required.

- `MIN_UPBIT_ORDER_KRW = 5000` is hardcoded (Upbit minimum order value in KRW).
- Reserve is controlled by `bot_config.krw_min_reserve_pct` (default 10% of NAV) — unchanged.
- No new `bot_config` columns needed.

---

## F. Risks / Limitations

| Risk | Detail |
|------|--------|
| **Smaller fills, more entries** | The bot will now enter with whatever free KRW is available (e.g., 14k instead of 75k). Position sizes will be smaller but entries will be real. This is desirable for capital rotation. |
| **Reserve still protected** | `freeKrwAvail = krwBalance - reserveKrw` — the reserve is computed before this path and never touched. The scale-down uses only truly free cash. |
| **Risk accounting uses scaled size** | `riskEngine.recordEntry` receives the scaled `effectiveKrw`, so daily turnover and exposure tracking remain accurate. |
| **Position avg_cost not affected** | If multiple scaled-down entries land on the same position, `applyFillToPosition` handles each fill normally — no averaging logic is changed. |
| **Sell logic unchanged** | This patch touches only the buy submission path. All sell exit conditions and thresholds are unaffected. |
| **Duplicate buys if signal persists** | If a valid signal persists across multiple cycles and each cycle has some free KRW, the buy cooldown (`buy_cooldown_ms`) is the only gate. Ensure cooldown is set appropriately (default 1800s / 30 min) to prevent over-averaging. |
