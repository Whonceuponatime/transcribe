# Runner Protection Patch

## A. Files / Functions Changed

| File | Change |
|------|--------|
| `lib/signalEngine.js` | New `getRunnerProtectDiagnostics()` + `runner_protect` exit block in `evaluateExit()` + export |
| `lib/cryptoTraderV2.js` | Call `getRunnerProtectDiagnostics`, add 5 fields to `sell_checks` and `EXIT_EVALUATION` |
| `lib/runtimeMetadata.js` | Add `runner_protect_fields` feature flag |
| `api/crypto-trader.js` | Surface 5 `runner_protect_*` fields in 3 sell_checks parsing locations |

---

## B. Exact Patch Diff (condensed)

### `lib/signalEngine.js` — new function before `evaluateExit`

```js
function getRunnerProtectDiagnostics(position, cfg, {
  netGainPct, firedTrims, exits, peakPrice, currentPrice, avgCost, feeRate
}) {
  // returns runner_protect_considered / blocker / peak_net_pct / would_fire / in_exits
  // Considered = false until trim1 + post_trim_runner both fired (tactical only)
  // Triggers when netGainPct < exit_runner_floor_net_pct (0.75%)
  //          OR (peakPrice - currentPrice) / peakPrice * 100 >= exit_runner_retrace_from_peak_pct (0.75%)
}
```

### `lib/signalEngine.js` — exit block inside `evaluateExit()` (after post_trim_runner, before runner trailing stop)

```js
// ── Runner protection ──────────────────────────────────────────────────────
const runnerProtectFired       = firedTrims.includes('runner_protect');
const runnerFloorNetPct        = cfg.exit_runner_floor_net_pct         ?? 0.75;
const runnerRetraceFromPeakPct = cfg.exit_runner_retrace_from_peak_pct ?? 0.75;
const runnerProtectSizePct     = cfg.exit_runner_protect_size_pct      ?? 12;

if (
  position.strategy_tag === 'tactical' &&
  firedTrims.includes('trim1') &&
  firedTrims.includes('post_trim_runner') &&
  !firedTrims.includes('runner') &&
  !runnerProtectFired
) {
  const belowFloor      = netGainPct < runnerFloorNetPct;
  const retraceFromPeak = peakPrice > 0
    ? ((peakPrice - currentPrice) / peakPrice) * 100
    : null;
  const retraceHit = retraceFromPeak != null && retraceFromPeak >= runnerRetraceFromPeakPct;
  if (belowFloor || retraceHit) {
    exits.push({ asset, side: 'sell', sellPct: runnerProtectSizePct,
      reason: `runner_protect_${triggerReason}`, trim: 'runner_protect' });
  }
}
```

### `lib/cryptoTraderV2.js` — diagnostic call added alongside existing diags

```js
const runnerProtectDiag = signalEngine.getRunnerProtectDiagnostics(position, cfg, {
  netGainPct,
  firedTrims,
  exits,
  peakPrice:    Math.max(peakPrice, ind.currentPrice),
  currentPrice: ind.currentPrice,
  avgCost:      Number(position.avg_cost_krw ?? 0),
  feeRate:      askFeeRate,
});
```

### `lib/cryptoTraderV2.js` — 5 fields added to `sell_checks` (DECISION_CYCLE) and `EXIT_EVALUATION`

```js
runner_protect_considered:   runnerProtectDiag.runner_protect_considered,
runner_protect_blocker:      runnerProtectDiag.runner_protect_blocker,
runner_protect_peak_net_pct: runnerProtectDiag.runner_protect_peak_net_pct,
runner_protect_would_fire:   runnerProtectDiag.runner_protect_would_fire,
runner_protect_fired:        exitFired && exits[0]?.trim === 'runner_protect',
```

### `lib/runtimeMetadata.js`

```js
runner_protect_fields:
  typeof se.getRunnerProtectDiagnostics === 'function' && v2.includes('runner_protect_considered'),
```

---

## C. Old Behavior

After `post_trim_runner` fired (partial exit of runner portion at 6h+), the remaining
position could sit indefinitely at `above_edge_no_exit_condition_met` with no further
exit trigger until either:
- The ATR trailing stop (runner) triggered — required price to fall 1.5× ATR from peak
- A manual sell

If the position was profitable but slowly eroding (e.g. net P&L drifting from 1.5% → 0.3%),
no automated exit would fire. The position would eventually cross below `minNet` (0.10%)
and become untouchable by profit-exit logic.

---

## D. New Runner Protection Behavior

After both `trim1` **and** `post_trim_runner` have fired, for **tactical positions only**,
a one-shot `runner_protect` sell fires if **either** condition is met:

| Condition | Config key | Default | Meaning |
|-----------|-----------|---------|---------|
| Net P&L floor breach | `exit_runner_floor_net_pct` | `0.75` | Net gain < 0.75% → protect |
| Price retrace from peak | `exit_runner_retrace_from_peak_pct` | `0.75` | Drop ≥ 0.75% from tracked peak → protect |

**Size:** `exit_runner_protect_size_pct` (default **12%** of remaining position).

**Guards:**
- `runner_protect` added to `fired_trims` after execution — fires exactly once
- Does not fire if `runner` (trailing stop) has already fired
- Does not fire if not tactical
- Net gate (`netGainPct >= minNet`) still applies — will not fire on an underwater position

**Execution order** inside `evaluateExit()`:
```
time_stop → [net gate] → reclaim_harvest → tactical_floor → harvest →
trim1 → trim2 → post_trim_runner → runner_protect (NEW) → runner (trailing stop)
```

**`peakNetPct`** in diagnostics = `((peakPrice - avgCost) / avgCost) * 100 - roundTrip`.
Uses the same `peakPrice` already tracked in `app_settings` per coin — no new state needed.

---

## E. SQL / Config

No migration is required — all three config keys have in-code defaults and gracefully fall
back to `null` when the column is absent from `bot_config`.

To tune values via the database:

```sql
-- Optional: add columns so values can be changed without redeploying
ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS exit_runner_floor_net_pct         numeric DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS exit_runner_retrace_from_peak_pct numeric DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS exit_runner_protect_size_pct      integer DEFAULT 12;

-- Set non-default values (example)
UPDATE bot_config SET
  exit_runner_floor_net_pct         = 0.60,
  exit_runner_retrace_from_peak_pct = 1.00,
  exit_runner_protect_size_pct      = 15
WHERE id = 1;
```

---

## F. Risks / Limitations

| Risk | Mitigation |
|------|-----------|
| Fires before significant recovery if profit dips briefly | One-shot guard (`runner_protect` in `fired_trims`) — only one slice is sold, not repeated |
| `peakPrice` from `app_settings` resets on restart | Existing behavior — peakPrice defaults to `ind.currentPrice` on first cycle; retrace condition won't fire on the first cycle after restart |
| Position must be `strategy_tag = tactical` | Core / unassigned positions are unaffected |
| Requires `post_trim_runner` to have fired | No risk of premature firing — gate is strict |
| Does not fire if `netGainPct < minNet (0.10%)` | Below min-net is handled by time_stop or operator action; this rule is for eroding-but-still-profitable positions only |
| Sell cooldown still applies | `runner_protect` is not on the `isProtectiveExit` bypass list — subject to 10-min sell cooldown like normal trims |
