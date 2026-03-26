# BOT_AUDIT_BUNDLE.md
> Single-file review bundle for state-integrity audit.
> Generated: 2026-03-26. Engine: V2 live only. Exchange: Upbit. Pair universe: BTC, ETH, SOL (KRW).

---

## 1. REPO MAP

```
transcribe/
├── pi-trader/
│   └── index.js              ← scheduler: cron + setInterval, calls executeCycleV2()
├── lib/
│   ├── executionEngine.js    ← buy/sell order placement, poll, fill extraction
│   ├── cryptoTraderV2.js     ← main cycle: regime → signal → buy/sell → snapshot
│   ├── signalEngine.js       ← evaluateEntry(), evaluateStarterEntry(), evaluateExit()
│   ├── regimeEngine.js       ← BTC 4h EMA50/EMA200/ADX → UPTREND/RANGE/DOWNTREND
│   ├── adaptiveThresholds.js ← computes effectiveBbUptrend/Range, effectiveObMin
│   ├── reconciliationEngine.js ← resolveStuckOrders(), backfillOrphanedFills(),
│   │                             checkBalanceMatch(), checkPositionIntegrity(), freeze state
│   ├── riskEngine.js         ← allows(), loss streak, drawdown, exposure caps
│   ├── portfolioAdopter.js   ← runAdoption(), promoteAdoptedPosition()
│   ├── indicators.js         ← BB, RSI, MACD, ATR, EMA, ADX, relVol
│   └── upbit.js              ← placeOrder(), getOrderByIdentifier(), getAccounts()
├── api/
│   ├── crypto-trader.js      ← all dashboard API routes (?action=status|positions|adoption|…)
│   ├── live.js               ← consolidated live/* endpoints (quote, sync, signal, orders…)
│   └── ethernet.js           ← consolidated ethernet/* endpoints
├── client/src/components/
│   ├── CryptoTraderDashboard.js  ← main dashboard UI
│   └── LiveTradingDashboard.js   ← legacy (not wired to App.js for crypto)
└── supabase/
    ├── init_schema.sql       ← canonical schema (all migrations applied in order)
    └── migrations/           ← 033 files, 032=adaptive thresholds, 033=starter entry
```

**Runtime thresholds** are computed in `lib/adaptiveThresholds.js` inside `executeCycleV2()` only.
They are NOT persisted. They appear in `DECISION_CYCLE` bot_events `context_json.buy_checks` only.

---

## 2. CURRENT PROBLEM SUMMARY

- **Accepted buy freeze chain**: `executeBuy()` submits a market buy. Upbit frequently returns `state:'wait'` with `trades:[]`. The sell side has `pollForSettledOrder()` after placeOrder. The buy side did NOT — meaning fills returned empty, `applyFillToPosition` was skipped, position stayed at `qty_open=0, avg_cost_krw=0`, and the order stayed in state `'accepted'`. On next startup `checkNoUnresolvedOrders` saw the accepted order → freeze.

- **`resolveStuckOrders()` buy gap**: At startup, stuck buy orders were fetched and updated to `filled`, but the position was never updated. The original code had the comment "no position update needed" for buy orders — incorrect.

- **`backfillOrphanedFills()` buy gap**: This function only queried `side='sell'`. Buy orphans were permanently invisible to it.

- **Position-based idempotency bug (now fixed)**: Both repair paths used `qty_open > 0` as the guard for buy repairs. This is wrong for add-on scenarios where a subsequent buy filled normally and updated qty_open. The correct guard is order-level: check `v2_fills` count for that `order_id`.

- **ETH DB>exchange freeze**: The ETH `dust_refunded_and_filled` order had `executed_volume=0.00635997`. Our buy repair ran and wrote `qty_open=0.00635997` to the position. Exchange later showed 0 ETH (either Upbit refunded the dust amount or a subsequent sell was not captured). System froze on `balance_mismatch: ETH exchange=0 db=0.00635997`. Resolved manually by closing the position via SQL.

- **Zombie position**: `getOrCreatePosition()` creates a position row with `qty_open=0, avg_cost_krw=0, state='open'` BEFORE the order is placed. If the order returns no fills (wait response), this zombie persists. `checkPositionIntegrity()` previously did not flag zombie positions (now fixed — check `e` added).

- **Dust balance freeze**: `BALANCE_TOLERANCE_PCT = 0.005` (0.5%) is relative to exchange qty. When exchange qty is tiny (e.g. 0.00635997 ETH), the absolute tolerance is 0.000032 — smaller than the diff. Freeze fires. **Dust floor patch not yet shipped.**

- **Adaptive OB inversion bug**: `adaptiveThresholds.js` applies positive `obOffset` for inactivity/flat-portfolio, which makes `effectiveObMin` less negative (stricter). Intended to loosen. This is backwards — positive offset should move OB threshold more negative to allow more sell-heavy readings. **Not yet fixed.**

- **Dashboard does not show effective thresholds**: `entry_bb_pct_uptrend=0.900` is in bot_config but the runtime effective threshold (capped by `adaptive_bb_uptrend_max=0.850`) is never surfaced in the UI. Operator sees the base value only.

- **Adoption panel KRW is stale**: `adoption.krwBalance` comes from `adoption_status` app_settings key written at first adoption — months stale. Now labeled "at adoption time" in the UI.

- **`liveUnresolvedOrders` was invisible**: Count was returned in status API but never rendered in the dashboard header. Fixed — now shows `⚠ N UNRESOLVED ORDERS` badge.

- **No buy entries for 1000+ cycles**: Top blockers were BB %B (0.84–0.97 vs effective threshold 0.850 for UPTREND) and OB imbalance (-0.70 to -0.86 vs effective floor -0.700). `ob_imbalance_min` was -0.700, updated to -0.850 via DB to unblock starter entries.

- **Starter-entry uses raw cfg OB, not adaptive**: `evaluateStarterEntry()` uses `cfg.ob_imbalance_min` directly, not `effectiveThresholds.effectiveObMin`. Normal entries use the adaptive value (which with flat+inactive portfolio is -0.600 due to the inversion bug — tighter than raw). So starter is marginally better but still blocked by OB most cycles.

---

## 3. BUY LIFECYCLE CODE

