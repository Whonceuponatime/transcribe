# Manual Adoption of Live Exchange Holdings into `positions`

**Purpose:** One-time, safe adoption of existing BTC and ETH exchange balances into the `positions` table so the reconciliation engine clears its freeze.

---

## Context

| Signal | Detail |
|--------|--------|
| Freeze reason | `checkBalanceMatch` and `checkAdoptionComplete` fail: exchange holds assets, DB has zero active rows |
| Exchange quantities | BTC `0.00802427`, ETH `0.26414875` |
| Goal | Create exactly one `adopted` managed row per asset; do **not** clear freeze manually — let reconciliation clear it automatically once checks pass |

---

## Step 1 — Fetch live `avg_buy_price` from Upbit

Run this once in the bot's Node REPL or a throwaway script to get the current exchange-reported cost basis before inserting:

```js
// run from project root: node -e "require('./lib/upbit').getAccounts().then(a => console.log(JSON.stringify(a.filter(x => ['BTC','ETH'].includes(x.currency)), null, 2)))"
const upbit = require('./lib/upbit');
upbit.getAccounts().then(accounts => {
  for (const coin of ['BTC', 'ETH']) {
    const acc = accounts.find(a => a.currency === coin);
    console.log(`${coin}: qty=${Number(acc.balance)+Number(acc.locked)}  avg_buy_price=${acc.avg_buy_price}`);
  }
});
```

Note the two `avg_buy_price` values (in KRW). Substitute them for `<BTC_AVG_BUY_KRW>` and `<ETH_AVG_BUY_KRW>` in the SQL below.

---

## Step 2 — Insert adopted positions

Run **both statements in a single transaction** in the Supabase SQL editor (or via `psql`).

Replace the two placeholders before executing. **Do not run without real values.**

```sql
BEGIN;

-- ── 1. BTC adopted position ──────────────────────────────────────────────────
INSERT INTO positions (
  asset,
  strategy_tag,
  qty_open,
  qty_total,
  avg_cost_krw,
  state,
  origin,
  managed,
  supported_universe,
  adoption_timestamp,
  opened_at,
  created_at,
  updated_at
) VALUES (
  'BTC',
  'unassigned',            -- safe default; bot promotes to 'tactical' on first trade
  0.00802427,
  0.00802427,
  <BTC_AVG_BUY_KRW>,       -- ← paste numeric KRW value from Step 1 (e.g. 135000000.0000)
  'adopted',               -- CHECK: state IN ('open','closed','partial','adopted')
  'adopted_at_startup',    -- CHECK: origin IN ('bot_managed','adopted_at_startup')
  true,
  true,
  now(),                   -- REQUIRED by constraint positions_adopted_has_timestamp
  now(),
  now(),
  now()
);

-- ── 2. ETH adopted position ──────────────────────────────────────────────────
INSERT INTO positions (
  asset,
  strategy_tag,
  qty_open,
  qty_total,
  avg_cost_krw,
  state,
  origin,
  managed,
  supported_universe,
  adoption_timestamp,
  opened_at,
  created_at,
  updated_at
) VALUES (
  'ETH',
  'unassigned',
  0.26414875,
  0.26414875,
  <ETH_AVG_BUY_KRW>,       -- ← paste numeric KRW value from Step 1 (e.g. 5200000.0000)
  'adopted',
  'adopted_at_startup',
  true,
  true,
  now(),
  now(),
  now(),
  now()
);

-- ── 3. Adoption run record (required by checkAdoptionComplete) ───────────────
INSERT INTO adoption_runs (
  status,
  adopted_count,
  skipped_count,
  unsupported_count,
  adopted_assets,
  completed_at
) VALUES (
  'complete',
  2,
  0,
  0,
  '["BTC","ETH"]'::jsonb,
  now()
);

COMMIT;
```

---

## Step 3 — Verify before relying on reconciliation

```sql
-- Confirm two active adopted rows exist
SELECT position_id, asset, strategy_tag, state, origin,
       qty_open, avg_cost_krw, adoption_timestamp, managed
FROM positions
WHERE state IN ('open','adopted','partial')
ORDER BY asset;

-- Confirm adoption run recorded
SELECT id, status, adopted_count, adopted_assets, completed_at
FROM adoption_runs
ORDER BY run_at DESC
LIMIT 3;
```

Expected: 2 rows in positions (BTC + ETH, state = `adopted`, origin = `adopted_at_startup`), 1 complete adoption_run row.

---

## Step 4 — Let reconciliation clear the freeze automatically

**Do not call `clearFreeze` manually.**

On the next reconciliation cycle the engine will:

1. `checkAdoptionComplete` → **pass** (adoption_runs row with `status = 'complete'` now exists)
2. `checkNoUnresolvedOrders` → pass (no open orders)
3. `checkBalanceMatch` → **pass** (`qty_open` matches exchange within 0.5 % tolerance; `syncPositionsFromExchange` will also update `avg_cost_krw` from live exchange data on each tick)
4. `checkOwnershipClarity` → pass (`strategy_tag = 'unassigned'` is non-null)
5. `checkPositionIntegrity` → pass (`adoption_timestamp` is set, `managed = true`, `supported_universe = true`)

All checks green → engine calls `clearFreeze` and resumes trading.

---

## Field choice rationale

| Field | Value chosen | Why |
|-------|-------------|-----|
| `state` | `'adopted'` | Only valid non-bot state; reconciliation's `checkBalanceMatch` includes it |
| `origin` | `'adopted_at_startup'` | Required to describe manual/external origin; triggers adoption timestamp constraint |
| `strategy_tag` | `'unassigned'` | Safe default that satisfies `checkOwnershipClarity`; promoted by bot on first signal |
| `managed` | `true` | Bot must be able to manage the position; `getOpenPositions` filters `managed = true` |
| `supported_universe` | `true` | `checkPositionIntegrity` expects this for managed positions |
| `adoption_timestamp` | `now()` | **Mandatory** — constraint `positions_adopted_has_timestamp` rejects null when `origin = 'adopted_at_startup'` |
| `avg_cost_krw` | exchange `avg_buy_price` | `syncPositionsFromExchange` will keep refreshing it; seeding it correctly avoids PnL drift on first tick |

---

## Safety notes

- **One row per asset only.** The reconciliation balance check sums `qty_open` across all active rows for a given asset. Duplicate rows will cause a mismatch failure.
- **Do not set `state = 'open'` with `origin = 'adopted_at_startup'`** — `checkPositionIntegrity` may flag this as inconsistent.
- **Do not set `origin = 'bot_managed'` with a manual insert** — it implies the bot opened the position, which is false and will confuse PnL tracking.
- After adoption the bot's `promoteAdoptedPosition` logic (called on buy signals) will flip `state → 'open'` and `strategy_tag → 'tactical'` on the next trade, completing the lifecycle transition automatically.
