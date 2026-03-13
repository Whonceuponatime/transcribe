/**
 * Live trading module for KRW→USD paper/live execution.
 * Paper mode: default, no external broker calls.
 * Live mode: requires LIVE_TRADING_ENABLED=true + IBKR_GATEWAY_URL.
 *
 * Functions consumed by server.js /api/live/* routes.
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase ────────────────────────────────────────────────────────────
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// ─── Quote Adapters ──────────────────────────────────────────────────────

/** Simple polling adapter: fetches USD/KRW from ExchangeRate-API or Yahoo */
function createPollingAdapter() {
  let lastQuote = null;

  async function fetchOnce() {
    const providers = [
      {
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X?interval=1m&range=1d',
        extract: (d) => {
          const meta = d?.chart?.result?.[0]?.meta;
          const rate = meta?.regularMarketPrice;
          if (!rate) return null;
          return { mid: Number(rate), bid: Number(rate) * 0.9995, ask: Number(rate) * 1.0005, spread: Number(rate) * 0.001 };
        },
        name: 'yahoo',
      },
      {
        url: 'https://api.exchangerate-api.com/v4/latest/USD',
        extract: (d) => {
          const rate = d?.rates?.KRW;
          if (!rate) return null;
          return { mid: Number(rate), bid: Number(rate) * 0.9995, ask: Number(rate) * 1.0005, spread: Number(rate) * 0.001 };
        },
        name: 'exchangerate-api',
      },
      {
        url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW',
        extract: (d) => {
          const rate = d?.rates?.KRW;
          if (!rate) return null;
          return { mid: Number(rate), bid: Number(rate) * 0.9995, ask: Number(rate) * 1.0005, spread: Number(rate) * 0.001 };
        },
        name: 'frankfurter',
      },
    ];

    for (const p of providers) {
      try {
        const res = await axios.get(p.url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const q = p.extract(res.data);
        if (q && q.mid > 0) {
          lastQuote = {
            ...q,
            symbol: 'USDKRW',
            eventTs: Date.now(),
            raw: res.data,
            provider: p.name,
          };
          return lastQuote;
        }
      } catch (err) {
        // try next provider
      }
    }
    return null;
  }

  async function validatePair(symbol) {
    if (symbol !== 'USDKRW') throw new Error(`Unsupported symbol: ${symbol}`);
    return true;
  }

  function getHealth() {
    if (!lastQuote) return { status: 'down', message: 'No quote fetched yet' };
    const staleMs = Date.now() - (lastQuote.eventTs || 0);
    if (staleMs > 120000) return { status: 'degraded', staleSeconds: Math.round(staleMs / 1000) };
    return { status: 'up', staleSeconds: Math.round(staleMs / 1000) };
  }

  function getLastQuote(symbol) {
    return lastQuote?.symbol === symbol ? lastQuote : null;
  }

  return {
    name: process.env.BROKER_PROVIDER || 'polling',
    fetchOnce,
    validatePair,
    getHealth,
    getLastQuote,
  };
}

let _quoteAdapter = null;

function getQuoteAdapter() {
  if (!_quoteAdapter) {
    _quoteAdapter = createPollingAdapter();
  }
  return _quoteAdapter;
}

// ─── Latest quote from DB ────────────────────────────────────────────────
async function getLatestQuote(supabase) {
  const { data } = await supabase
    .from('market_ticks')
    .select('*')
    .eq('symbol', 'USDKRW')
    .order('event_ts', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

// ─── Latest signal from DB ───────────────────────────────────────────────
async function getLatestSignal(supabase) {
  const { data } = await supabase
    .from('signal_runs')
    .select('*')
    .eq('symbol', 'USDKRW')
    .order('signal_ts', { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

// ─── App settings helpers ─────────────────────────────────────────────────
async function getSetting(supabase, key, defaultValue) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', key).single();
  return data?.value ?? defaultValue;
}

async function setSetting(supabase, key, value) {
  await supabase
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return value;
}

async function getTradingMode(supabase) {
  const setting = await getSetting(supabase, 'trading_mode', { mode: 'paper' });
  return setting?.mode || 'paper';
}

async function setTradingMode(supabase, mode) {
  const resolved = mode === 'live' && process.env.LIVE_TRADING_ENABLED === 'true' ? 'live' : 'paper';
  await setSetting(supabase, 'trading_mode', { mode: resolved });
  return resolved;
}

async function isKillSwitchOn(supabase) {
  const setting = await getSetting(supabase, 'kill_switch', { enabled: false });
  return setting?.enabled === true;
}

async function setKillSwitch(supabase, enabled) {
  await setSetting(supabase, 'kill_switch', { enabled: !!enabled });
  if (enabled) {
    await supabase.from('risk_events').insert({
      severity: 'critical',
      category: 'kill_switch',
      message: 'Kill switch activated',
      event_ts: new Date().toISOString(),
    });
  }
}

// ─── Historical bars adapter (reads from market_bars_1m) ────────────────
function createDbHistoricalBarsAdapter(supabase) {
  async function getBars(symbol, resolution, fromMs, toMs) {
    const fromTs = new Date(fromMs).toISOString();
    const toTs = new Date(toMs).toISOString();

    if (resolution === '1m') {
      const { data } = await supabase
        .from('market_bars_1m')
        .select('bucket_ts, open, high, low, close, volume')
        .eq('symbol', symbol)
        .gte('bucket_ts', fromTs)
        .lte('bucket_ts', toTs)
        .order('bucket_ts', { ascending: true });
      return (data || []).map((b) => ({
        ts: new Date(b.bucket_ts).getTime(),
        open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
      }));
    }

    // For daily (1d): aggregate from market_ticks
    const { data } = await supabase
      .from('market_ticks')
      .select('event_ts, mid, bid, ask')
      .eq('symbol', symbol)
      .gte('event_ts', fromTs)
      .lte('event_ts', toTs)
      .order('event_ts', { ascending: true });

    if (!data || data.length === 0) return [];

    // Group by day
    const byDay = {};
    for (const tick of data) {
      const day = tick.event_ts.slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(tick.mid || ((tick.bid + tick.ask) / 2));
    }

    return Object.entries(byDay).map(([day, prices]) => ({
      ts: new Date(day).getTime(),
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      volume: prices.length,
    }));
  }

  return { getBars };
}

// ─── Signal engine ───────────────────────────────────────────────────────

/**
 * Lightweight momentum signal for live trading.
 * Uses recent 1m bars and daily close bars to compute score.
 * Returns { decision, score, allocation_pct, confidence, reasons, safeguards, snapshot }
 */
function runSignal(quote, bars1m, bars1d, killSwitchOn) {
  const reasons = [];
  const safeguards = [];
  let score = 0;

  if (killSwitchOn) {
    return {
      decision: 'BLOCKED_BY_RISK',
      score: 0,
      allocation_pct: 0,
      confidence: 0,
      reasons: ['Kill switch is active'],
      safeguards: ['Kill switch override — no trades'],
      snapshot: { quote, kill_switch: true },
    };
  }

  if (!quote) {
    return {
      decision: 'WAIT',
      score: 0,
      allocation_pct: 0,
      confidence: 0,
      reasons: ['No live quote available'],
      safeguards: ['Missing market data'],
      snapshot: {},
    };
  }

  const mid = quote.mid || ((quote.bid + quote.ask) / 2) || 0;
  const spread = quote.spread || 0;
  const spreadBps = mid > 0 ? (spread / mid) * 10000 : 999;

  // Spread check
  if (spreadBps > 50) {
    safeguards.push(`Spread is ${spreadBps.toFixed(0)}bps — above 50bps threshold`);
    score -= 1;
  }

  // Data staleness
  const staleMs = quote.event_ts ? Date.now() - new Date(quote.event_ts).getTime() : 999999;
  if (staleMs > 120000) {
    safeguards.push(`Quote is stale (${Math.round(staleMs / 60000)}m old)`);
    score -= 1;
  }

  // Daily trend from bars1d
  if (bars1d && bars1d.length >= 20) {
    const closes = bars1d.map((b) => b.close);
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ma60 = closes.length >= 60 ? closes.slice(-60).reduce((a, b) => a + b, 0) / 60 : null;

    if (mid > ma20) {
      score += 1;
      reasons.push(`Spot ₩${Math.round(mid)} is above 20d MA ₩${Math.round(ma20)} — USD strong`);
    } else {
      score -= 1;
      reasons.push(`Spot ₩${Math.round(mid)} is below 20d MA ₩${Math.round(ma20)} — rate is cheap`);
      score += 2; // cheap entry bonus
    }

    if (ma60 !== null && mid > ma60) {
      score += 1;
      reasons.push('Above 60d MA — confirmed USD uptrend');
    }
  }

  // 1m momentum
  if (bars1m && bars1m.length >= 5) {
    const recent = bars1m.slice(-5).map((b) => b.close);
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    const momentum = oldest > 0 ? (newest - oldest) / oldest : 0;
    if (momentum > 0.0005) {
      score += 1;
      reasons.push('1m momentum positive — USD strengthening');
    }
  }

  // Decision thresholds (same scale as analyzer)
  let decision, allocation_pct, confidence;
  if (score >= 3) {
    decision = 'BUY_NOW'; allocation_pct = 50; confidence = 0.8;
  } else if (score >= 1) {
    decision = 'SCALE_IN'; allocation_pct = 25; confidence = 0.6;
  } else {
    decision = 'WAIT'; allocation_pct = 0; confidence = 0.4;
  }

  return {
    decision,
    score,
    allocation_pct,
    confidence,
    reasons,
    safeguards,
    snapshot: { mid, spread, spreadBps, staleMs, bars1dCount: (bars1d || []).length },
  };
}

// ─── Broker adapters ─────────────────────────────────────────────────────

function createPaperBroker() {
  const positions = {};
  let cash = { usd: 0, krw: 0 };

  return {
    name: 'paper',
    async getCash() {
      return { ...cash };
    },
    async getPositions() {
      return Object.values(positions);
    },
    async placeOrder(order) {
      const filled = {
        clientOrderId: order.clientOrderId,
        broker: 'paper',
        mode: 'paper',
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        fillPrice: order.limitPrice || 1350,
        status: 'filled',
        note: 'Paper trade — simulated fill',
      };
      if (order.side === 'buy') {
        cash.usd = (cash.usd || 0) + order.quantity;
        cash.krw = (cash.krw || 0) - (order.notionalKrw || order.quantity * (order.limitPrice || 1350));
      }
      return filled;
    },
  };
}

function createIbkrBroker() {
  const gatewayUrl = process.env.IBKR_GATEWAY_URL;
  const accountId = process.env.IBKR_ACCOUNT_ID;

  return {
    name: 'ibkr',
    async getCash() {
      if (!gatewayUrl) throw new Error('IBKR_GATEWAY_URL not configured');
      const res = await axios.get(`${gatewayUrl}/v1/api/account/${accountId}/ledger`, { timeout: 15000 });
      const ledger = res.data?.BASE || {};
      return { usd: Number(ledger.cashbalance) || 0, krw: 0 };
    },
    async getPositions() {
      if (!gatewayUrl) throw new Error('IBKR_GATEWAY_URL not configured');
      const res = await axios.get(`${gatewayUrl}/v1/api/portfolio/${accountId}/positions/0`, { timeout: 15000 });
      return (res.data || []).map((p) => ({
        symbol: p.contractDesc,
        quantity: p.position,
        marketValue: p.mktValue,
        avgCost: p.avgCost,
      }));
    },
    async placeOrder(order) {
      if (!gatewayUrl) throw new Error('IBKR_GATEWAY_URL not configured');
      const conid = process.env.IBKR_USDKRW_CONID;
      const payload = {
        orders: [{
          conid: conid ? Number(conid) : undefined,
          orderType: order.orderType || 'LMT',
          side: order.side.toUpperCase(),
          quantity: order.quantity,
          price: order.limitPrice,
          tif: 'DAY',
          cOID: order.clientOrderId,
        }],
      };
      const res = await axios.post(`${gatewayUrl}/v1/api/iserver/account/${accountId}/orders`, payload, { timeout: 15000 });
      return { ...res.data, clientOrderId: order.clientOrderId, broker: 'ibkr' };
    },
  };
}

function getBrokerAdapter(mode) {
  if (mode === 'live' && process.env.LIVE_TRADING_ENABLED === 'true') {
    return createIbkrBroker();
  }
  return createPaperBroker();
}

// ─── Safety checks ───────────────────────────────────────────────────────

async function checkSafety(supabase, { notionalKrw, quoteStaleSeconds, spreadBps, circuitFailureCount }) {
  const maxOrderKrw = (await getSetting(supabase, 'max_single_order_krw', { value: 2000000 }))?.value || 2000000;
  const maxSpreadBps = (await getSetting(supabase, 'max_spread_bps', { value: 50 }))?.value || 50;
  const staleDataSeconds = (await getSetting(supabase, 'stale_data_seconds', { value: 60 }))?.value || 60;
  const circuitBreakerLimit = (await getSetting(supabase, 'circuit_breaker_failures', { value: 5 }))?.value || 5;

  if (notionalKrw > maxOrderKrw) {
    return { allowed: false, reason: 'order_too_large', detail: `₩${notionalKrw} exceeds max ₩${maxOrderKrw}` };
  }
  if (quoteStaleSeconds > staleDataSeconds) {
    return { allowed: false, reason: 'stale_quote', detail: `Quote is ${quoteStaleSeconds}s old, max ${staleDataSeconds}s` };
  }
  if (spreadBps > maxSpreadBps) {
    return { allowed: false, reason: 'spread_too_wide', detail: `Spread ${spreadBps}bps exceeds max ${maxSpreadBps}bps` };
  }
  if (circuitFailureCount >= circuitBreakerLimit) {
    return { allowed: false, reason: 'circuit_breaker', detail: `${circuitFailureCount} consecutive failures` };
  }
  return { allowed: true };
}

// ─── Place order + log to DB ─────────────────────────────────────────────

async function placeOrder(supabase, broker, orderParams) {
  const {
    clientOrderId, symbol, side, orderType, quantity,
    notionalKrw, limitPrice, idempotencyKey, mode,
    signalRunId,
  } = orderParams;

  // Idempotency check
  const { data: existing } = await supabase
    .from('order_requests')
    .select('id, status')
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (existing) {
    return { ok: true, duplicate: true, orderId: existing.id, status: existing.status };
  }

  const { data: dbOrder, error: insertErr } = await supabase
    .from('order_requests')
    .insert({
      client_order_id: clientOrderId,
      signal_run_id: signalRunId || null,
      broker: broker.name,
      mode: mode || 'paper',
      symbol,
      side,
      order_type: orderType,
      quantity,
      notional_krw: notionalKrw,
      limit_price: limitPrice,
      status: 'pending',
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();

  if (insertErr) throw new Error(`DB insert failed: ${insertErr.message}`);

  let brokerResult;
  try {
    brokerResult = await broker.placeOrder({ clientOrderId, symbol, side, orderType, quantity, notionalKrw, limitPrice });
    await supabase
      .from('order_requests')
      .update({ status: 'submitted', updated_at: new Date().toISOString() })
      .eq('id', dbOrder.id);

    await supabase.from('order_events').insert({
      order_request_id: dbOrder.id,
      event_type: 'submitted',
      event_ts: new Date().toISOString(),
      payload: brokerResult,
    });

    return { ok: true, orderId: dbOrder.id, brokerResult };
  } catch (err) {
    await supabase
      .from('order_requests')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', dbOrder.id);
    await supabase.from('order_events').insert({
      order_request_id: dbOrder.id,
      event_type: 'rejected',
      event_ts: new Date().toISOString(),
      payload: { error: err.message },
    });
    await supabase.from('risk_events').insert({
      severity: 'warn',
      category: 'order_rejected',
      message: `Order rejected: ${err.message}`,
      event_ts: new Date().toISOString(),
      payload: { orderId: dbOrder.id },
    });
    return { ok: false, orderId: dbOrder.id, error: err.message };
  }
}

module.exports = {
  getSupabase,
  getQuoteAdapter,
  getLatestQuote,
  getLatestSignal,
  getTradingMode,
  setTradingMode,
  isKillSwitchOn,
  setKillSwitch,
  getBrokerAdapter,
  createDbHistoricalBarsAdapter,
  runSignal,
  checkSafety,
  placeOrder,
};