### `lib/executionEngine.js`

#### `classifyOutcome()` — lines 99–112
```js
function classifyOutcome(exchangeResp) {
  if (!exchangeResp) return 'failed_terminal';
  const state     = exchangeResp.state;
  const filledVol = parseFloat(exchangeResp.executed_volume ?? '0');
  if (state === 'done')                             return 'filled';
  if (state === 'cancel' && filledVol > 0)          return 'dust_refunded_and_filled';
  if (state === 'cancel' && filledVol === 0)        return 'cancelled_by_rule';
  if (state === 'wait'   || state === 'watch')      return 'accepted';
  return 'failed_terminal';
}
```

#### `extractFills()` — lines 121–143
```js
function extractFills(exchangeResp, orderId, positionId, strategyTag, entryContext) {
  const trades = exchangeResp?.trades ?? [];
  if (!trades.length) return [];          // ← returns [] on wait/watch response
  return trades.map((t) => ({
    order_id:         orderId,
    position_id:      positionId ?? null,
    asset:            (exchangeResp.market ?? '').replace('KRW-', ''),
    side:             exchangeResp.side === 'bid' ? 'buy' : 'sell',
    price_krw:        parseFloat(t.price  ?? '0'),
    qty:              parseFloat(t.volume ?? '0'),
    fee_krw:          parseFloat(t.funds  ?? '0') * (entryContext?.feeRate ?? 0.0025),
    fee_rate:         entryContext?.feeRate ?? 0.0025,
    strategy_tag:     strategyTag ?? null,
    entry_regime:     entryContext?.regime   ?? null,
    entry_reason:     entryContext?.reason   ?? null,
    atr_at_entry:     entryContext?.atrVal   ?? null,
    usd_proxy_fx:     entryContext?.usdKrw   ?? null,
    upbit_trade_uuid: t.uuid ?? null,
    executed_at:      t.created_at ?? new Date().toISOString(),
  }));
}
```

#### `pollForSettledOrder()` — lines 155–170
```js
async function pollForSettledOrder(identifier, maxAttempts = 5, baseDelayMs = 500) {
  for (let p = 0; p < maxAttempts; p++) {
    await sleep(baseDelayMs * (p + 1));   // 500ms, 1000ms, 1500ms, 2000ms, 2500ms
    try {
      const polled = await upbit.getOrderByIdentifier(identifier);
      if (polled && (
        polled.state === 'done' ||
        polled.state === 'cancel' ||
        parseFloat(polled.executed_volume ?? '0') > 0
      )) {
        return polled;
      }
    } catch (_) {}
  }
  return null;   // timed out — caller must apply fallback
}
```
Returns the same shape as `placeOrder()` response. `extractFills` compatible — Upbit GET /v1/order includes `market`, `side`, `trades[]`.

#### `executeBuy()` — key block (lines 226–270, condensed) — SHIPPED FIX INCLUDED
```js
async function executeBuy(supabase, intent, regime, context = {}) {
  const { asset, krwAmount, reason, strategy_tag } = intent;
  const market    = `KRW-${asset}`;
  const identifier = uuidv4();

  const orderRowId = await persistOrder(supabase, {
    identifier, asset, side: 'buy', order_type: 'market',
    krw_requested: krwAmount, strategy_tag,
    position_id: context.positionId ?? null,
    regime_at_order: regime?.regime ?? null,
    reason, state: 'intent_created', mode: 'live',
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // ... retry idempotency check ...
    try {
      await updateOrderState(supabase, orderRowId, { state: 'submitted', retry_count: attempt });

      let resp = await upbit.placeOrder({   // ← let, not const (FIXED)
        market, side: 'bid', price: Math.round(krwAmount), ord_type: 'price', identifier,
      });

      // ── SHIPPED FIX: poll for settlement on wait response ──────────────
      if (resp.state === 'wait' || resp.state === 'watch') {
        console.log(`[exec] BUY ${asset} initial response state:${resp.state} — polling`);
        const settled = await pollForSettledOrder(identifier);
        if (settled) {
          resp = settled;
          console.log(`[exec] BUY ${asset} poll settled → state:${resp.state} executed_volume:${resp.executed_volume}`);
        } else {
          console.warn(`[exec] BUY ${asset} poll timed out — order may remain accepted`);
        }
      }

      const finalState = classifyOutcome(resp);
      await updateOrderState(supabase, orderRowId, { state: finalState, exchange_uuid: resp.uuid, raw_response: resp });

      const fills = extractFills(resp, orderRowId, context.positionId, strategy_tag,
        { feeRate: bidFeeRate, regime: regime?.regime, reason, atrVal: context.atrVal, usdKrw: context.usdKrw });
      for (const f of fills) await persistFill(supabase, f);

      return { ok: true, state: finalState, orderId: orderRowId, fills };
    } catch (err) { /* transient retry */ }
  }
  // retries exhausted → failed_terminal
}
```

#### `persistOrder()` — lines 32–41
```js
async function persistOrder(supabase, orderData) {
  const { data, error } = await supabase.from('orders').insert(orderData).select('id').single();
  if (error) console.error('[exec] Failed to persist order:', error.message);
  return data?.id ?? null;
}
```

#### `persistFill()` — lines 65–74 (idempotent via upbit_trade_uuid)
```js
async function persistFill(supabase, fillData) {
  const { error } = await supabase.from('v2_fills')
    .upsert(fillData, { onConflict: 'upbit_trade_uuid', ignoreDuplicates: true });
  if (error) console.error(`[exec] persistFill DB error:`, error.message);
}
```

---

## 4. RECONCILIATION CODE

### `lib/reconciliationEngine.js`

#### Constants
```js
const BALANCE_TOLERANCE_PCT = 0.005;  // 0.5% relative — binding constraint is this
// No absolute dust floor — PROPOSED but NOT YET SHIPPED
```

#### `checkNoUnresolvedOrders()` — lines 205–220
```js
async function checkNoUnresolvedOrders(supabase) {
  const { data, count } = await supabase.from('orders')
    .select('id, asset, identifier, state', { count: 'exact' })
    .in('state', ['submitted', 'accepted', 'partially_filled'])
    .limit(20);
  const found = count ?? (data?.length ?? 0);
  if (found > 0) {
    const ids = (data || []).map((o) => `${o.asset}:${o.state}`).join(', ');
    return { passed: false, reason: `unresolved_orders: ${found} order(s) in flight — ${ids}`, count: found };
  }
  return { passed: true, count: 0 };
}
```

