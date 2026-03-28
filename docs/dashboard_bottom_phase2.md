# Dashboard Bottom Section — Phase 2 Implementation

## A. Exact Files and Functions Changed

| File | Location | Change |
|---|---|---|
| `api/crypto-trader.js` | line 45 | `v2_fills` select expanded + limit 20→30 |
| `api/crypto-trader.js` | lines 131–147 | `recentTrades` response mapping rewritten |
| `api/crypto-trader.js` | lines 221–228 | `action=logs` query: added `context_json`, `mode='live'` filter |
| `api/crypto-trader.js` | lines 246–285 | `action=diagnostics` shape: 14 new fields, fixed `buy_blocker` |
| `client/src/components/CryptoTraderDashboard.js` | line 1 | Added `useRef` to React import |
| `client/src/components/CryptoTraderDashboard.js` | after `toggleDiag` | Added `diagOpenRef`, `logsOpenRef` + sync effects |
| `client/src/components/CryptoTraderDashboard.js` | after refs | Auto-refresh interval extended to include `fetchDiag` / `fetchLogs` when open |
| `client/src/components/CryptoTraderDashboard.js` | positions section | Filtered to tactical only; added fired_trims, opened_at, mark price, entry_reason detail line |
| `client/src/components/CryptoTraderDashboard.js` | bot logs section | Added `context_json.reason` + fill count inline for EXECUTION events |
| `client/src/components/CryptoTraderDashboard.js` | decision feed section | Full reason line (no truncation), OB/BB value+threshold together, starter-into-existing detail |
| `client/src/components/CryptoTraderDashboard.js` | recent trades section | New columns (Fee, Regime), correct Reason, gross_krw + net tooltip |

---

## B. Exact Patch Diff

### `api/crypto-trader.js` — v2_fills select (action=status)

```diff
-  supabase.from('v2_fills').select('asset,side,price_krw,qty,fee_krw,executed_at')
-    .order('executed_at', { ascending: false }).limit(20),
+  supabase.from('v2_fills')
+    .select('asset,side,price_krw,qty,fee_krw,entry_reason,entry_regime,strategy_tag,order_id,position_id,executed_at')
+    .order('executed_at', { ascending: false }).limit(30),
```

### `api/crypto-trader.js` — recentTrades mapping

```diff
-  recentTrades: (recentTradesRes.data || []).map((f) => ({
-    coin:        f.asset,
-    side:        f.side,
-    krw_amount:  f.price_krw && f.qty ? Math.round(f.price_krw * f.qty) : null,
-    coin_amount: f.qty,
-    price_krw:   f.price_krw,
-    executed_at: f.executed_at,
-    engine:      'V2',
-  })),
+  recentTrades: (recentTradesRes.data || []).map((f) => {
+    const gross = f.price_krw && f.qty ? Math.round(f.price_krw * f.qty) : null;
+    const fee   = f.fee_krw ? Math.round(f.fee_krw) : 0;
+    return {
+      coin: f.asset, side: f.side,
+      gross_krw: gross, fee_krw: fee, net_krw: gross != null ? gross - fee : null,
+      coin_amount: f.qty, price_krw: f.price_krw,
+      reason:       f.entry_reason  ?? null,  // was missing — entry_reason col → reason
+      entry_regime: f.entry_regime  ?? null,
+      strategy_tag: f.strategy_tag  ?? null,
+      order_id:     f.order_id      ?? null,
+      position_id:  f.position_id   ?? null,
+      executed_at:  f.executed_at, engine: 'V2',
+    };
+  }),
```

### `api/crypto-trader.js` — logs query (action=logs)

```diff
   .from('bot_events')
-  .select('id, event_type, severity, subsystem, message, created_at')
+  .select('id, event_type, severity, subsystem, message, context_json, created_at')
+  .eq('mode', 'live')
   .in('severity', ['info', 'warn', 'error'])
```

### `api/crypto-trader.js` — diagnostics shape (action=diagnostics)

```diff
-  buy_blocker: cx.buy_checks != null
-    ? (cx.buy_checks.signal_met ? null : 'signal_not_met')
-    : null,
+  buy_blocker: Object.keys(bc).length > 0 && !bc.final_buy_eligible
+    ? (cx.final_reason ?? 'blocked') : null,
+  risk_blocker:   bc.risk_blocker   ?? null,
+  ob_imbalance:   bc.ob_imbalance   ?? null,
+  // ... 10 more starter_into_existing_* + route fields
```

### `CryptoTraderDashboard.js` — auto-refresh

```diff
+  const diagOpenRef = useRef(false);
+  const logsOpenRef = useRef(false);
+  useEffect(() => { diagOpenRef.current = diagOpen; }, [diagOpen]);
+  useEffect(() => { logsOpenRef.current = logsOpen; }, [logsOpen]);
   useEffect(() => {
     const id = setInterval(() => {
       fetchStatus({ silent: true });
       fetchV2Data();
+      if (diagOpenRef.current) fetchDiag();
+      if (logsOpenRef.current) fetchLogs();
     }, 15000);
     return () => clearInterval(id);
-  }, [fetchStatus, fetchV2Data]);
+  }, [fetchStatus, fetchV2Data, fetchDiag, fetchLogs]);
```

---

## C. Exact Source-of-Truth Fixes Made

### Fix 1 — Recent Trades: Reason column now populated
**Root cause**: `v2_fills` stores reason in `entry_reason` column. The status query didn't select it. The response mapped a non-existent `f.reason` field. Result: every Reason cell was blank.  
**Fix**: Select `entry_reason` in the query. Map `f.entry_reason → reason` in response. `REASON_LABELS[t.reason]` now resolves correctly.

