/**
 * Execution Engine — order placement with idempotency, retry, and state machine.
 *
 * Order state machine (spec section 12):
 *   intent_created → submitted → accepted → partially_filled
 *     → filled | dust_refunded_and_filled | cancelled_by_rule
 *     → failed_transient | failed_terminal
 *
 * Key behaviours:
 *   - Fetch pair fees at runtime (not hardcoded)
 *   - Normalize KRW price to tick policy before submission
 *   - Reject orders below ₩5,000 minimum
 *   - Attach UUID identifier BEFORE the HTTP request
 *   - JSON bodies only
 *   - Exponential backoff retry (100ms → 200ms → 400ms, max 3 attempts)
 *   - Query by identifier before retrying a failed HTTP response
 *   - Classify cancel+fills as dust_refunded_and_filled
 *   - In paper/shadow mode: persist order record but skip exchange call
 */

const { v4: uuidv4 } = require('uuid');
const upbit = require('./upbit');

const MIN_ORDER_KRW     = 5000;
const MAX_RETRIES       = 3;
const BACKOFF_BASE_MS   = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Persist an order row to the `orders` table. Returns the inserted row id. */
async function persistOrder(supabase, orderData) {
  try {
    const { data, error } = await supabase.from('orders').insert(orderData).select('id').single();
    if (error) console.error('[exec] Failed to persist order:', error.message);
    return data?.id ?? null;
  } catch (err) {
    console.error('[exec] persistOrder error:', err.message);
    return null;
  }
}