#### `checkBalanceMatch()` — lines 228–300 (condensed)
```js
async function checkBalanceMatch(supabase, accounts, supportedCoins) {
  const exchangeQty = {};
  const dbQty       = {};

  for (const acc of accounts) {
    const classification = normalizeSymbol(acc.currency);
    if (classification.type === 'supported' && supportedCoins.includes(classification.symbol)) {
      exchangeQty[classification.symbol] = Number(acc.balance ?? 0) + Number(acc.locked ?? 0);
    }
  }

  // DB qty from positions table (open/adopted/partial)
  const { data: positions } = await supabase.from('positions')
    .select('asset, qty_open').in('state', ['open', 'adopted', 'partial']);
  for (const pos of (positions || [])) {
    dbQty[pos.asset] = (dbQty[pos.asset] ?? 0) + Number(pos.qty_open ?? 0);
  }

  for (const coin of supportedCoins) {
    const exQty  = exchangeQty[coin] ?? 0;
    const intQty = dbQty[coin]       ?? 0;

    if (exQty === 0 && intQty === 0) continue;

    // ← NO dust floor here — any mismatch beyond 0.5% freezes
    // DUST_FLOOR_QTY patch proposed but not yet shipped

    const diff   = Math.abs(exQty - intQty);
    const tolQty = exQty * BALANCE_TOLERANCE_PCT;

    if (diff > tolQty && diff > 0.000001) {
      discrepancies[coin] = { exchange_qty: exQty, db_qty: intQty,
        diff, diff_pct: exQty > 0 ? (diff / exQty * 100).toFixed(3) + '%' : 'n/a' };
    }
  }

  if (Object.keys(discrepancies).length > 0) {
    return { passed: false, reason: `balance_mismatch: ...`, discrepancies };
  }
  return { passed: true };
}
```
**Key gap**: when `exQty=0, intQty>0`, `diff_pct` = 'n/a' (division by zero). Still freezes because `diff > tolQty` (tolQty=0).

#### `checkPositionIntegrity()` — checks (a)–(e) — SHIPPED FIX INCLUDED
```js
// (a) adopted_at_startup without adoption_timestamp
// (b) adopted_at_startup with null strategy_tag
// (c) managed=true with null supported_universe
// (d) bot_managed with null/zero avg_cost_krw AND qty_open > 0
// (e) [SHIPPED] zombie: state=open, qty_open=0, avg_cost_krw=0, origin=bot_managed
if (pos.state === 'open'
    && Number(pos.qty_open ?? 0) === 0
    && (pos.avg_cost_krw == null || Number(pos.avg_cost_krw) <= 0)
    && pos.origin === 'bot_managed') {
  violations.push(`${pos.asset}(...): zombie position — state=open qty_open=0 avg_cost=0 (unfilled buy?)`);
}
```

#### Freeze / unfreeze state management
```js
let _frozenInMemory = true;   // starts frozen; cleared only after successful reconciliation
let _freezeReasons  = ['system_not_reconciled'];

async function setFreeze(supabase, reasons) {
  _frozenInMemory = true;
  _freezeReasons  = reasons;
  await supabase.from('app_settings').upsert({
    key: 'system_freeze', value: { frozen: true, reasons, updatedAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

async function clearFreeze(supabase) {
  _frozenInMemory = false;
  _freezeReasons  = [];
  await supabase.from('app_settings').upsert({
    key: 'system_freeze', value: { frozen: false, reasons: [], updatedAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
}

function isSystemFrozen() { return _frozenInMemory; }  // fast in-process check, every cycle
```

#### `resolveStuckOrders()` — startup, runs BEFORE reconciliation — SHIPPED FIX INCLUDED
```js
// Fetches orders in ['intent_created','submitted','accepted','partially_filled']
// Updates each to terminal state based on exchange response
// For SELLS: applies fill to position (reduce qty_open)
// For BUYS: [NOW FIXED] applies fill additively to position (add qty, weighted avg cost)

// Idempotency guard (order-level) — applies to both buy and sell:
const { count: existingFillCount } = await supabase.from('v2_fills')
  .select('id', { count: 'exact', head: true }).eq('order_id', order.id);
if (existingFillCount > 0) {
  resolved.push({ id: order.id, asset: order.asset, state: dbState, note: 'fills_already_recorded' });
  continue;
}

// BUY branch — SHIPPED FIX:
} else if (order.side === 'buy' && order.position_id && executedVol > 0
           && (dbState === 'filled' || dbState === 'dust_refunded_and_filled')) {

  const prevQty  = Number(pos.qty_open  ?? 0);
  const prevCost = Number(pos.avg_cost_krw ?? 0);
  const newQty   = prevQty + executedVol;              // additive — correct for add-ons
  const newCost  = newQty > 0
    ? (prevCost * prevQty + avgPrice * executedVol) / newQty
    : avgPrice;

  await supabase.from('positions').update({
    qty_open: newQty, qty_total: (Number(pos.qty_total ?? 0) + newQty),
    avg_cost_krw: newCost, updated_at: new Date().toISOString(),
  }).eq('position_id', order.position_id);
  // + fill inserts (with upbit_trade_uuid idempotency)
```

#### `backfillOrphanedFills()` — startup, runs after resolveStuckOrders — SHIPPED FIX INCLUDED
```js
// Finds terminal (filled/dust_refunded_and_filled) orders with NO v2_fills rows
// Previously: .eq('side', 'sell') — buy orphans invisible [FIXED — side filter removed]

// Order-level idempotency via toProcess filter:
const toProcess = [];
for (const order of orphaned) {
  const { count } = await supabase.from('v2_fills')
    .select('id', { count: 'exact', head: true }).eq('order_id', order.id);
  if ((count ?? 0) === 0) toProcess.push(order);
  else skipped.push({ ...reason: 'fills_already_exist' });
}

// BUY branch — SHIPPED FIX:
if (order.side === 'buy') {
  // No qty_open guard — order-level idempotency above is sufficient
  const prevQty  = Number(pos.qty_open  ?? 0);
  const prevCost = Number(pos.avg_cost_krw ?? 0);
  const newQty   = prevQty + executedVol;
  const newCost  = newQty > 0
    ? (prevCost * prevQty + avgPrice * executedVol) / newQty
    : avgPrice;
  // position update + fill insert
}
// SELL branch: unchanged original logic (subtract qty, compute PnL, close if qty≤0)
```

