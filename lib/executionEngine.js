/**
 * Execution Engine — live order placement with idempotency, retry, and state machine.
 *
 * This engine is LIVE-ONLY. Paper and shadow modes have been removed.
 * Every call to executeBuy/executeSell submits a real order to Upbit.
 *
 * Order state machine:
 *   intent_created → submitted → accepted → partially_filled
 *     → filled | dust_refunded_and_filled | cancelled_by_rule
 *     → failed_transient | failed_terminal
 *
 * Every EXECUTION bot_event includes:
 *   engine           = 'V2'
 *   execution_mode   = 'live'
 *   account_mutating = true (order was submitted) | false (blocked before submission)
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

/** Write a bot_events EXECUTION row. Always live — no paper/shadow flags. */
async function logEvent(supabase, severity, message, context, accountMutating = true) {
  try {
    await supabase.from('bot_events').insert({
      event_type:   'EXECUTION',
      severity,
      subsystem:    'execution_engine',
      message,
      context_json: {
        ...context,
        engine:           'V2',
        execution_mode:   'live',
        account_mutating: accountMutating,
      },
      mode: 'live',
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

/**
 * Poll an order by identifier until it reaches a terminal state (done/cancel)
 * or until maxAttempts is exhausted.
 *
 * Upbit market orders frequently return state:'wait' on the immediate placeOrder
 * response — even when execution is near-instant. Without polling, trades[] is
 * always empty, extractFills returns [], and positions.qty_open is never reduced.
 *
 * Returns the settled response, or null if the order never settled in time.
 */
async function pollForSettledOrder(identifier, maxAttempts = 5, baseDelayMs = 500) {
  for (let p = 0; p < maxAttempts; p++) {
    await sleep(baseDelayMs * (p + 1)); // 500ms, 1000ms, 1500ms, 2000ms, 2500ms
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
  return null; // timed out — caller must apply fallback
}

// ─── Main execution ───────────────────────────────────────────────────────────

/**
 * Execute a live buy order on Upbit.
 * This function always submits a real order. Paper/shadow modes are removed.
 *
 * @param {SupabaseClient} supabase
 * @param {object} intent   — { asset, krwAmount, reason, strategy_tag }
 * @param {object} regime   — { regime }
 * @param {object} context  — { usdKrw, atrVal, positionId }
 * @returns {{ ok, state, orderId, fills, error? }}
 */
async function executeBuy(supabase, intent, regime, context = {}) {
  const { asset, krwAmount, reason, strategy_tag } = intent;
  const market = `KRW-${asset}`;

  if (krwAmount < MIN_ORDER_KRW) {
    return { ok: false, state: 'cancelled_by_rule', error: `Below ₩${MIN_ORDER_KRW} minimum (₩${Math.round(krwAmount)})` };
  }

  const { bidFeeRate } = await upbit.getOrderFees(market).catch(() => ({ bidFeeRate: 0.0025 }));
  const identifier     = uuidv4();

  const orderRowId = await persistOrder(supabase, {
    identifier,
    asset,
    side:            'buy',
    order_type:      'market',
    krw_requested:   krwAmount,
    strategy_tag,
    position_id:     context.positionId ?? null,
    regime_at_order: regime?.regime ?? null,
    reason,
    state:           'intent_created',
    mode:            'live',
  });

  // Submit to exchange with retry
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

      await logEvent(supabase, 'info', `BUY ${asset} ₩${Math.round(krwAmount).toLocaleString()} → ${finalState}`, { identifier, reason, fills: fills.length }, true);
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
  await logEvent(supabase, 'error', `BUY ${asset} failed after ${MAX_RETRIES} attempts: ${errMsg}`, { identifier, reason }, false);
  console.error(`[exec] BUY ${asset} FAILED: ${errMsg}`);
  return { ok: false, state: 'failed_terminal', orderId: orderRowId, error: errMsg };
}

/**
 * Execute a live sell order on Upbit.
 * This function always submits a real order. Paper/shadow modes are removed.
 *
 * @param {SupabaseClient} supabase
 * @param {object} exit       — { asset, sellPct, reason, trim }
 * @param {object} position   — open position row
 * @param {number} currentPrice
 * @param {object} context    — { usdKrw, gainPct, regime }
 * @returns {{ ok, state, orderId, fills, grossKrw?, error? }}
 */
async function executeSell(supabase, exit, position, currentPrice, context = {}) {
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
    mode:            'live',
  });

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
      let resp = await upbit.placeOrder({
        market,
        side:     'ask',
        volume:   sellQty,
        ord_type: 'market',
        identifier,
      });

      // ── Poll for settled state if Upbit returned 'wait' ──────────────────
      // Market sell orders frequently return state:'wait' on first response
      // even though execution is near-instant. A 'wait' response has an empty
      // trades[] array, so extractFills returns [] and positions.qty_open
      // would never be reduced. Poll until 'done' to get actual fill data.
      if (resp.state === 'wait' || resp.state === 'watch') {
        console.log(`[exec] SELL ${asset} response state:${resp.state} — polling for settlement (identifier: ${identifier})`);
        const settled = await pollForSettledOrder(identifier);
        if (settled) {
          resp = settled;
          console.log(`[exec] SELL ${asset} settled → state:${resp.state} executed_volume:${resp.executed_volume}`);
        } else {
          console.warn(`[exec] SELL ${asset} poll timed out — proceeding with state:${resp.state}, fills may be empty`);
        }
      }

      const finalState = classifyOutcome(resp);
      await updateOrderState(supabase, orderRowId, { state: finalState, exchange_uuid: resp.uuid, raw_response: resp });

      const fills = extractFills(resp, orderRowId, position.position_id, position.strategy_tag, { feeRate: askFeeRate, regime: context.regime, reason, usdKrw: context.usdKrw, gainPct: context.gainPct });
      for (const f of fills) await persistFill(supabase, f);

      await logEvent(supabase, 'info', `SELL ${asset} ${sellPct}% → ${finalState} fills:${fills.length} (≈₩${Math.round(grossKrw).toLocaleString()})`, { identifier, reason }, true);
      console.log(`[exec] SELL ${asset} ${sellPct}% (${sellQty.toFixed(6)}) — ${reason} → ${finalState} (${fills.length} fill(s))`);

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
  await logEvent(supabase, 'error', `SELL ${asset} failed after ${MAX_RETRIES} attempts: ${errMsg}`, { identifier, reason }, false);
  console.error(`[exec] SELL ${asset} FAILED: ${errMsg}`);
  return { ok: false, state: 'failed_terminal', orderId: orderRowId, error: errMsg, grossKrw };
}

module.exports = { executeBuy, executeSell };
