/**
 * Single order service: idempotency keys, one entry point for all order placement.
 * Never submit the same intent twice if previous result is uncertain; reconcile first.
 */

const crypto = require('crypto');

function generateIdempotencyKey(signalRunId, side, notionalKrw) {
  const str = [signalRunId, side, notionalKrw, Date.now()].filter(Boolean).join('-');
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 32);
}

async function getOrderByIdempotencyKey(supabase, idempotencyKey) {
  const { data } = await supabase
    .from('order_requests')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
    .single();
  return data;
}

async function placeOrder(supabase, brokerAdapter, params) {
  const {
    signalRunId,
    clientOrderId,
    symbol,
    side,
    orderType,
    quantity,
    notionalKrw,
    limitPrice,
    idempotencyKey: providedKey,
    mode,
  } = params;

  const idempotencyKey = providedKey || generateIdempotencyKey(signalRunId, side, notionalKrw);

  const existing = await getOrderByIdempotencyKey(supabase, idempotencyKey);
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'submitted') {
      const status = await brokerAdapter.getOrderStatus(existing.client_order_id);
      return { ok: true, orderRequest: existing, reconciled: true, status: status.status };
    }
    return { ok: true, orderRequest: existing, duplicate: true };
  }

  const { data: orderRequest, error: insertErr } = await supabase
    .from('order_requests')
    .insert({
      client_order_id: clientOrderId || `ord-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      signal_run_id: signalRunId,
      broker: brokerAdapter.name,
      mode: mode || 'paper',
      symbol,
      side,
      order_type: orderType || 'MKTABLE_LMT',
      quantity,
      notional_krw: notionalKrw,
      limit_price: limitPrice,
      status: 'pending',
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();

  if (insertErr) return { ok: false, message: insertErr.message };

  const result = await brokerAdapter.placeOrder({
    clientOrderId: orderRequest.client_order_id,
    symbol,
    side,
    orderType: orderRequest.order_type,
    quantity,
    limitPrice,
    notionalKrw,
  });

  await supabase.from('order_events').insert({
    order_request_id: orderRequest.id,
    broker_order_id: result.brokerOrderId,
    event_type: result.ok ? 'submitted' : 'rejected',
    payload: result,
  });

  if (result.ok) {
    await supabase.from('order_requests').update({
      status: result.status || 'submitted',
      updated_at: new Date().toISOString(),
    }).eq('id', orderRequest.id);
  } else {
    await supabase.from('order_requests').update({
      status: 'rejected',
      updated_at: new Date().toISOString(),
    }).eq('id', orderRequest.id);
  }

  return { ok: result.ok, orderRequest, brokerResult: result };
}

module.exports = {
  placeOrder,
  getOrderByIdempotencyKey,
  generateIdempotencyKey,
};