---

## 5. POSITION / FILL WRITE PATH

### `lib/cryptoTraderV2.js`

#### `getOrCreatePosition()` — lines 177–203
```js
async function getOrCreatePosition(supabase, asset, regime, reason, atrVal, usdKrw) {
  // Returns existing open tactical position if one exists
  const { data: existing } = await supabase.from('positions')
    .select('position_id').eq('asset', asset).eq('strategy_tag', 'tactical').eq('state', 'open')
    .order('opened_at', { ascending: false }).limit(1).single();
  if (existing) return existing.position_id;

  // Creates position BEFORE order is placed — starts at zero
  // ← If order returns wait/no fills, this position stays as zombie
  const { data: created } = await supabase.from('positions').insert({
    asset, strategy_tag: 'tactical',
    qty_open: 0, qty_total: 0, avg_cost_krw: 0,
    entry_regime: regime?.regime ?? null, entry_reason: reason ?? null,
    atr_at_entry: atrVal ?? null, usd_proxy_fx: usdKrw ?? null,
    state: 'open',
  }).select('position_id').single();
  return created?.position_id ?? null;
}
```

#### `applyFillToPosition()` — lines 136–175
```js
async function applyFillToPosition(supabase, positionId, fill) {
  const { data: pos } = await supabase.from('positions')
    .select('qty_open, qty_total, avg_cost_krw, strategy_tag')
    .eq('position_id', positionId).single();

  if (fill.side === 'buy') {
    const newQty  = (pos.qty_open ?? 0) + fill.qty;
    const newCost = ((pos.avg_cost_krw ?? 0) * (pos.qty_total ?? 0) + fill.price_krw * fill.qty)
                    / (newQty || 1);
    await supabase.from('positions').update({
      qty_open: newQty, qty_total: (pos.qty_total ?? 0) + fill.qty,
      avg_cost_krw: newCost, updated_at: new Date().toISOString(),
    }).eq('position_id', positionId);

  } else {  // sell
    const newQty = Math.max(0, (pos.qty_open ?? 0) - fill.qty);
    const pnl    = (fill.price_krw - (pos.avg_cost_krw ?? 0)) * fill.qty - (fill.fee_krw ?? 0);
    await supabase.from('positions').update({
      qty_open:     newQty,
      realized_pnl: ((pos.realized_pnl ?? 0) + pnl),
      state:        newQty <= 0 ? 'closed' : 'partial',
      closed_at:    newQty <= 0 ? new Date().toISOString() : null,
      updated_at:   new Date().toISOString(),
    }).eq('position_id', positionId);
  }
}
```

#### Buy cycle fill application — `executeCycleV2()` lines ~1088–1104
```js
const result = await execEngine.executeBuy(supabase, { ...activeIntent, krwAmount: effectiveKrw },
  regime, { usdKrw: usdtKrwRate, atrVal: ind.atrVal, positionId });

if (result.ok) {
  _lastBuyAt.set(coin, Date.now());
  for (const fill of (result.fills || [])) {       // ← if fills=[], loop skips entirely
    await applyFillToPosition(supabase, positionId, fill);
  }
  await riskEngine.recordEntry(supabase, { asset: coin, krwAmount: effectiveKrw });
}
// No buy-side FILL_FALLBACK_DIRECT (sell side has one — buys do not)
```

#### Sell FILL_FALLBACK_DIRECT — when sell returns ok=true but fills=[] — lines ~734–768
```js
if (!result.fills?.length) {
  const qtySold  = Number(position.qty_open) * (exit.sellPct / 100);
  const qtyAfter = Math.max(0, Number(position.qty_open) - qtySold);
  await supabase.from('positions').update({
    qty_open:   qtyAfter,
    state:      qtyAfter <= 0 ? 'closed' : 'partial',
    closed_at:  qtyAfter <= 0 ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq('position_id', position.position_id);
  // + FILL_FALLBACK_DIRECT bot_event
}
// ← No equivalent for buys. If buy poll times out, position stays at qty=0.
```

---

## 6. DASHBOARD / API SOURCE OF TRUTH

### `api/crypto-trader.js` — `?action=status` (live DB reads)

```js
// Sources (all read in one Promise.all):
supabase.from('bot_config').select('*').limit(1).single()         // active config
supabase.from('app_settings').select('value').eq('key','v2_portfolio_snapshot').single()  // stale snapshot
supabase.from('app_settings').select('value').eq('key','system_freeze').single()          // freeze state
supabase.from('app_settings').select('value').eq('key','current_regime').single()         // 4h-cached regime
supabase.from('positions').select('asset,qty_open,avg_cost_krw,...').in('state',[...])    // live DB qty
supabase.from('orders').select('id',{count:'exact',head:true}).in('state',[...])         // live unresolved count
supabase.from('v2_fills').select(...).limit(20)                                           // recent fills

// Returned:
{
  systemFrozen:          freeze.frozen,          // from app_settings.system_freeze (cached)
  liveUnresolvedOrders:  liveUnresolvedCount,    // live query on orders table — accurate
  tradingEnabled:        v2Cfg.trading_enabled,  // from bot_config — live
  krwBalance:            snap.krw_balance,       // from v2_portfolio_snapshot — UP TO 5MIN STALE
  totalValueKrw:         snap.nav_krw,           // stale snapshot
  positions: [{
    coin:          p.asset,
    balance:       Number(p.qty_open),           // DB qty, NOT exchange qty
    avgBuyKrw:     p.avg_cost_krw,
    currentPrice:  storedPrice ?? derived,       // from snapshot, NOT live exchange
  }],
  config: null,          // V1 retired — not returned
  // ← effectiveBbUptrend, effectiveObMin: NOT returned anywhere in API
}
```

