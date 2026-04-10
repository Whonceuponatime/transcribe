# post_trim_runner — Real Runtime Patch

## What was added

`post_trim_runner` is a one-shot partial exit that fires after **both trim1 and trim2 have been confirmed** (i.e. the position is in its runner phase) and the trailing stop has not yet triggered. It prevents the runner from sitting indefinitely at a profit with no realisation.

---

## Files changed

### `lib/signalEngine.js`

**New function — `getPostTrimRunnerDiagnostics(position, cfg, { netGainPct, heldHours, firedTrims, exits })`**

Returns a diagnostic object with five keys:

| Key | Type | Meaning |
|-----|------|---------|
| `post_trim_runner_considered` | boolean | true once trim1+trim2 both fired |
| `post_trim_runner_blocker` | string\|null | why it didn't fire (null = would fire) |
| `post_trim_runner_would_fire` | boolean | true when all conditions met |
| `post_trim_runner_in_exits` | boolean | true when present in current exits array |

Possible blockers: `trim1_not_yet_fired`, `trim2_not_yet_fired`, `runner_already_fired`, `post_trim_runner_already_fired`, `pnl_unavailable`, `held_lt_Nh`.

**`evaluateExit()` addition**

Inserted before the runner trailing stop block:

```js
// fires once when trim1+trim2 fired, runner not yet fired, held >= exit_post_trim_runner_hours
if (firedTrims.includes('trim1') && firedTrims.includes('trim2')
    && !firedTrims.includes('runner') && !postTrimRunnerFired
    && heldHours >= postTrimRunnerHours) {
  exits.push({ ..., trim: 'post_trim_runner' });
}
```

Config keys (with defaults):
- `exit_post_trim_runner_hours` — default **6** h total held since entry
- `exit_post_trim_runner_size_pct` — default **33** % of remaining position

**Export added:** `getPostTrimRunnerDiagnostics`

---

### `lib/cryptoTraderV2.js`

- Calls `signalEngine.getPostTrimRunnerDiagnostics()` alongside the existing `reclaimDiag` / `tacticalFloorDiag` calls.
- Adds five fields to `sell_checks` (written to `DECISION_CYCLE`):
  - `post_trim_runner_considered`
  - `post_trim_runner_blocker`
  - `post_trim_runner_would_fire`
  - `post_trim_runner_in_exits`
  - `post_trim_runner_fired`
- Adds the same five fields to `EXIT_EVALUATION` `context_json`.

---

### `api/crypto-trader.js`

- DECISION_CYCLE diagnostics map (compact `/diagnostics` endpoint) — 5 fields added from `sc.*`
- Sell history / live status map — 5 fields added from `sc.*`
- EXIT_EVALUATION fallback sell_checks — 5 fields added from `cx.*` (Pi on old code path)
- EXIT_EVALUATION fallback top-level row — 5 fields added from `cx.*`

---

## Verification (run on Pi after deploy)

```bash
grep -n "post_trim_runner" lib/signalEngine.js
grep -n "post_trim_runner" lib/cryptoTraderV2.js
grep -n "post_trim_runner" api/crypto-trader.js
```

All three files must return matches.

`lib/runtimeMetadata.js` `getDiagnosticFeatureFlags()` will now return:

```json
{ "post_trim_runner_fields": true }
```

because `signalEngine.getPostTrimRunnerDiagnostics` is a function AND `cryptoTraderV2.js` contains `post_trim_runner_considered`.
