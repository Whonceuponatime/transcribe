# Tactical Floor Live Audit (Round 2)

## A. exact files/functions checked

| Area | File | What was checked |
|------|------|------------------|
| Sell evaluation + diagnostics emit | `lib/signalEngine.js` | `evaluateExit()` tactical `tactical_floor` branch; `getTacticalProfitFloorDiagnostics()` |
| DECISION_CYCLE + EXIT_EVALUATION payload | `lib/cryptoTraderV2.js` | `executeCycleV2()` — `cycleDecisions[coin].sell_checks` (tactical fields); `EXIT_EVALUATION` `context_json` (tactical fields) |
| Live trading process entry | `pi-trader/index.js` | `traderV2.executeCycleV2(supabase, opts)` — bot writes `DECISION_CYCLE` to `bot_events` |
| Dashboard diagnostics API | `api/crypto-trader.js` | `action === 'diagnostics' && GET` — maps `context_json` to compact rows (previously omitted tactical-floor keys) |
| Diagnostic JSON export | `api/crypto-trader.js` | `action === 'diagnostic-export' && GET` — `decision_rows` from `DECISION_CYCLE` / `EXIT_EVALUATION` fallback |

---

## B. whether tactical-floor code is present on live code path

**In this repository (authoritative source):** Yes.

- **Engine:** `lib/signalEngine.js` — after `reclaim_harvest`, before generic `harvest`; trim `tactical_floor`; config keys `exit_tactical_profit_floor_hours` / `exit_tactical_profit_floor_size_pct`.
- **Emit:** `lib/cryptoTraderV2.js` — `getTacticalProfitFloorDiagnostics()`; `sell_checks` includes `tactical_profit_floor_considered`, `tactical_profit_floor_blocker`, `tactical_profit_floor_would_fire`, `tactical_profit_floor_in_exits`, `tactical_profit_floor_fired`; same keys on `EXIT_EVALUATION` `context_json`.
- **Process:** `pi-trader/index.js` loads `../lib/cryptoTraderV2` and runs `executeCycleV2` each cycle.

**On a specific live host:** Not verifiable from the repo alone. If the Pi (or any runner) has not **git pull**’d a commit that contains the above files, or the Node process was not restarted after deploy, **runtime behavior and stored `DECISION_CYCLE` rows will match old code** (no tactical fields inside `sell_checks`).

---

## C. whether export/diagnostic shaping includes the new fields

**Before this round’s API patch:**

| Path | Included tactical-floor fields? |
|------|--------------------------------|
| Raw `DECISION_CYCLE` in DB | Yes **if** the running bot code is new — full `sell_checks` is stored in `context_json`. |
| `GET ...&action=diagnostic-export` → `decision_rows[].sell_checks` | Yes — serializer passed **`sell_checks` whole**; nested tactical keys appear **only if** the writer put them there. |
| `GET ...&action=diagnostic-export` → top-level row | **No** dedicated top-level `tactical_profit_floor_*` keys (easy to miss when scanning JSON). |
| `GET ...&action=diagnostics` (dashboard feed) | **No** — mapping built a **fixed list** of keys from `sell_checks`; it did **not** pass `tactical_profit_floor_*`, so they never appeared in the compact diagnostics response. |
| `EXIT_EVALUATION` fallback rows in `diagnostic-export` | **Partially missing** — fallback built a **minimal** `sell_checks` object and **dropped** tactical-floor fields even though `EXIT_EVALUATION` events in DB can contain them on `context_json`. |

**After this round’s API patch (see F):** diagnostics and diagnostic-export expose `tactical_profit_floor_considered`, `tactical_profit_floor_blocker`, `tactical_profit_floor_would_fire`, `tactical_profit_floor_fired` explicitly; EXIT_EVALUATION fallback merges tactical fields into `sell_checks` and top-level row.

---

## D. whether restart/redeploy is required

| Component | Required? |
|-----------|-----------|
| **Pi / bot process** (writes `DECISION_CYCLE`) | **Yes** — Node must load `lib/cryptoTraderV2.js` / `lib/signalEngine.js` that contain the tactical-floor patch. Restart after `git pull` (or equivalent deploy). |
| **API** (Vercel/serverless or Node host serving `api/crypto-trader.js`) | **Yes** — to serve updated `action=diagnostics` and `action=diagnostic-export` shaping in **F**. |

Config alone does not inject diagnostics; **code version** does.

---

## E. exact missing step if not live