### `api/crypto-trader.js` — `?action=adoption`
```js
{
  adoption:       adoptionRow.data?.value,    // app_settings.adoption_status — FROZEN AT ADOPTION TIME
  systemFreeze:   freezeRow.data?.value,      // same as status freeze — live
  tradingEnabled: !(freezeRow.data?.value?.frozen ?? true),
  // adoption.krwBalance → stale (labeled "at adoption time" in UI — SHIPPED FIX)
}
```

### `api/crypto-trader.js` — `?action=regime`
```js
{ regime: regimeData?.value }
// Source: app_settings.current_regime — written by regimeEngine.persistRegime()
// Cache TTL: 4 hours (in-process + persisted). Can be 4h stale.
```

### Dashboard: what is and is NOT shown

| Item | Source | Fresh? |
|---|---|---|
| Freeze state / badge | `app_settings.system_freeze` | ~seconds lag |
| Unresolved orders count | Live `orders` table query | Live ✓ |
| Coin card "Holdings" | `positions.qty_open` in DB | Live DB (may differ from exchange) |
| Coin card "Current Price" | `v2_portfolio_snapshot` | Up to 5 min stale |
| KRW balance | `v2_portfolio_snapshot.krw_balance` | Up to 5 min stale |
| Adoption panel KRW | `adoption_status.krwBalance` in `app_settings` | Frozen at first startup |
| Regime | `app_settings.current_regime` | Up to 4h stale |
| Effective BB threshold | **NOT SHOWN** | Not available in UI |
| Effective OB threshold | **NOT SHOWN** | Not available in UI |
| Adaptive offsets | **NOT SHOWN** | In DECISION_CYCLE bot_events only |

### Dashboard: `⚠ UNRESOLVED ORDERS` badge — SHIPPED FIX
```jsx
{!status?.systemFrozen && (status?.liveUnresolvedOrders ?? 0) > 0 && (
  <span className="ct__badge ct__badge--kill"
    title={`${status.liveUnresolvedOrders} order(s) in non-terminal state...`}>
    ⚠ {status.liveUnresolvedOrders} UNRESOLVED ORDER{status.liveUnresolvedOrders > 1 ? 'S' : ''}
  </span>
)}
```

---

## 7. ACTIVE SQL / SCHEMA REFERENCES

### `bot_config` (singleton — one row)
```sql
CREATE TABLE IF NOT EXISTS bot_config (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                     TEXT NOT NULL DEFAULT 'live',
  coins                    JSONB NOT NULL DEFAULT '["BTC","ETH","SOL"]',
  entry_bb_pct_uptrend     NUMERIC(5,3) NOT NULL DEFAULT 0.45,
  entry_rsi_min_uptrend    NUMERIC(5,2) NOT NULL DEFAULT 42,
  entry_rsi_max_uptrend    NUMERIC(5,2) NOT NULL DEFAULT 55,
  entry_bb_pct_range       NUMERIC(5,3) NOT NULL DEFAULT 0.30,
  entry_rsi_max_range      NUMERIC(5,2) NOT NULL DEFAULT 45,
  entry_bb_pct_downtrend   NUMERIC(5,3) NOT NULL DEFAULT 0.05,
  entry_rsi_max_downtrend  NUMERIC(5,2) NOT NULL DEFAULT 28,
  ob_imbalance_min         NUMERIC(5,3) NOT NULL DEFAULT -0.45,
  exit_quick_trim1_gross_pct NUMERIC(6,3) DEFAULT 0.85,
  exit_quick_trim2_gross_pct NUMERIC(6,3) DEFAULT 1.25,
  exit_safety_buffer_pct     NUMERIC(6,3) DEFAULT 0.10,
  addon_min_dip_pct          NUMERIC(6,3) DEFAULT 1.0,
  addon_size_mult            NUMERIC(5,3) DEFAULT 0.5,
  buy_cooldown_ms            INTEGER      DEFAULT 1800000,
  sell_cooldown_ms           INTEGER      DEFAULT 600000,
  trading_enabled  BOOLEAN NOT NULL DEFAULT true,
  buys_enabled     BOOLEAN NOT NULL DEFAULT true,
  sells_enabled    BOOLEAN NOT NULL DEFAULT true,
  -- Adaptive thresholds (migration 032)
  adaptive_thresholds_enabled BOOLEAN NOT NULL DEFAULT true,
  adaptive_bb_uptrend_max  NUMERIC(5,3) NOT NULL DEFAULT 0.60,
  adaptive_bb_range_max    NUMERIC(5,3) NOT NULL DEFAULT 0.50,
  adaptive_ob_floor        NUMERIC(5,3) NOT NULL DEFAULT -0.70,
  adaptive_ob_ceil         NUMERIC(5,3) NOT NULL DEFAULT -0.15,
  -- Starter entry (migration 033)
  starter_entry_enabled    BOOLEAN      NOT NULL DEFAULT true,
  starter_size_mult        NUMERIC(5,3) NOT NULL DEFAULT 0.25,
  starter_rsi_max          NUMERIC(5,2) NOT NULL DEFAULT 70,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bot_config_singleton ON bot_config ((true));
```

### `positions`
```sql
CREATE TABLE IF NOT EXISTS positions (
  position_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset           TEXT NOT NULL,
  strategy_tag    TEXT NOT NULL DEFAULT 'unassigned'
                    CHECK (strategy_tag IN ('core','tactical','unassigned')),
  qty_open        NUMERIC(24,10) NOT NULL DEFAULT 0,
  qty_total       NUMERIC(24,10) NOT NULL DEFAULT 0,
  avg_cost_krw    NUMERIC(20,4)  NOT NULL DEFAULT 0,
  realized_pnl    NUMERIC(20,4)  NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open','closed','partial','adopted')),
  origin          TEXT NOT NULL DEFAULT 'bot_managed'
                    CHECK (origin IN ('bot_managed','adopted_at_startup')),
  managed         BOOLEAN NOT NULL DEFAULT true,
  fired_trims     TEXT[],   -- tracks which trim levels have fired (trim1/trim2/regime_break)
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  operator_note   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `orders`
```sql
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier      UUID NOT NULL UNIQUE,   -- client-generated UUID for idempotency
  exchange_uuid   TEXT,                   -- Upbit's order UUID (returned after placement)
  asset           TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  position_id     UUID REFERENCES positions(position_id),
  state           TEXT NOT NULL DEFAULT 'intent_created' CHECK (state IN (
    'intent_created','submitted','accepted','partially_filled',
    'filled','dust_refunded_and_filled','cancelled_by_rule',
    'failed_transient','failed_terminal'
  )),
  raw_response    JSONB,
  mode            TEXT NOT NULL DEFAULT 'paper',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `v2_fills`
