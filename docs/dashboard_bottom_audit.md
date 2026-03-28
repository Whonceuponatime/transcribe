# Dashboard Bottom Section — Data Source Audit

## A. Exact Files and Components

| Panel | UI component | Lines |
|---|---|---|
| Open Tactical Positions | `CryptoTraderDashboard.js` | 969–991 |
| Bot Logs | `CryptoTraderDashboard.js` | 994–1029 |
| Decision Feed | `CryptoTraderDashboard.js` | 1031–1093 |
| Recent Trades | `CryptoTraderDashboard.js` | 1097–1124 |

All four live in one file. There are no child components.

---

## B. Exact API and Data Sources

### Open Tactical Positions

**UI state**: `v2Positions` — populated by `fetchV2Data()` (line 92)  
**API call**: `GET /api/crypto-trader?action=positions`  
**API handler**: `api/crypto-trader.js` line 785  
**Query**:
```javascript
supabase.from('positions')
  .select('*')
  .in('state', ['open', 'adopted', 'partial'])
  .order('opened_at', { ascending: false })
```
**Table**: `positions`  
**Price enrichment**: Reads `app_settings.v2_portfolio_snapshot` and derives `current_price_krw` as `valueKrw / qty_open`.  
**No `strategy_tag` filter** — returns tactical, unassigned, core, and adopted in one flat array.

---

### Bot Logs

**UI state**: `logs` — populated by `fetchLogs()` (line 236)  
**API call**: `GET /api/crypto-trader?action=logs&limit=100`  
**API handler**: `api/crypto-trader.js` line 214  
**Query**:
```javascript
supabase.from('bot_events')
  .select('id, event_type, severity, subsystem, message, created_at')
  .in('severity', ['info', 'warn', 'error'])
  .not('event_type', 'in', `(
    "DECISION_CYCLE","DECISION_EMIT_ATTEMPT","DECISION_EMIT_SUCCESS",
    "CYCLE_START_HEARTBEAT","CYCLE_END_HEARTBEAT","SNAPSHOT_EMIT_SUCCESS",
    "RESEARCH_INDICATORS","EXIT_EVALUATION"
  )`)
  .order('created_at', { ascending: false })
  .limit(100)
```
**Table**: `bot_events`  
**No `mode` filter** — returns all modes (live, paper, shadow) though engine is always live now.  
**`context_json` is NOT selected** — raw `message` string only, no structured blocker data.

---

### Decision Feed

**UI state**: `diagLogs` — populated by `fetchDiag()` (line 255)  
**API call**: `GET /api/crypto-trader?action=diagnostics`  
**API handler**: `api/crypto-trader.js` line 236  
**Query**:
```javascript
supabase.from('bot_events')
  .select('id, message, context_json, regime, created_at')
  .eq('event_type', 'DECISION_CYCLE')
  .order('created_at', { ascending: false })
  .limit(60)
```
**Table**: `bot_events` where `event_type = 'DECISION_CYCLE'`  
**Shaping**: The handler at line 246 extracts fields from `context_json` and returns a compact row per event.

The `buy_blocker` field is computed as:
```javascript
buy_blocker: cx.buy_checks != null
  ? (cx.buy_checks.signal_met ? null : 'signal_not_met')
  : null,
```
This collapses every buy failure to the string `'signal_not_met'` or `null`. The actual blocker string (e.g. `signal_not_met:bb_pctB=0.612 >= threshold=0.45` or `buy_cooldown_15min_remaining` or `Loss streak breaker active`) is in `cx.final_reason` and IS returned as `final_reason` — but displayed in the UI with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` which truncates it in most cases.

The new `starter_into_existing_*` diagnostic fields added in the latest patch are **not extracted or returned** by this endpoint.

---

### Recent Trades

**UI state**: `trades` — derived from `status.recentTrades` → set from `fetchStatus()` (line 71)  
**API call**: `GET /api/crypto-trader?action=status` (same call as the main status load)  
**API handler**: `api/crypto-trader.js` line 45  
**Query**:
```javascript
supabase.from('v2_fills')
  .select('asset, side, price_krw, qty, fee_krw, executed_at')
  .order('executed_at', { ascending: false })
  .limit(20)