1. On the **machine that runs the trading loop** (e.g. Pi): `git pull` (or deploy artifact) to a commit that includes tactical-floor in `lib/`; **restart** the process running `pi-trader/index.js` (or your process manager unit).
2. On the **API host**: deploy a build that includes the **`api/crypto-trader.js`** changes in **F** so diagnostics/export surface tactical fields even when `sell_checks` is nested.
3. Confirm **`DECISION_CYCLE`** events exist (`decision_source: DECISION_CYCLE` in diagnostic export). If only `EXIT_EVALUATION_fallback`, the bot is old or `DECISION_CYCLE` writes are failing — still, EXIT_EVAL rows can carry tactical fields once the bot emits them (EXIT_EVAL path also patched in **F**).

---

## F. exact patch diff if export shaping is missing

```diff
diff --git a/api/crypto-trader.js b/api/crypto-trader.js
index da98875c..be931e4b 100644
--- a/api/crypto-trader.js
+++ b/api/crypto-trader.js
@@ -293,6 +293,11 @@ module.exports = async function handler(req, res) {
           starter_cooldown_ms_effective:     bc.starter_cooldown_ms_effective     ?? null,
           existing_position_strategy_tag:    bc.existing_position_strategy_tag    ?? null,
           route_to_existing_position:        bc.route_to_existing_position        ?? null,
+          // Tactical profit-floor (lib/cryptoTraderV2 sell_checks) — explicit for exports/dashboard
+          tactical_profit_floor_considered: sc.tactical_profit_floor_considered ?? null,
+          tactical_profit_floor_blocker:    sc.tactical_profit_floor_blocker    ?? null,
+          tactical_profit_floor_would_fire: sc.tactical_profit_floor_would_fire ?? null,
+          tactical_profit_floor_fired:      sc.tactical_profit_floor_fired      ?? null,
         };
       });
       return res.status(200).json({ diagnostics });
@@ -1172,6 +1177,7 @@ module.exports = async function handler(req, res) {
             krw: ord.krw_requested, error: ord.error_message ?? null,
           })) : null;
 
+          const sc = cx.sell_checks ?? {};
           return {
             timestamp:         ev.created_at,
             symbol:            sym,
@@ -1184,6 +1190,12 @@ module.exports = async function handler(req, res) {
             cooldown_remaining: cx.cooldown_remaining ?? null,
             buy_checks:        cx.buy_checks  ?? null,
             sell_checks:       cx.sell_checks ?? null,
+            sell_blocker:      sc.final_sell_blocker ?? null,
+            buy_blocker:       (cx.buy_checks && !cx.buy_checks.final_buy_eligible) ? (cx.final_reason ?? null) : null,
+            tactical_profit_floor_considered: sc.tactical_profit_floor_considered ?? null,
+            tactical_profit_floor_blocker:    sc.tactical_profit_floor_blocker    ?? null,
+            tactical_profit_floor_would_fire: sc.tactical_profit_floor_would_fire ?? null,
+            tactical_profit_floor_fired:      sc.tactical_profit_floor_fired      ?? null,
             final_action:      cx.final_action,
             final_reason:      cx.final_reason,
             order_attempt:     orderAttempt,
@@ -1214,7 +1226,17 @@ module.exports = async function handler(req, res) {
               exits_triggered:     cx.exits_triggered ?? [],
               final_sell_eligible: cx.eligible ?? false,
               final_sell_blocker:  cx.blocker_summary ?? null,
+              tactical_profit_floor_considered: cx.tactical_profit_floor_considered ?? null,
+              tactical_profit_floor_blocker:    cx.tactical_profit_floor_blocker    ?? null,
+              tactical_profit_floor_would_fire: cx.tactical_profit_floor_would_fire ?? null,
+              tactical_profit_floor_in_exits:   cx.tactical_profit_floor_in_exits   ?? null,
+              tactical_profit_floor_fired:      cx.tactical_profit_floor_fired      ?? null,
             },
+            sell_blocker: cx.blocker_summary ?? null,
+            tactical_profit_floor_considered: cx.tactical_profit_floor_considered ?? null,
+            tactical_profit_floor_blocker:    cx.tactical_profit_floor_blocker    ?? null,
+            tactical_profit_floor_would_fire: cx.tactical_profit_floor_would_fire ?? null,
+            tactical_profit_floor_fired:      cx.tactical_profit_floor_fired      ?? null,
             final_action:  cx.eligible ? 'SELL_TRIGGERED' : 'NO_ACTION',
             final_reason:  cx.blocker_summary ?? ev.message,
             order_attempt: null,
```

**Emit reference (where values are produced for `sell_checks`):** `lib/cryptoTraderV2.js` inside `executeCycleV2`, block that sets `cycleDecisions[coin].sell_checks` after `signalEngine.evaluateExit` / `getTacticalProfitFloorDiagnostics`.