```sql
CREATE TABLE IF NOT EXISTS v2_fills (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id),
  position_id      UUID REFERENCES positions(position_id),
  asset            TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price_krw        NUMERIC(20,4)  NOT NULL,
  qty              NUMERIC(24,10) NOT NULL,
  fee_krw          NUMERIC(20,4)  NOT NULL DEFAULT 0,
  upbit_trade_uuid TEXT,   -- NULL for synthetic fills
  executed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Unique index prevents duplicate real fills:
CREATE UNIQUE INDEX idx_v2_fills_upbit_trade_uuid
  ON v2_fills(upbit_trade_uuid) WHERE upbit_trade_uuid IS NOT NULL;
-- Prevents duplicate synthetic fills:
CREATE UNIQUE INDEX idx_v2_fills_synthetic_order
  ON v2_fills(order_id) WHERE upbit_trade_uuid IS NULL;
```

### `bot_events` — key event_types
```
DECISION_CYCLE         — one per coin per cycle, buy_checks + sell_checks in context_json
DECISION_EMIT_ATTEMPT  — proof cycle reached decision write path
EXECUTION              — every buy/sell order attempt
STUCK_ORDER_RESOLVED   — resolveStuckOrders() applied a fill
ORPHANED_FILL_BACKFILLED — backfillOrphanedFills() applied a fill
REGIME_SWITCH          — regime changed
FREEZE_STATE_CHANGED   — system froze or unfroze
RECONCILIATION         — result of each reconciliation run
CYCLE_FROZEN           — cycle skipped because system frozen
EXIT_EVALUATION        — sell evaluation for every managed position (30min throttle)
POSITION_CLASSIFIED    — operator classified an adopted position
```

### `reconciliation_checks`
```sql
CREATE TABLE IF NOT EXISTS reconciliation_checks (
  id                UUID PRIMARY KEY,
  status            TEXT CHECK (status IN ('pending','passed','frozen','failed')),
  freeze_reasons    JSONB NOT NULL DEFAULT '[]',
  exchange_balances JSONB,   -- raw Upbit balances at time of run
  internal_balances JSONB,   -- positions table snapshot at time of run
  discrepancies     JSONB,   -- per-coin diff details
  open_orders_found INTEGER  NOT NULL DEFAULT 0,
  checks_run        JSONB,   -- all 5 check results
  trading_enabled   BOOLEAN  NOT NULL DEFAULT false,
  run_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 8. CURRENT LIVE CONFIG SNAPSHOT

Active row ID: `cd8b5fea-4c43-4642-8b63-d1c3a95dc5ab`

| Field | Value | Notes |
|---|---|---|
| `entry_bb_pct_uptrend` | 0.900 | Base. Effective is capped at 0.850 by adaptive_bb_uptrend_max |
| `entry_rsi_min_uptrend` | 42 | |
| `entry_rsi_max_uptrend` | 55 | |
| `entry_bb_pct_range` | 0.900 | Base. Effective capped at 0.750 by adaptive_bb_range_max |
| `entry_rsi_max_range` | 55 | |
| `ob_imbalance_min` | **-0.850** | Updated from -0.700 to unblock starter entries |
| `exit_quick_trim1_gross_pct` | 0.85 | 25% sold at +0.85% gross |
| `exit_quick_trim2_gross_pct` | 1.25 | 25% sold at +1.25% gross |
| `exit_safety_buffer_pct` | 0.10 | Net must exceed fees + 0.10% |
| `exit_time_stop_hours` | 30 | Flat position after 30h → partial exit |
| `addon_min_dip_pct` | 1.0 | Add-on requires 1% below avg_cost |
| `addon_size_mult` | 0.5 | Add-on = 50% of normal signal budget |
| `buy_cooldown_ms` | 1800000 | 30 min between buys per asset |
| `sell_cooldown_ms` | 600000 | 10 min between sells per asset |
| `adaptive_thresholds_enabled` | true | |
| `adaptive_bb_uptrend_max` | 0.850 | Hard cap on effectiveBbUptrend (base 0.900 → capped 0.850) |
| `adaptive_bb_range_max` | 0.750 | Hard cap on effectiveBbRange |
| `adaptive_ob_floor` | -0.70 | Most negative effective OB min allowed — equals base, so adaptive loosening is blocked |
| `adaptive_ob_ceil` | -0.15 | Least negative allowed |
| `starter_entry_enabled` | true | |
| `starter_size_mult` | 0.25 | 25% of normal uptrend budget |
| `starter_rsi_max` | 70 | |

**Effective runtime thresholds (computed in lib/adaptiveThresholds.js per cycle, NOT persisted):**

With flat portfolio + 24h inactive (`bbOffset=+0.10, obOffset=+0.10`):
- `effectiveBbUptrend = clamp(0.900 + 0.10, 0.20, 0.850) = 0.850` (capped by max)
- `effectiveBbRange   = clamp(0.900 + 0.10, 0.10, 0.750) = 0.750` (capped by max)
- `effectiveObMin     = clamp(-0.850 + 0.10, -0.70, -0.15) = -0.70` (capped by floor)

**Note**: The adaptive OB offset is inverted. Inactivity/flat adds +0.10, making OB threshold less negative (-0.750 → clamped to -0.70). Intended to loosen (allow more negative readings), but does the opposite. The positive offset should be subtracted for OB (unlike BB where positive = looser). This bug is unshipped.

---

## 9. CURRENT KNOWN BAD ROW EXAMPLES

### Stuck accepted buy order (representative)
```
orders table:
id: <uuid>
asset: BTC
side: buy
state: accepted              ← stuck — was 'wait' from placeOrder
identifier: <uuid>
exchange_uuid: <upbit-uuid>  ← exchange received it, exchange state may be 'done'
position_id: <uuid>          ← position exists with qty_open=0
krw_requested: 25000
created_at: 2026-03-25T...
updated_at: 2026-03-25T...   ← same as created_at (never polled/settled)

