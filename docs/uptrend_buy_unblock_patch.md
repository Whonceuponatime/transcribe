# Uptrend Buy Unblock Patch

## A. Files / Functions Changed

| File | Change |
|---|---|
| `lib/cryptoTraderV2.js` | `executeCycleV2` buy loop: add `reserveKrw` / `freeKrwAvail` pre-computation, free-KRW guard before `executeBuy`, new fields in `buy_checks` |
| `bot_config` (SQL) | `max_btc_pct`, `max_eth_pct`, `max_sol_pct`, `entry_bb_pct_uptrend`, `adaptive_bb_uptrend_max` |

No changes to `lib/signalEngine.js`, `lib/riskEngine.js`, or `lib/adaptiveThresholds.js`.

---

## B. Exact Patch Diff

### Before buy loop — add KRW pre-computation

```diff
+    // Pre-compute KRW reserve and free balance once per cycle.
+    const reserveKrw   = portfolio.navKrw * (cfg.krw_min_reserve_pct ?? 10) / 100;
+    const freeKrwAvail = Math.max(0, portfolio.krwBalance - reserveKrw);
+
     for (const coin of coins) {
```

### buy_checks DECISION_CYCLE diagnostics

```diff
-         cash_ok: portfolio.krwBalance > (portfolio.navKrw * (cfg.krw_min_reserve_pct ?? 12) / 100),
+         cash_ok:            freeKrwAvail > 0,
+         krw_balance:        +portfolio.krwBalance.toFixed(0),
+         reserve_krw:        +reserveKrw.toFixed(0),
+         free_krw_available: +freeKrwAvail.toFixed(0),
```

### Free-KRW execution guard (inserted after effectiveKrw, before executeBuy)

```diff
+      const MIN_UPBIT_ORDER_KRW = 5000;
+      if (freeKrwAvail < MIN_UPBIT_ORDER_KRW) {
+        const reason = `insufficient_free_krw:below_min_order(free=...,reserve=...)`;
+        summary.skipped.push(`BUY ${coin}: ${reason}`);
+        cycleDecisions[coin].final_reason = `buy_blocked:${reason}`;
+        continue;
+      }
+      if (effectiveKrw > freeKrwAvail) {
+        const reason = `insufficient_free_krw:requested=..._available=..._reserve=...`;
+        summary.skipped.push(`BUY ${coin}: ${reason}`);
+        cycleDecisions[coin].final_reason = `buy_blocked:${reason}`;
+        continue;
+      }
```

---

## C. Exact SQL Update

```sql
UPDATE bot_config
SET
  -- Exposure caps (independent per-asset, no code assumes sum <= 100)
  max_btc_pct              = 55,
  max_eth_pct              = 30,
  max_sol_pct              = 25,
  -- Uptrend BB threshold: allows mid-uptrend entries not just deep pullbacks
  -- Base raised from 0.45 → 0.55; adaptive max raised from 0.60 → 0.70
  entry_bb_pct_uptrend     = 0.55,
  adaptive_bb_uptrend_max  = 0.70,
  updated_at               = now()
WHERE id = 'cd8b5fea-4c43-4642-8b63-d1c3a95dc5ab';
```

---

## D. Free-KRW Guard Behavior

| Condition | Blocker string | Action |
|---|---|---|
| `freeKrwAvail < 5000` | `insufficient_free_krw:below_min_order(free=X,reserve=Y)` | Skip, log, `continue` |
| `effectiveKrw > freeKrwAvail` | `insufficient_free_krw:requested=X_available=Y_reserve=Z` | Skip, log, `continue` |
| Both pass | — | Proceeds to `executeBuy` |

`freeKrwAvail = max(0, portfolio.krwBalance - reserveKrw)` where `reserveKrw = navKrw × krw_min_reserve_pct%`.

The guard runs **after** all risk checks and **after** `effectiveKrw` is sized (post-drawdown-multiplier, post-risk-cap). It is a pre-submission check, not a signal filter. Sells are unaffected.

New `DECISION_CYCLE` `buy_checks` fields added:
- `free_krw_available` — actual spendable KRW after reserve
- `reserve_krw` — computed reserve for this cycle
- `krw_balance` — raw portfolio KRW balance

---

## E. Uptrend Participation Tweak — Option A chosen

**Choice made:** Option A (raise `entry_bb_pct_uptrend` + `adaptive_bb_uptrend_max` via SQL).

Option B (uptrend continuation logic) was not implemented — it would require new code in `evaluateEntry`, introduces a new signal path, and is harder to audit. Option A is a single config value change that is already threaded through the system correctly.

**What changes:**
- `entry_bb_pct_uptrend`: `0.45 → 0.55` — the base BB %B threshold for uptrend entry. ETH BB %B above 0.45 but below 0.55 (mid-band) now qualifies as a pullback signal in uptrend.
- `adaptive_bb_uptrend_max`: `0.60 → 0.70` — the hard upper clamp on the adaptive BB uptrend threshold. When inactivity or flat-portfolio offsets are applied (+0.07, +0.03), the effective threshold can now reach up to 0.70 instead of being clamped at 0.60.

RSI bounds (`42–55`) and OB minimum are unchanged. The uptrend still requires RSI to be within a sane dip range — this is not a full continuation breakout signal.

---

## F. Risks / Limitations

**Exposure cap sum > 100%:** `max_btc_pct + max_eth_pct + max_sol_pct = 110%`. No code checks the sum — each cap is an independent per-asset ceiling. Combined with the 10% KRW reserve, full deployment across all three assets simultaneously is not possible in practice. BTC at 55% + ETH at 30% = 85% already, leaving 15% for SOL before the overall KRW is exhausted.

**Higher BB threshold in uptrend:** Raising `entry_bb_pct_uptrend` to 0.55 allows entries with BB %B up to 0.55 (vs 0.45). This captures more mid-band moves during uptrends. The RSI guard (42–55) still requires meaningful dip momentum — pure breakout continuation without any pullback is still not allowed. Risk is more frequent entries during extended uptrends; manage via `max_entries_per_coin_24h` and `buy_cooldown_ms`.

**Free-KRW guard sizing:** `effectiveKrw` is computed post-risk-engine which may already cap the size. If a valid signal exists but KRW is truly exhausted, the bot now silently skips rather than submitting a doomed order. This is correct behavior but means signals can be missed when reserve is tight.

**No change to sell logic:** All exit paths (time_stop, regime_break, trims, runner) are unaffected.