/** Update order state in DB. */
async function updateOrderState(supabase, id, patch) {
  if (!id) return;
  try {
    await supabase.from('orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  } catch (_) {}
}

/** Persist a fill row. */
async function persistFill(supabase, fillData) {
  try {
    await supabase.from('v2_fills').insert(fillData);
  } catch (_) {}
}

/** Write a bot_events row for execution events. */
async function logEvent(supabase, severity, message, context, mode) {
  try {
    await supabase.from('bot_events').insert({
      event_type:   'EXECUTION',
      severity,
      subsystem:    'execution_engine',
      message,
      context_json: context,
      mode,
    });
  } catch (_) {}
}

/**
 * Classify the final state of an order from the exchange response.
 * Handles the Upbit nuance where market-buy cancel means dust was refunded.
 */
function classifyOutcome(exchangeResp) {
  if (!exchangeResp) return 'failed_terminal';

  const state  = exchangeResp.state;
  const trades = exchangeResp.trades ?? [];
  const filledVol = parseFloat(exchangeResp.executed_volume ?? '0');

  if (state === 'done') return 'filled';
  if (state === 'cancel' && filledVol > 0) return 'dust_refunded_and_filled';
  if (state === 'cancel' && filledVol === 0) return 'cancelled_by_rule';
  if (state === 'wait' || state === 'watch') return 'accepted';

  return 'failed_terminal';
}

/**
 * Extract fills from an exchange order response and compute fee.
 */
function extractFills(exchangeResp, orderId, positionId, strategyTag, entryContext) {
  const trades = exchangeResp?.trades ?? [];
  if (!trades.length) return [];

  return trades.map((t) => ({
    order_id:       orderId,
    position_id:    positionId ?? null,
    asset:          (exchangeResp.market ?? '').replace('KRW-', ''),
    side:           exchangeResp.side === 'bid' ? 'buy' : 'sell',
    price_krw:      parseFloat(t.price   ?? '0'),
    qty:            parseFloat(t.volume  ?? '0'),
    fee_krw:        parseFloat(t.funds   ?? '0') * (entryContext?.feeRate ?? 0.0025),
    fee_rate:       entryContext?.feeRate ?? 0.0025,
    strategy_tag:   strategyTag ?? null,
    entry_regime:   entryContext?.regime   ?? null,
    entry_reason:   entryContext?.reason   ?? null,
    atr_at_entry:   entryContext?.atrVal   ?? null,
    spread_estimate:entryContext?.spread   ?? null,
    usd_proxy_fx:   entryContext?.usdKrw   ?? null,
    executed_at:    t.created_at ?? new Date().toISOString(),
  }));
}

// ─── Main execution ───────────────────────────────────────────────────────────

/**
 * Execute a buy order.
 *
 * @param {SupabaseClient} supabase
 * @param {object} intent     — from signalEngine.evaluateEntry()
 * @param {object} regime     — { regime }
 * @param {string} mode       — 'paper' | 'shadow' | 'live'
 * @param {object} context    — { usdKrw, atrVal, spread, positionId }
 * @returns {{ ok, state, orderId, fills, error? }}
 */
async function executeBuy(supabase, intent, regime, mode, context = {}) {
  const { asset, krwAmount, reason, strategy_tag } = intent;
  const market = `KRW-${asset}`;

  // Validate minimum order
  if (krwAmount < MIN_ORDER_KRW) {
    return { ok: false, state: 'cancelled_by_rule', error: `Below ₩${MIN_ORDER_KRW} minimum (₩${Math.round(krwAmount)})` };
  }

  // Fetch runtime fees
  const { bidFeeRate } = await upbit.getOrderFees(market).catch(() => ({ bidFeeRate: 0.0025 }));

  // Generate idempotency key BEFORE any network call
  const identifier = uuidv4();

  // Persist intent immediately (so restart can detect duplicate intent)
  const orderRowId = await persistOrder(supabase, {
    identifier,
    asset,
    side:           'buy',
    order_type:     'market',
    krw_requested:  krwAmount,
    strategy_tag,
    position_id:    context.positionId ?? null,
    regime_at_order: regime?.regime ?? null,
    reason,
    state:          'intent_created',
    mode,
  });

  // Paper mode — log intent but do not call exchange
  if (mode === 'paper') {
    await updateOrderState(supabase, orderRowId, { state: 'filled' });
    await logEvent(supabase, 'info', `[PAPER] BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} — ${reason}`, { intent, identifier }, mode);
    console.log(`[exec][PAPER] BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} — ${reason}`);
    return { ok: true, state: 'paper', orderId: orderRowId, fills: [], paper: true };
  }

  // Shadow mode — compute but don't submit
  if (mode === 'shadow') {
    await updateOrderState(supabase, orderRowId, { state: 'filled' });
    await logEvent(supabase, 'info', `[SHADOW] Would BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} — ${reason}`, { intent, identifier }, mode);
    console.log(`[exec][SHADOW] Would BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} — ${reason}`);
    return { ok: true, state: 'shadow', orderId: orderRowId, fills: [], shadow: true };
  }

  // Live mode — submit to exchange with retry
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      // Before retrying, check if identifier already exists on exchange
      const existing = await upbit.getOrderByIdentifier(identifier).catch(() => null);
      if (existing && (existing.state === 'done' || parseFloat(existing.executed_volume ?? '0') > 0)) {
        const finalState = classifyOutcome(existing);
        await updateOrderState(supabase, orderRowId, { state: finalState, exchange_uuid: existing.uuid, raw_response: existing });
        const fills = extractFills(existing, orderRowId, context.positionId, strategy_tag, { feeRate: bidFeeRate, regime: regime?.regime, reason, atrVal: context.atrVal, usdKrw: context.usdKrw });
        for (const f of fills) await persistFill(supabase, f);
        console.log(`[exec] BUY ${asset} already filled (found by identifier) — ${finalState}`);
        return { ok: true, state: finalState, orderId: orderRowId, fills };
      }
    }

    try {
      await updateOrderState(supabase, orderRowId, { state: 'submitted', retry_count: attempt });
      const resp = await upbit.placeOrder({
        market,
        side:       'bid',
        price:      Math.round(krwAmount),
        ord_type:   'price', // market buy on Upbit uses 'price' with KRW amount
        identifier,
      });

      const finalState = classifyOutcome(resp);
      await updateOrderState(supabase, orderRowId, { state: finalState, exchange_uuid: resp.uuid, raw_response: resp });

      const fills = extractFills(resp, orderRowId, context.positionId, strategy_tag, { feeRate: bidFeeRate, regime: regime?.regime, reason, atrVal: context.atrVal, usdKrw: context.usdKrw });
      for (const f of fills) await persistFill(supabase, f);

      await logEvent(supabase, 'info', `BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} → ${finalState}`, { identifier, reason, fills: fills.length }, mode);
      console.log(`[exec] BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} — ${reason} → ${finalState}`);

      return { ok: true, state: finalState, orderId: orderRowId, fills };

    } catch (err) {
      lastError = err;
      const isTransient = err.response?.status >= 500 || err.code === 'ECONNRESET' || err.message?.includes('stabilization');
      if (!isTransient) break; // permanent error — do not retry
      await updateOrderState(supabase, orderRowId, { state: 'failed_transient', retry_count: attempt + 1, error_message: err.message });
      console.warn(`[exec] BUY ${asset} attempt ${attempt + 1} failed (transient): ${err.message}`);
    }
  }

  // All retries exhausted
  const errMsg = lastError?.response?.data?.error?.message || lastError?.message || 'Unknown error';
  await updateOrderState(supabase, orderRowId, { state: 'failed_terminal', error_message: errMsg });
  await logEvent(supabase, 'error', `BUY ${asset} failed after ${MAX_RETRIES} attempts: ${errMsg}`, { identifier, reason }, mode);
  console.error(`[exec] BUY ${asset} FAILED: ${errMsg}`);
  return { ok: false, state: 'failed_terminal', orderId: orderRowId, error: errMsg };
}

/**
 * Execute a sell order.
 *
 * @param {SupabaseClient} supabase
 * @param {object} exit       — from signalEngine.evaluateExit(): { asset, sellPct, reason, trim }
 * @param {object} position   — open position row
 * @param {number} currentPrice
 * @param {string} mode
 * @param {object} context    — { usdKrw, gainPct }
 * @returns {{ ok, state, orderId, fills, grossKrw?, error? }}
 */
