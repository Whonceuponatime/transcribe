# BTC/ETH-Only Mode — Implementation Record

## A. Files / Functions Changed

| File | Location | Change |
|------|----------|--------|
| `lib/cryptoTraderV2.js` | line 31 | `DEFAULT_COINS` fallback |
| `lib/cryptoTraderV2.js` | sell cycle (`for (const position of openPositions)`) | Added `coin_not_in_active_universe` skip log |
| `lib/portfolioAdopter.js` | line 93 — `runAdoption` signature | `supportedCoins` default |
| `pi-trader/index.js` | `reconcile()` line 311 | coins fallback |
| `pi-trader/index.js` | `startupSequence()` line 340 | coins fallback |
| `api/crypto-trader.js` | `diagnostic-export` (~line 1065) | `COINS` default |
| `api/crypto-trader.js` | `tuning-export` (~line 1793) | `COINS` default |
| `api/crypto-trader.js` | `trade-verification` (~line 1350) | `COINS` default |
| `supabase/init_schema.sql` | `bot_config.coins` column default | Schema default |

---

## B. Patch Diff

```diff
--- a/lib/cryptoTraderV2.js
+++ b/lib/cryptoTraderV2.js
@@ -31 +31 @@
-const DEFAULT_COINS = ['BTC', 'ETH', 'SOL'];
+const DEFAULT_COINS = ['BTC', 'ETH']; // SOL removed — BTC/ETH-only mode

@@ sell cycle — for (const position of openPositions) @@
-        if (!ind) continue;
+        if (!ind) {
+          if (!coins.includes(coin)) {
+            console.log(`[v2] SELL ${coin} skipped — coin_not_in_active_universe`);
+          }
+          continue;
+        }

--- a/lib/portfolioAdopter.js
+++ b/lib/portfolioAdopter.js
@@ -93 +93 @@
-async function runAdoption(supabase, supportedCoins = ['BTC', 'ETH', 'SOL'], ...) {
+async function runAdoption(supabase, supportedCoins = ['BTC', 'ETH'], ...) {

--- a/pi-trader/index.js
+++ b/pi-trader/index.js
@@ reconcile() @@
-    const coins = cfg.coins ?? ['BTC', 'ETH', 'SOL'];
+    const coins = cfg.coins ?? ['BTC', 'ETH'];

@@ startupSequence() @@
-    const coins = cfg.coins ?? ['BTC', 'ETH', 'SOL'];
+    const coins = cfg.coins ?? ['BTC', 'ETH'];

--- a/api/crypto-trader.js
+++ b/api/crypto-trader.js
@@ diagnostic-export @@
-      const COINS  = ['BTC', 'ETH', 'SOL'];
+      const COINS  = ['BTC', 'ETH'];

@@ tuning-export @@
-      const COINS  = ['BTC', 'ETH', 'SOL'];
+      const COINS  = ['BTC', 'ETH'];

@@ trade-verification @@
-      const COINS = (req.query.coins ? req.query.coins.split(',') : ['BTC', 'ETH', 'SOL'])...
+      const COINS = (req.query.coins ? req.query.coins.split(',') : ['BTC', 'ETH'])...

--- a/supabase/init_schema.sql
+++ b/supabase/init_schema.sql
@@ bot_config.coins @@
-  coins JSONB NOT NULL DEFAULT '["BTC","ETH","SOL"]'::jsonb,
+  coins JSONB NOT NULL DEFAULT '["BTC","ETH"]'::jsonb,
```

---

## C. Universe Source of Truth

**Authoritative runtime source:** `bot_config.coins` column in Postgres (JSONB).

Read once per cycle in `getV2Config()` (`lib/cryptoTraderV2.js:54`):
```javascript
const { data } = await supabase.from('bot_config').select('*').limit(1).single();
```

Consumed at cycle start:
```javascript
const coins = cfg.coins ?? DEFAULT_COINS; // cryptoTraderV2.js:420
```

**Fallback chain (if DB row missing):**