→ v2_fills: 0 rows for this order_id
→ positions row: qty_open=0, avg_cost_krw=0, state=open  (zombie)
→ reconciliation: freeze on unresolved_orders + balance_mismatch
```

### Filled dust_refunded_and_filled buy (representative — the ETH case)
```
orders table:
id: <uuid>
asset: ETH
side: buy
state: dust_refunded_and_filled
exchange_uuid: <upbit-uuid>
position_id: fa465937-5f41-448b-a8ed-d1086b5eb3fd
qty_requested: null
krw_requested: ~25000

→ v2_fills: 0 rows initially (poll timed out or fills=[])
→ positions row: qty_open=0.00635997 (after repair), state=open
→ exchange: 0 ETH (refunded by Upbit or consumed by subsequent sell with no fill record)
→ reconciliation: freeze on balance_mismatch (ETH exchange=0, db=0.00635997)
→ Resolution: manual UPDATE to close position, then reconcile
```

### Bad position row — zombie (before zombie check was added)
```
positions table:
position_id: <uuid>
asset: SOL
strategy_tag: tactical
qty_open: 0.0000000000       ← zero
avg_cost_krw: 0              ← zero
state: open                  ← open
origin: bot_managed
opened_at: 2026-03-24T...
updated_at: 2026-03-24T...

→ Not flagged by old checkPositionIntegrity (check d only caught qty>0 with no cost)
→ Now flagged by check (e): zombie position → position_integrity_violation → freeze
→ Also: checkBalanceMatch sees dbQty[SOL]=0, exchange might have SOL from a filled order
   that took a different code path
```

### Reconciliation freeze reason (representative)
```json
{
  "freeze_reasons": [
    "unresolved_orders: 2 order(s) in flight — BTC:accepted, SOL:accepted",
    "balance_mismatch: BTC: exchange=0.00019306 db=0 diff=100.000%, SOL: exchange=0.14981604 db=0 diff=100.000%"
  ],
  "checks_run": {
    "adoption_complete":    { "passed": true },
    "no_unresolved_orders": { "passed": false, "count": 2 },
    "balance_match":        { "passed": false, "discrepancies": { "BTC": {...}, "SOL": {...} } },
    "ownership_clarity":    { "passed": true },
    "position_integrity":   { "passed": false, "violations": ["BTC(...): zombie position..."] }
  }
}
```

### DECISION_CYCLE buy_checks (representative blocked cycle)
```json
{
  "buys_enabled": true,
  "signal_met": false,
  "starter_met": false,
  "final_buy_eligible": false,
  "bb_pctB": 0.921,
  "base_bb_threshold": 0.900,
  "effective_bb_threshold": 0.850,
  "bb_ok": false,
  "ob_imbalance": -0.742,
  "base_ob_imbalance_min": -0.850,
  "effective_ob_imbalance_min": -0.700,
  "adaptive_offsets_applied": {
    "bb": 0.10,
    "ob": 0.10,
    "signals": ["inactive_24h", "flat_portfolio"]
  },
  "regime_allows_buy": true,
  "existing_position": false,
  "starter_enabled": true
}
// final_reason: "buy_blocked:signal_not_met:ob_imbalance=-0.74 < -0.70"
// Note: effectiveObMin=-0.70 is the floor, not the loosened value.
// OB inversion bug: positive offset makes threshold less negative (tighter), not looser.
```

---

## 10. DIFFS — SHIPPED / PROPOSED / NOT SHIPPED

### SHIPPED: Buy settlement poll (`lib/executionEngine.js` `executeBuy()`)
```diff
-     const resp = await upbit.placeOrder({ ... });
+     let resp = await upbit.placeOrder({ ... });
+
+     if (resp.state === 'wait' || resp.state === 'watch') {
+       console.log(`[exec] BUY ${asset} initial response state:${resp.state} — polling`);
+       const settled = await pollForSettledOrder(identifier);
+       if (settled) {
+         resp = settled;
+         console.log(`[exec] BUY ${asset} poll settled → state:${resp.state}`);
+       } else {
+         console.warn(`[exec] BUY ${asset} poll timed out — may remain accepted`);
+       }
+     }

      const finalState = classifyOutcome(resp);