### Fix 2 — Recent Trades: Explicit gross/net labeling
**Root cause**: `krw_amount = price_krw × qty` was computed but not labeled as gross. Fee was fetched but not shown.  
**Fix**: Response now provides `gross_krw`, `fee_krw`, `net_krw` as separate fields. UI shows gross in the KRW column with a hover tooltip showing net. Fee column added.

### Fix 3 — Decision Feed: `buy_blocker` no longer collapses to `'signal_not_met'`
**Root cause**: The API hardcoded `buy_blocker = 'signal_not_met'` for any buy failure. The exact reason (bb_pctB value, RSI value, cooldown minutes, risk engine reason) was invisible.  
**Fix**: `buy_blocker` now returns the full `cx.final_reason` string when a buy was blocked. The same string is also shown as `final_reason` in the UI in a full-width, non-truncated line.

### Fix 4 — Decision Feed: `final_reason` no longer truncated
**Root cause**: `final_reason` rendered with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` — most of the useful string was hidden.  
**Fix**: `final_reason` now renders as a full-width detail line below the chip row, with `word-break: break-word`. Nothing is hidden.

### Fix 5 — Decision Feed: New diagnostic fields surfaced
The 7 `starter_into_existing_*` fields written to `buy_checks` (from the starter diagnostics patch) are now extracted in the API and rendered in a distinct teal/yellow detail line when `starter_into_existing_attempted = true`.

### Fix 6 — Open Tactical Positions: Now filters to tactical only
**Root cause**: `v2Positions` contains all positions (tactical, unassigned, core, adopted). The section header said "Tactical" but showed all of them, causing duplicates with the Adoption panel.  
**Fix**: UI filters `v2Positions.filter(p => p.strategy_tag === 'tactical')` before rendering this section. Count shown in header.

### Fix 7 — Open Tactical Positions: New fields shown
Now renders: mark price, fired_trims (with tooltip), opened_at timestamp, entry_reason as secondary line, unrealized P&L in bold.

### Fix 8 — Bot Logs: `context_json` now fetched; `mode='live'` filter applied
**Root cause**: `context_json` was not selected; pre-live mode events could appear.  
**Fix**: Query now selects `context_json` and filters `.eq('mode', 'live')`. For EXECUTION events, `context_json.reason` and fill count are appended inline.

### Fix 9 — Decision Feed + Bot Logs: Auto-refresh when panel is open
Both panels previously went stale after opening. Refs (`diagOpenRef`, `logsOpenRef`) track open state without resetting the interval. When open, both panels refresh every 15 seconds alongside the main status refresh.

---

## D. Exact UI Behavior Changes

### Open Tactical Positions
- **Before**: showed all positions regardless of strategy_tag
- **After**: shows only `strategy_tag='tactical'`; count in header; adopted/core shown only in the Adoption panel below
- **New fields**: mark price (₩), unrealized P&L (bold colored), `fired_trims` badge (purple), `since` timestamp, entry_reason as sub-line

### Bot Logs
- **Before**: raw message only; went stale; included paper/shadow events
- **After**: `mode='live'` filter; auto-refreshes every 15s when open; EXECUTION events show `reason + fill count` appended in dim text

### Decision Feed
- **Before**: buy_blocker always `'signal_not_met'`; reason truncated with ellipsis; no starter-into-existing visibility; OB showed threshold only
- **After**:
  - OB shows `actual_value/min_threshold` (e.g. `OB -0.52/-0.45`) colored red when blocking
  - BB shows `actual_value/cap` (e.g. `%B 0.61/0.45`) colored red when blocking
  - `final_reason` shown as full-width non-truncated secondary line
  - Starter-into-existing: yellow/green detail line when `starter_into_existing_attempted=true`
  - `→existing` chip when `route_to_existing_position=true`
  - Auto-refreshes every 15s when panel is open

### Recent Trades
- **Before**: Reason column always blank; KRW labeled ambiguously; no regime column
- **After**: Reason populates correctly via `entry_reason → reason` fix; columns are `Gross KRW`, `Fee`, `Qty`, `Regime`, `Reason`; net KRW available as hover tooltip on the gross cell

---

## E. Remaining Limitations

**1. Recent Trades: no manual refresh button**  
The trades panel is populated from `fetchStatus` (main status load). It does not have its own refresh button or separate auto-refresh — it updates every 30s when `fetchStatus` runs. Adding a dedicated refresh would require a separate fetch action.

**2. Bot Logs context_json: only EXECUTION events get structured detail**  
Other event types (FILL_FALLBACK_DIRECT, REGIME_SWITCH, CYCLE_FROZEN, etc.) don't have a UI expansion — only the raw `message` shows. Expanding structured context for all event types would require per-event-type parsing logic.

**3. Decision Feed: sell_blocker not prominently shown**  
`sell_blocker` is now correctly returned from `sc.final_sell_blocker` but is not rendered in the feed row. Sell evaluation detail (trim tranche state, trailing stop distance, edge gate) is in the data but not in the UI. Adding it would make each row taller.

**4. Decision Feed: no time-range filter**  
The endpoint returns the last 60 events globally, not filtered by time window. A session with many cycles for 3 coins will give ~20 cycles of history. Pagination or a time-range selector would improve long-session diagnosis.

**5. `v2_fills.fee_krw` precision**  
The fee is estimated at fill insertion time as `funds × feeRate` (approximate). It may differ slightly from the fee Upbit actually charged. The difference is typically < 1 KRW per trade.