```
**Table**: `v2_fills`  
**Mapping at line 131**:
```javascript
recentTrades: (recentTradesRes.data || []).map((f) => ({
  coin:        f.asset,
  side:        f.side,
  krw_amount:  f.price_krw && f.qty ? Math.round(f.price_krw * f.qty) : null,
  coin_amount: f.qty,
  price_krw:   f.price_krw,
  executed_at: f.executed_at,
  engine:      'V2',
})),
```

**`entry_reason` is NOT selected** — the `v2_fills` column is named `entry_reason`, not `reason`. The UI renders `t.reason` which is always `undefined`. `REASON_LABELS[undefined]` is `undefined`, so the Reason column in the table is always blank — this is the root cause of Recent Trades appearing broken.

**`strategy_tag`, `entry_regime`, `position_id`, `order_id`** are also not selected.

---

## C. Current Source-of-Truth Issues

### Issue 1 — Recent Trades: Reason column is always blank
The status query selects `asset, side, price_krw, qty, fee_krw, executed_at` from `v2_fills`. The fill reason is stored in the `entry_reason` column, which is not fetched. The UI maps `t.reason` which does not exist in the returned object. The entire Reason column renders blank or undefined for every row.

**Fix**: Add `entry_reason` to the `v2_fills` select. Map it as `reason: f.entry_reason` in the response.

### Issue 2 — Recent Trades: `krw_amount` approximation may be wrong for sells
`krw_amount = price_krw × qty` is the gross value of the fill at `price_krw`. For buys this is the KRW spent. For sells it is the gross KRW received before fees. This is correct directionally but not labeled as gross, and the fee column is fetched but not shown. Net KRW is `price_krw × qty − fee_krw`.

### Issue 3 — Recent Trades: No `strategy_tag` or `entry_regime` shown
`v2_fills` stores `strategy_tag` and `entry_regime` per fill. These are not selected or displayed. The table cannot distinguish between tactical, core, and adopted fills.

### Issue 4 — Decision Feed: `buy_blocker` loses all detail
The API hardcodes `buy_blocker = 'signal_not_met'` for any failed signal check. The actual reason string — which includes the exact metric, actual value, and threshold — is in `cx.final_reason` (already returned) but displayed truncated. The `cx.buy_checks.risk_blocker` field (the risk engine rejection string) is not surfaced at all.

**Fix**: Replace the simplified `buy_blocker` with `cx.final_reason` directly, or expand the shape to also surface `cx.buy_checks.risk_blocker`, `cx.buy_checks.ob_imbalance`, and the new `starter_into_existing_*` fields.

### Issue 5 — Decision Feed: New starter diagnostics not exposed
The seven `starter_into_existing_*` fields written to `buy_checks` by the latest patch are never extracted by the `diagnostics` handler and never shown in the UI.

### Issue 6 — Open Tactical Positions: No `strategy_tag` filter in API or UI
`action=positions` returns all open/adopted/partial positions regardless of `strategy_tag`. The V2 section header says "Open Tactical Positions" but the `v2Positions` array fed to it contains adopted, unassigned, core, and tactical positions mixed together. The UI at line 970 renders all of them without distinction.

The adoption panel below it separately filters `v2Positions` for `origin === 'adopted_at_startup'`, so the same positions appear in two panels simultaneously — once labeled "Open Tactical Positions" and again in "Adopted Holdings".

**Fix in UI**: Filter `v2Positions` to `strategy_tag === 'tactical'` before rendering this section. Display adopted/core/unassigned separately or in the existing adoption panel only.

### Issue 7 — Bot Logs: No `context_json` — blocker detail invisible
The `logs` endpoint selects only `id, event_type, severity, subsystem, message, created_at`. The `context_json` field (which contains full blocker strings, fill details, order IDs, etc.) is never fetched. Log rows show only the raw `message` text — which for events like `EXECUTION` is just `"BUY BTC ₩25,000 → filled"` without the identifier, fill count, or position_id.

### Issue 8 — Bot Logs: Not auto-refreshed
`fetchLogs()` only runs on manual click or first open. The 15s auto-refresh interval added to `fetchStatus` and `fetchV2Data` does not include `fetchLogs`. Bot Logs go stale silently.

### Issue 9 — Decision Feed: Not auto-refreshed
Same as Bot Logs — `fetchDiag()` only runs on manual click or first open of the collapsible.

---

## D. What Each Panel Should Use Instead

### Open Tactical Positions

**Should use**: `action=positions` (same endpoint) but filtered in the UI or API to `strategy_tag === 'tactical'`.  
**Should show per row**: asset, qty_open, avg_cost_krw, current_price_krw, unrealized_pnl_pct, entry_regime, entry_reason, fired_trims, opened_at, position_id.  
**Fired trims** (`fired_trims` column in `positions`) are already in `select('*')` but not displayed — they tell you which profit tranches have already fired (trim1, trim2, regime_break).

### Bot Logs

**Should use**: `bot_events` (same table) but:
- Also select `context_json` and surface the blocker/fill/order fields inline
- Add `mode = 'live'` filter to exclude any historical paper events
- Auto-refresh alongside `fetchV2Data` every 15s (or at least every open of the panel)
- Group by event_type or show subsystem as a prominent tag rather than a dim secondary label

### Decision Feed

**Should use**: `bot_events` where `event_type = 'DECISION_CYCLE'` (same table) but reshape the API to expose:
- Full `final_reason` string (not truncated)
- The actual `buy_blocker` string from `cx.final_reason` (not collapsed to `'signal_not_met'`)
- `ob_imbalance` actual value and effective threshold
- `starter_into_existing_attempted`, `starter_into_existing_passed`, `starter_into_existing_blocker`
- `entry_regime` and `signal_met`
- Auto-refresh (same as above)

### Recent Trades

**Should use**: `v2_fills` with an expanded select:
```javascript
supabase.from('v2_fills')
  .select('asset, side, price_krw, qty, fee_krw, entry_reason, entry_regime, strategy_tag, executed_at, order_id, position_id')
  .order('executed_at', { ascending: false })
  .limit(30)
```
Map `f.entry_reason` → `reason` in the response shape so the UI `REASON_LABELS[t.reason]` lookup works.  
**Alternatively**, join `v2_fills` with `orders` to surface `regime_at_order` and the full order reason.