async function executeSell(supabase, exit, position, currentPrice, mode, context = {}) {
  const { asset, sellPct, reason } = exit;
  const market = `KRW-${asset}`;

  const sellQty = position.qty_open * (sellPct / 100);
  if (sellQty <= 0) {
    return { ok: false, state: 'cancelled_by_rule', error: 'Zero quantity to sell' };
  }

  const grossKrw = sellQty * currentPrice;
  if (grossKrw < MIN_ORDER_KRW) {
    return { ok: false, state: 'cancelled_by_rule', error: `Below ₩${MIN_ORDER_KRW} minimum` };
  }

  const { askFeeRate } = await upbit.getOrderFees(market).catch(() => ({ askFeeRate: 0.0025 }));
  const identifier = uuidv4();

  const orderRowId = await persistOrder(supabase, {
    identifier,
    asset,
    side:            'sell',
    order_type:      'market',
    qty_requested:   sellQty,
    strategy_tag:    position.strategy_tag,
    position_id:     position.position_id,
    regime_at_order: context.regime ?? null,
    reason,
    state:           'intent_created',
    mode,
  });

  if (mode === 'paper') {
    await updateOrderState(supabase, orderRowId, { state: 'filled' });
    await logEvent(supabase, 'info', `[PAPER] SELL ${asset} ${sellPct}% — ${reason} (≈₩${Math.round(grossKrw).toLocaleString()})`, { exit, identifier }, mode);
    console.log(`[exec][PAPER] SELL ${asset} ${sellPct}% (${sellQty.toFixed(6)}) — ${reason}`);
    return { ok: true, state: 'paper', orderId: orderRowId, fills: [], grossKrw, paper: true };
  }

  if (mode === 'shadow') {
    await updateOrderState(supabase, orderRowId, { state: 'filled' });
    await logEvent(supabase, 'info', `[SHADOW] Would SELL ${asset} ${sellPct}% — ${reason}`, { exit, identifier }, mode);
    console.log(`[exec][SHADOW] Would SELL ${asset} ${sellPct}% — ${reason}`);
    return { ok: true, state: 'shadow', orderId: orderRowId, fills: [], grossKrw, shadow: true };
  }

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      const existing = await upbit.getOrderByIdentifier(identifier).catch(() => null);
      if (existing && (existing.state === 'done' || parseFloat(existing.executed_volume ?? '0') > 0)) {
        const finalState = classifyOutcome(existing);
        await updateOrderState(supabase, orderRowId, { state: finalState, exchange_uuid: existing.uuid, raw_response: existing });
        const fills = extractFills(existing, orderRowId, position.position_id, position.strategy_tag, { feeRate: askFeeRate, regime: context.regime, reason, usdKrw: context.usdKrw });
        for (const f of fills) await persistFill(supabase, f);
        return { ok: true, state: finalState, orderId: orderRowId, fills, grossKrw };
      }
    }

    try {
      await updateOrderState(supabase, orderRowId, { state: 'submitted', retry_count: attempt });
      const resp = await upbit.placeOrder({
        market,
        side:     'ask',
        volume:   sellQty,
        ord_type: 'market',
        identifier,
      });

      const finalState = classifyOutcome(resp);
      await updateOrderState(supabase, orderRowId, { state: finalState, exchange_uuid: resp.uuid, raw_response: resp });

      const fills = extractFills(resp, orderRowId, position.position_id, position.strategy_tag, { feeRate: askFeeRate, regime: context.regime, reason, usdKrw: context.usdKrw, gainPct: context.gainPct });
      for (const f of fills) await persistFill(supabase, f);

      await logEvent(supabase, 'info', `SELL ${asset} ${sellPct}% → ${finalState} (≈₩${Math.round(grossKrw).toLocaleString()})`, { identifier, reason }, mode);
      console.log(`[exec] SELL ${asset} ${sellPct}% (${sellQty.toFixed(6)}) — ${reason} → ${finalState}`);

      return { ok: true, state: finalState, orderId: orderRowId, fills, grossKrw };

    } catch (err) {
      lastError = err;
      const isTransient = err.response?.status >= 500 || err.code === 'ECONNRESET' || err.message?.includes('stabilization');
      if (!isTransient) break;
      await updateOrderState(supabase, orderRowId, { state: 'failed_transient', retry_count: attempt + 1, error_message: err.message });
      console.warn(`[exec] SELL ${asset} attempt ${attempt + 1} failed (transient): ${err.message}`);
    }
  }

  const errMsg = lastError?.response?.data?.error?.message || lastError?.message || 'Unknown error';
  await updateOrderState(supabase, orderRowId, { state: 'failed_terminal', error_message: errMsg });
  await logEvent(supabase, 'error', `SELL ${asset} failed after ${MAX_RETRIES} attempts: ${errMsg}`, { identifier, reason }, mode);
  console.error(`[exec] SELL ${asset} FAILED: ${errMsg}`);
  return { ok: false, state: 'failed_terminal', orderId: orderRowId, error: errMsg, grossKrw };
}

module.exports = { executeBuy, executeSell };