```

### SHIPPED: resolveStuckOrders buy position repair (`lib/reconciliationEngine.js`)
```diff
-       } else {
-         // Buy orders or cancelled sells — just record the state update
-         console.log(`... (no position update needed)`);
-         resolved.push({ ... });
-       }
+       } else if (order.side === 'buy' && order.position_id && executedVol > 0
+                  && (dbState === 'filled' || dbState === 'dust_refunded_and_filled')) {
+         const prevQty  = Number(pos.qty_open  ?? 0);
+         const prevCost = Number(pos.avg_cost_krw ?? 0);
+         const newQty   = prevQty + executedVol;
+         const newCost  = newQty > 0
+           ? (prevCost * prevQty + avgPrice * executedVol) / newQty
+           : avgPrice;
+         await supabase.from('positions').update({
+           qty_open: newQty, qty_total: (Number(pos.qty_total ?? 0) + newQty),
+           avg_cost_krw: newCost, updated_at: new Date().toISOString(),
+         }).eq('position_id', order.position_id);
+         // + fill records inserted (idempotent via upbit_trade_uuid)
+       } else {
+         // Cancelled buys (executedVol=0) or no position_id
+         resolved.push({ ... });
+       }
```

### SHIPPED: backfillOrphanedFills extended to buys (`lib/reconciliationEngine.js`)
```diff
-   .eq('side', 'sell')   // ← removed — buys now included
+   // no side filter
+
+   if (order.side === 'buy') {
+     // Order-level idempotency: count===0 filter above already guarantees no fills exist
+     const prevQty = Number(pos.qty_open ?? 0);
+     const newQty  = prevQty + executedVol;
+     const newCost = newQty > 0
+       ? (prevCost * prevQty + avgPrice * executedVol) / newQty
+       : avgPrice;
+     // position update (additive) + fill insert
+   } else {
+     // Original sell logic unchanged
+   }
```

### SHIPPED: checkPositionIntegrity zombie check (`lib/reconciliationEngine.js`)
```diff
+     // (e) zombie position
+     if (pos.state === 'open'
+         && Number(pos.qty_open ?? 0) === 0
+         && (pos.avg_cost_krw == null || Number(pos.avg_cost_krw) <= 0)
+         && pos.origin === 'bot_managed') {
+       violations.push(`${pos.asset}(...): zombie position — state=open qty_open=0 avg_cost=0`);
+     }
```

### SHIPPED: Dashboard unresolved orders badge (`CryptoTraderDashboard.js`)
```diff
+   {!status?.systemFrozen && (status?.liveUnresolvedOrders ?? 0) > 0 && (
+     <span className="ct__badge ct__badge--kill" title="...">
+       ⚠ {status.liveUnresolvedOrders} UNRESOLVED ORDER{...}
+     </span>
+   )}
```

### SHIPPED: Adoption panel KRW relabeled (`CryptoTraderDashboard.js`)
```diff
-   <span style={{ color: '#555' }}>— execution cash</span>
+   <span style={{ color: '#777' }}>— at adoption time (not current)</span>
```

### SHIPPED: DB config change — `ob_imbalance_min` updated
```sql
UPDATE bot_config SET ob_imbalance_min = -0.85 WHERE id = 'cd8b5fea-...';
-- Was -0.700. Changed to -0.850 to unblock starter entries.
-- Starter uses raw cfg value (not adaptive), so this directly allows OB down to -0.85.
-- Normal entries: adaptive floor still caps at -0.70, marginal improvement only.
```

### PROPOSED NOT SHIPPED: Dust floor in `checkBalanceMatch()` (`lib/reconciliationEngine.js`)
```diff
+const DUST_FLOOR_QTY = { BTC: 0.0001, ETH: 0.005, SOL: 0.05 };
+
 for (const coin of supportedCoins) {
   const exQty  = exchangeQty[coin] ?? 0;
   const intQty = dbQty[coin]       ?? 0;
   if (exQty === 0 && intQty === 0) continue;
+
+  // Tiny exchange residual with zero DB qty → dust, not a real mismatch
+  if (exQty > 0 && exQty < (DUST_FLOOR_QTY[coin] ?? 0) && intQty === 0) {
+    console.log(`[reconcile] dust_skip: ${coin} exQty=${exQty} < floor`);
+    continue;
+  }
+
   const diff   = Math.abs(exQty - intQty);
```

### PROPOSED NOT SHIPPED: Adaptive OB inversion fix (`lib/adaptiveThresholds.js`)
```diff
-  const effectiveObMin = clamp(baseObMin + obOffset, OB_FLOOR, OB_CEIL);
+  // OB offset is negated: positive loosening offsets move threshold MORE negative
+  // (allowing more negative readings). Opposite sign from BB %B.
+  const effectiveObMin = clamp(baseObMin - obOffset, OB_FLOOR, OB_CEIL);
```
**Note**: Requires `adaptive_ob_floor` to be lowered to e.g. -0.90 for the fix to have any effect (current floor -0.70 still caps the result).

---

## 11. OPEN QUESTIONS

- **Zombie position + new buy**: `getOrCreatePosition()` re-uses an existing open tactical position by asset name. If a zombie exists (qty=0, state=open), a new buy signal for the same asset will reuse this position. After the poll fix, fills should now be applied. But if the zombie is from a much earlier failed buy, the `opened_at` timestamp is wrong (it reflects when the original zombie was created, not when the real position was opened). Should `getOrCreatePosition` skip positions with qty_open=0 and create a fresh one instead?

- **No buy-side FILL_FALLBACK_DIRECT**: The sell cycle has an explicit fallback that estimates qty reduction when fills are empty. Buys have no equivalent. If `executeBuy` poll times out (5 attempts, 7.5s), the order is still in `accepted` state. On next startup, `resolveStuckOrders` repairs it. But between the buy cycle and next startup, the position is at qty=0 and the bot may try to re-buy the same asset (cooldown resets on restart). Is this acceptable?

- **`dust_refunded_and_filled` → phantom position risk**: The ETH case showed our repair can create a live position for an order where the ETH was refunded by Upbit (net ETH in account = 0). The `DUST_FLOOR_QTY` patch addresses the downstream freeze but does not prevent the position from being created. Should `backfillOrphanedFills` and `resolveStuckOrders` verify live exchange balance before applying a buy repair?

- **Adaptive OB inversion (unshipped)**: Once the fix is applied and `adaptive_ob_floor` is loosened to -0.90, inactivity offsets will make `effectiveObMin` more negative (e.g. -0.950 clamped to -0.900). OB readings of -0.85 would now pass. This is a meaningful loosening. Needs monitoring for false entries in sell-heavy markets.

- **BB %B still too tight for current market**: With BB %B at 0.84–0.97 and effective threshold at 0.850, only fleeting dips to 0.84–0.849 qualify for normal entry. `adaptive_bb_uptrend_max=0.850` is the hard cap. Raising it to e.g. 0.920 would allow BB up to 0.919. This is a risk: market in the upper Bollinger band is overbought. Needs explicit decision.

- **Dashboard exchange balance gap**: No panel shows live Upbit account balances. When a mismatch exists, the operator sees DB-derived values (which may show zero for a coin the exchange actually holds). The only way to see the real exchange state is to check `reconciliation_checks.exchange_balances` in the DB or run a manual Upbit API check.

- **`resolveStuckOrders` qty_total update formula**: The buy repair does `qty_total: Number(pos.qty_total ?? 0) + newQty` where `newQty = prevQty + executedVol`. This double-counts `prevQty` in `qty_total`. Should be `qty_total: Number(pos.qty_total ?? 0) + executedVol` only. Low-impact (qty_total is informational) but incorrect.

- **`isFullyProtected()` and exit logic**: Adopted positions with `strategy_tag=unassigned` are fully excluded from exit logic. If an adopted position is never classified by the operator, the bot will never sell it — even if it's deeply underwater. There is no timeout or escalation path for unclassified adopted positions.
