# Dashboard Bottom Section — Phase 3 Presentation Pass

## A. Exact Files and Functions Changed

| File | Change |
|---|---|
| `client/src/components/CryptoTraderDashboard.css` | Added ~130 lines of new CSS classes for telemetry strip, position table, decision cards, blotter, secondary log panel |
| `client/src/components/CryptoTraderDashboard.js` | Added `regStyle` module-level helper; redesigned tactical positions table; added telemetry strip; reordered sections; redesigned all four bottom panels |

No API changes. No trading logic changes. Only presentational and ordering changes.

---

## B. Exact Patch Diff

### New `regStyle` helper (top of file, after `rsiColor`)

```javascript
const regStyle = (r) => ({
  background: r === 'UPTREND' ? 'rgba(34,197,94,0.12)' : r === 'DOWNTREND' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.10)',
  color:      r === 'UPTREND' ? '#22c55e'               : r === 'DOWNTREND' ? '#ef4444'               : '#f59e0b',
});
```

Used in: tactical position table, decision feed regime badge, blotter regime cell.

### New CSS classes added (end of CryptoTraderDashboard.css)

| Class | Purpose |
|---|---|
| `.ct__telem-strip` / `.ct__telem-card` / `.ct__telem-label` / `.ct__telem-val` | Telemetry strip cards |
| `.ct__panel-label` | Section sub-label (uppercase, dim) |
| `.ct__pos-table-wrap` / `.ct__pos-table` | Position table with sticky header row |
| `.ct__pos-row` / `.ct__pos-reason-row` | Table row pair (data + entry_reason sub-row) |
| `.ct__regime-chip` / `.ct__trim-chip` | Colored regime badge and fired-trims chips |
| `.ct__diag-cards` / `.ct__diag-card` | Decision feed card container + per-row card |
| `.ct__diag-header` / `.ct__diag-time` / `.ct__diag-coin` / `.ct__diag-regime-badge` / `.ct__diag-action-chip` / `.ct__diag-price` | Decision card header row |
| `.ct__diag-indicators` / `.ct__diag-ind` / `.ct__diag-cap` / `.ct__diag-chip` (+ modifiers) | Indicator row and colored chips |
| `.ct__diag-reason` / `.ct__diag-starter` | Reason and starter detail lines |
| `.ct__blotter-wrap` / `.ct__blotter` | Blotter table container |
| `.ct__blotter-buy` / `.ct__blotter-sell` | Row accent via left border |
| `.ct__bl-fee` / `.ct__bl-price` | Muted fee/price cells |
| `.ct__side-pill` (+ `--buy` / `--sell`) | Side pill badges |
| `.ct__logs-panel-secondary` / `.ct__log-row-v3` / `.ct__log-sev` / `.ct__log-sub` / `.ct__log-msg-v3` | Secondary log panel (darker, more compact) |

### Section reordering

```
BEFORE:                          AFTER:
  Bot Logs                         Telemetry Strip (NEW)
  Decision Feed                    Decision Feed  ← moved up (primary)
  Recent Trades                    Recent Trades  (blotter)
  Danger Zone                      Bot Logs       ← moved down (secondary)
                                   Danger Zone
```

### Tactical positions: flat rows → table with sub-rows

```diff
- flat flex row with inline labels
+ <table className="ct__pos-table">
+   columns: Asset | Qty | Avg Cost | Mark | P&L | Regime | Trims | Age
+   sub-row: entry_reason spanning all 8 columns
+   React.Fragment key per position to pair row + sub-row
```

---

## C. Exact UI Structure Added

### Telemetry Strip
Horizontally scrollable card strip. Computed from already-loaded component state. No API call.

```
[ Positions: N ]  [ Unrealized P&L: ±₩X ]  [ Decision Rows: N ]  [ Buys Blocked: N ]
[ Starter→Existing: N tried · ✓N ]  [ Fills (30): NB / NS ]  [ Top Blocker: X×N ]  [ System: ✓ LIVE / ⛔ FROZEN ]
```

Cards separated by `1px` right border lines. Scrollable on small screens. `Unrealized P&L` only shown when current_price_krw, avg_cost_krw, qty_open are all present for at least one tactical position.

### Open Tactical Positions (inside V2 Engine card)
Dense table with 8 columns and a paired sub-row for entry_reason.

| Col | Data source |
|---|---|
| Asset | `p.asset` — bold, light text |
| Qty | `p.qty_open.toFixed(6)` |
| Avg Cost | `p.avg_cost_krw` formatted |
| Mark | `p.current_price_krw` (from snapshot enrichment) |
| P&L | `p.unrealized_pnl_pct` — green / red, bold |
| Regime | `p.entry_regime` as colored chip with border |
| Trims | `p.fired_trims[]` as purple `.ct__trim-chip` per item |
| Age | computed from `p.opened_at` as `Xd Yh` or `Xh Ym` |
| sub-row | `p.entry_reason` spanning all 8 cols, dim text |