1. `DEFAULT_COINS` in `cryptoTraderV2.js` — now `['BTC', 'ETH']`
2. `runAdoption` default — now `['BTC', 'ETH']`
3. `reconcile()` / `startupSequence()` fallbacks in `pi-trader/index.js` — now `['BTC', 'ETH']`
4. API export COINS arrays — now `['BTC', 'ETH']`

All fallbacks are now consistent with BTC/ETH-only.

**NOT a source of truth (display only):**
- `client/src/components/CryptoTraderDashboard.js` — UI display, does not drive bot decisions

---

## D. SQL / Config Changes Required

### 1. Update live bot_config row

```sql
UPDATE bot_config
SET
  coins                  = '["BTC","ETH"]'::jsonb,
  max_btc_pct            = 60,
  max_eth_pct            = 40,
  max_sol_pct            = 0,
  daily_turnover_cap_pct = 80
WHERE id = 'cd8b5fea-4c43-4642-8b63-d1c3a95dc5ab';
```

### 2. Verify

```sql
SELECT id, coins, max_btc_pct, max_eth_pct, max_sol_pct, daily_turnover_cap_pct
FROM bot_config
WHERE id = 'cd8b5fea-4c43-4642-8b63-d1c3a95dc5ab';
```

Expected result:
| field | value |
|-------|-------|
| coins | `["BTC","ETH"]` |
| max_btc_pct | 60 |
| max_eth_pct | 40 |
| max_sol_pct | 0 |
| daily_turnover_cap_pct | 80 |

### 3. Universe summary

| Asset | Active? |
|-------|---------|
| BTC | YES |
| ETH | YES |
| SOL | NO (removed) |

---

## E. Behavior for Existing SOL Positions

### Buy cycle (new entries / add-ons)
- The buy loop iterates over `coins` only.
- With SOL absent from `coins`, no buy evaluation, no starter entry, no add-on is attempted for SOL.
- Result: **zero new SOL orders**, ever, under this config.

### Sell cycle (existing managed SOL positions)
- The sell cycle iterates over `openPositions` (all managed DB positions, including SOL).
- It then looks up `liveIndicators[coin]`, which is only computed for coins in the active universe.
- `liveIndicators['SOL']` will be `undefined` → sell evaluation is **skipped** for SOL.
- Log emitted: `[v2] SELL SOL skipped — coin_not_in_active_universe`
- **Result: the bot will NOT automatically sell an existing SOL position.**
- The SOL position remains in the DB and is visible in diagnostics.
- Manual sell on Upbit is required to exit SOL.

### Dashboard / diagnostics
- SOL position rows still appear in the `positions` table query — dashboard shows them correctly.
- `diagnostic-export` and `tuning-export` no longer include SOL columns in their per-coin breakdowns.
- `trade-verification` no longer defaults to include SOL (still passable via `?coins=SOL` query param if needed).

### After manual SOL sale
- Once SOL is sold on Upbit, the position can be closed in the DB (set `state='closed'`).
- The bot will never re-enter SOL because SOL is not in `bot_config.coins`.

---

## F. Risks / Limitations

| Risk | Detail |
|------|--------|
| **SOL not auto-sold** | The bot will not sell existing SOL. Manual exit required on Upbit. After manual sale, close the position record in the DB. |
| **NAV understated while SOL held** | `getPortfolioState` sums holdings only for coins in the active universe. SOL balance is not counted → NAV appears lower than true total until SOL is sold. KRW% reading will be inflated. |
| **SOL not synced** | `syncPositionsFromExchange` only syncs coins in the active universe. SOL position qty/avg_cost in DB will not refresh from Upbit while SOL is excluded. This is safe since no orders are placed. |
| **Reconciliation skips SOL** | Reconciliation engine checks only active coins. A SOL mismatch will not be detected. Acceptable since no bot SOL activity will occur. |
| **Fallback only** | Code-level `DEFAULT_COINS` changes are safety fallbacks. The **SQL update to `bot_config.coins` is the required live action** — without it the bot continues trading SOL even after deployment. |
| **Dashboard coin tabs** | If the dashboard hard-codes BTC · ETH · SOL tabs in `CryptoTraderDashboard.js`, the SOL tab will still render but show no active buy evaluations. No code change needed for this. |