### Decision Feed (primary panel, now above Recent Trades)
Three-line card per decision row. Panel opens collapsed (user must click). Auto-refreshes every 15s when open.

**Line 1 — identity + action:**
```
[time]  [COIN]  [REGIME badge]  [ACTION chip]  [P&L if position]  [₩price right-aligned]
```

**Line 2 — indicators + chips:**
```
RSI 48.2  %B 0.612/0.450 (red if blocking)  OB -0.52/-0.45 (red if blocking)
[μ-bypass]  [→existing]  [risk_blocker chip]  [sell:blocker chip]  [adaptive signals]
```
All chips are color-coded: purple (bypass), blue (existing-route), red (risk blocker), amber (sell blocker).

**Line 3 — full reason:**
Full `final_reason` string. Word-wrap enabled. No ellipsis.

**Line 4 — starter detail (conditional):**
Only shown when `starter_into_existing_attempted = true`.
Green text if passed, dark amber if blocked.

### Recent Trades (blotter)
10-column table with sticky header and left-border row accents.

| Col | Data | Notes |
|---|---|---|
| Time | `executed_at` short format | dim |
| Coin | `t.coin` | bold |
| Side | `↑ BUY` / `↓ SELL` pill | green / amber pill |
| Gross | `t.gross_krw` | KRW spent / received |
| Fee | `t.fee_krw` | dim |
| Net | `t.net_krw` | blue for buys, green for sells |
| Qty | `t.coin_amount` | 8 decimals |
| Price | `t.price_krw` | dim |
| Regime | `t.entry_regime` as colored badge | |
| Reason | `REASON_LABELS[t.reason] \|\| t.reason` | now correctly populated from `entry_reason` fix |

Hover tooltip on Reason shows `order_id` if present.

### Bot Logs (secondary, after Recent Trades)
Darker background (`#060606`), all text tones much dimmer. Collapsed by default. Header shows `mode=live · auto-refresh 15s`. Auto-refreshes when open.

4-column monospace grid: `time | SEV | subsystem | message [· execDetail]`

---

## D. Exact Values Shown in Each Panel

### Telemetry Strip — sources

| Stat | Source | Trust |
|---|---|---|
| Tactical Positions | `v2Positions.filter(strategy_tag==='tactical').length` | DB read, fresh every 15s |
| Unrealized P&L | `(current_price - avg_cost) × qty_open` summed; only when all three fields present | snapshot enriched, ~5 min lag |
| Decision Rows | `diagLogs.length` (last 60 DECISION_CYCLE rows) | refreshes every 15s when open |
| Buys Blocked | `diagLogs.filter(buy_blocker != null).length` | same |
| Starter→Existing | count of `starter_into_existing_attempted=true` and `=passed` in diagLogs | same |
| Fills (30) | buy/sell count from last 30 `v2_fills` rows | from status fetch |
| Top Blocker | most frequent `buy_blocker` prefix across visible diagLogs | same |
| System | `status?.systemFrozen` | from status fetch |

### Decision Feed — values displayed per row

All values come from the phase 2 API expansion of `action=diagnostics`:
`symbol`, `regime`, `price`, `final_action`, `pnl_percent`, `rsi`, `bb_pctB`, `effective_bb_threshold`, `ob_imbalance`, `effective_ob_threshold`, `adaptive_signals`, `micro_bypassed`, `route_to_existing_position`, `risk_blocker`, `sell_blocker`, `final_reason`, `starter_into_existing_attempted`, `starter_into_existing_passed`, `starter_into_existing_blocker`, `starter_addon_size_mult_effective`, `existing_position_strategy_tag`

### Recent Trades — values displayed

All from the phase 2 `v2_fills` expansion: `coin`, `side`, `gross_krw`, `fee_krw`, `net_krw`, `coin_amount`, `price_krw`, `entry_regime`, `reason` (from `entry_reason`), `order_id` (tooltip)

---

## E. Remaining Limitations

**1. Telemetry strip unrealized P&L lags snapshot by ~5 minutes.**
`current_price_krw` comes from the portfolio snapshot written at cycle end, not a live market feed. The value is reliable but not real-time tick data.

**2. Tactical positions table has no manual refresh button.**
The V2 Engine section updates when `fetchV2Data()` runs (every 15s via auto-refresh). There is no per-section refresh button.

**3. Bot Logs section starts collapsed.**
The design intentionally makes it secondary. Users who want live logs open it; it then auto-refreshes. There is no visual indicator that new events arrived while collapsed.

**4. Decision Feed shows last 60 DECISION_CYCLE rows (3 coins × ~20 cycles), not filtered to a time window.**
No pagination. Old cycles fall off as new ones arrive. For deeper history, use the diagnostic-export button.

**5. Blotter has no sort or filter.**
Rows are ordered by `executed_at DESC` from the API. No client-side sort.

**6. Bot Logs CSS: `.ct__log-row` (old grid) still exists for backward compat.**
Phase 3 logs use `.ct__log-row-v3`. The old class is still in the CSS and used nowhere visible; safe to delete in a future cleanup pass.
