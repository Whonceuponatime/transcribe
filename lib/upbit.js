/**
 * Upbit Korean exchange private API client.
 * Uses JWT (HS256) auth — no external jwt library needed.
 * Docs: https://docs.upbit.com/reference
 */

const crypto = require('crypto');
const axios = require('axios');

const BASE = 'https://api.upbit.com';

// ─── JWT helpers ─────────────────────────────────────────────────────────────

function b64url(input) {
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(payload) {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY not set');

  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({ access_key: accessKey, nonce: crypto.randomUUID(), ...payload });
  const sig = crypto.createHmac('sha256', secretKey)
    .update(`${header}.${body}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.${sig}`;
}

function queryHash(params) {
  const qs = new URLSearchParams(params).toString();
  return {
    query_hash: crypto.createHash('sha512').update(qs).digest('hex'),
    query_hash_alg: 'SHA512',
    qs,
  };
}

function authHeader(extraPayload = {}) {
  return { Authorization: `Bearer ${makeJwt(extraPayload)}` };
}

function authHeaderWithQuery(params) {
  const { query_hash, query_hash_alg, qs } = queryHash(params);
  return {
    headers: authHeader({ query_hash, query_hash_alg }),
    qs,
  };
}

// ─── Public endpoints (no auth) ──────────────────────────────────────────────

/** Current KRW price for one or more markets, e.g. ['KRW-BTC','KRW-ETH'] */
async function getTicker(markets) {
  const res = await axios.get(`${BASE}/v1/ticker`, {
    params: { markets: markets.join(',') },
    timeout: 10000,
  });
  return res.data; // [{ market, trade_price, change_rate, acc_trade_price_24h, ... }]
}

/**
 * Fetch minute candles. unit: 1, 3, 5, 10, 15, 30, 60, 240
 * Returns array oldest→newest with { trade_price, high_price, low_price, opening_price, candle_acc_trade_volume }
 */
async function getMinuteCandles(market, unit = 240, count = 100) {
  const res = await axios.get(`${BASE}/v1/candles/minutes/${unit}`, {
    params: { market, count: Math.min(count, 200) },
    timeout: 10000,
  });
  return res.data.reverse(); // Upbit returns newest first — reverse to oldest-first
}

/**
 * Fetch daily candles.
 * Returns array oldest→newest.
 */
async function getDayCandles(market, count = 200) {
  const res = await axios.get(`${BASE}/v1/candles/days`, {
    params: { market, count: Math.min(count, 200) },
    timeout: 10000,
  });
  return res.data.reverse();
}

/**
 * Fetch all candles needed for indicators on one coin.
 * Returns candle arrays (oldest→newest) with closes, highs, lows, volumes for 1h, 4h, and daily.
 */
async function getCandleData(market) {
  const [candles1h, candles4h, candles1d] = await Promise.all([
    getMinuteCandles(market, 60, 120),  // 1h candles, 120 periods (~5 days) — fast signals
    getMinuteCandles(market, 240, 100), // 4h candles, 100 periods (~17 days)
    getDayCandles(market, 200),          // daily candles, 200 days
  ]);
  return {
    candles1h,
    closes1h:   candles1h.map((c) => c.trade_price),
    highs1h:    candles1h.map((c) => c.high_price),
    lows1h:     candles1h.map((c) => c.low_price),
    volumes1h:  candles1h.map((c) => c.candle_acc_trade_volume),
    candles4h,
    closes4h:   candles4h.map((c) => c.trade_price),
    highs4h:    candles4h.map((c) => c.high_price),
    lows4h:     candles4h.map((c) => c.low_price),
    volumes4h:  candles4h.map((c) => c.candle_acc_trade_volume),
    candles1d,
    closes1d:   candles1d.map((c) => c.trade_price),
    volumes1d:  candles1d.map((c) => c.candle_acc_trade_volume),
  };
}

/**
 * Fetch order book for one or more markets.
 * Returns { market, total_ask_size, total_bid_size, orderbook_units }
 * bid_ratio = total_bid_size / (total_bid_size + total_ask_size): >0.6 = buy pressure
 */
async function getOrderBook(markets) {
  try {
    const res = await axios.get(`${BASE}/v1/orderbook`, {
      params: { markets: Array.isArray(markets) ? markets.join(',') : markets },
      timeout: 8000,
    });
    return res.data; // array of order book objects
  } catch (_) { return []; }
}

// ─── Private endpoints ────────────────────────────────────────────────────────

/** All account balances. Returns array of { currency, balance, avg_buy_price, ... } */
async function getAccounts() {
  const res = await axios.get(`${BASE}/v1/accounts`, {
    headers: authHeader(),
    timeout: 10000,
  });
  return res.data;
}

/**
 * Place a market BUY order spending exactly `krwAmount` KRW.
 * market: 'KRW-BTC' | 'KRW-ETH' | 'KRW-SOL'
 */
async function marketBuy(market, krwAmount) {
  const params = {
    market,
    side: 'bid',
    price: String(Math.floor(krwAmount)),
    ord_type: 'price', // market buy by KRW
  };
  // Upbit requires query_hash of body params even for POST requests
  const { query_hash, query_hash_alg } = queryHash(params);
  const res = await axios.post(`${BASE}/v1/orders`, params, {
    headers: { ...authHeader({ query_hash, query_hash_alg }), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return res.data;
}

/**
 * Place a market SELL order selling exactly `volume` coins.
 * market: 'KRW-BTC' | 'KRW-ETH' | 'KRW-SOL'
 * volume: coin amount as string, e.g. '0.001'
 */
async function marketSell(market, volume) {
  const params = {
    market,
    side: 'ask',
    volume: String(volume),
    ord_type: 'market',
  };
  const { query_hash, query_hash_alg } = queryHash(params);
  const res = await axios.post(`${BASE}/v1/orders`, params, {
    headers: { ...authHeader({ query_hash, query_hash_alg }), 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return res.data;
}

/** Recent closed orders for a market */
async function getClosedOrders(market, limit = 20) {
  const params = { market, state: 'done', limit: String(limit) };
  const { headers, qs } = authHeaderWithQuery(params);
  const res = await axios.get(`${BASE}/v1/orders/closed?${qs}`, {
    headers,
    timeout: 10000,
  });
  return res.data;
}

/** Minimum order size and fee info for a market */
async function getOrderChance(market) {
  const params = { market };
  const { headers, qs } = authHeaderWithQuery(params);
  const res = await axios.get(`${BASE}/v1/orders/chance?${qs}`, {
    headers,
    timeout: 10000,
  });
  return res.data;
}

/** Check if credentials are valid — lightweight balance check */
async function ping() {
  try {
    const accounts = await getAccounts();
    const krw = accounts.find((a) => a.currency === 'KRW');
    return { ok: true, krwBalance: Number(krw?.balance || 0) };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error?.message || err.message };
  }
}

// ─── Cash movements: deposits & withdrawals ──────────────────────────────────
//
// Phase A poller targets. /v1/deposits and /v1/withdraws share the same paged
// response shape; both use the standard authHeaderWithQuery signing. The two
// public fns get a single 429 retry (1s sleep) — narrowly scoped here, NOT a
// generic retry wrapper across upbit.js.

async function _withRetry429(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.response?.status === 429) {
      await new Promise((r) => setTimeout(r, 1000));
      return await fn();
    }
    throw err;
  }
}

async function _fetchUpbitListPage(path, { currency, limit, page, order_by }) {
  return _withRetry429(async () => {
    const params = {};
    if (currency)         params.currency = currency;
    if (limit != null)    params.limit    = String(limit);
    if (page != null)     params.page     = String(page);
    if (order_by != null) params.order_by = order_by;
    const { headers, qs } = authHeaderWithQuery(params);
    const res = await axios.get(`${BASE}${path}?${qs}`, { headers, timeout: 10000 });
    return res.data;
  });
}

/**
 * Loop a paged Upbit endpoint until the response is short or the cap is hit.
 * fn signature: ({ ...baseParams, page }) => Promise<array>
 * Cap of 50 pages × 100 = 5000 records — plenty for KRW history.
 */
async function paginateUpbit(fn, baseParams) {
  const limit = baseParams.limit ?? 100;
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await fn({ ...baseParams, page });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < limit) break;
  }
  return all;
}

/** GET /v1/deposits. Auto-paginates when `page` is omitted. */
async function getDeposits({ currency, limit = 100, page, order_by = 'desc' } = {}) {
  const fetchPage = (p) => _fetchUpbitListPage('/v1/deposits', p);
  if (page != null) return fetchPage({ currency, limit, page, order_by });
  return paginateUpbit(fetchPage, { currency, limit, order_by });
}

/** GET /v1/withdraws. Auto-paginates when `page` is omitted. */
async function getWithdraws({ currency, limit = 100, page, order_by = 'desc' } = {}) {
  const fetchPage = (p) => _fetchUpbitListPage('/v1/withdraws', p);
  if (page != null) return fetchPage({ currency, limit, page, order_by });
  return paginateUpbit(fetchPage, { currency, limit, order_by });
}

// ─── Runtime fee fetching ─────────────────────────────────────────────────────
// Returns { bidFeeRate, askFeeRate } from the available-order-info endpoint.
// Falls back to 0.0025 if the endpoint is unreachable.
async function getOrderFees(market) {
  try {
    const chance  = await getOrderChance(market);
    const bidFee  = parseFloat(chance?.bid_fee  ?? chance?.market?.bid?.fee  ?? '0.0025');
    const askFee  = parseFloat(chance?.ask_fee  ?? chance?.market?.ask?.fee  ?? '0.0025');
    return { bidFeeRate: bidFee, askFeeRate: askFee };
  } catch (_) {
    return { bidFeeRate: 0.0025, askFeeRate: 0.0025 };
  }
}

// ─── KRW tick-size normalization ──────────────────────────────────────────────
// Upbit KRW market has tiered tick sizes based on price.
// Source: https://docs.upbit.com/kr/docs/krw-market-info
// Last verified: 2026-03-21
const KRW_TICK_TABLE = [
  { below: 10,       tick: 0.01   },
  { below: 100,      tick: 0.1    },
  { below: 1000,     tick: 1      },
  { below: 10000,    tick: 5      },
  { below: 100000,   tick: 10     },
  { below: 500000,   tick: 50     },
  { below: 1000000,  tick: 100    },
  { below: 2000000,  tick: 500    },
  { below: Infinity, tick: 1000   },
];

function normalizeKrwPrice(price) {
  if (price == null || price <= 0) return price;
  const entry = KRW_TICK_TABLE.find((r) => price < r.below);
  const tick  = entry?.tick ?? 1000;
  return Math.floor(price / tick) * tick;
}

// ─── Place order with identifier (idempotency) ────────────────────────────────
// Always attaches a client identifier so retries can detect duplicate intents.
// Returns the raw Upbit response.
async function placeOrder({ market, side, volume, price, ord_type = 'market', identifier, smp_type }) {
  const body = {
    market,
    side,                  // 'bid' (buy) or 'ask' (sell)
    ord_type,
    identifier: identifier || crypto.randomUUID(),
  };

  if (ord_type === 'market' && side === 'bid') {
    body.price = String(Math.round(price || volume)); // market buy uses KRW amount in 'price'
  } else if (ord_type === 'market' && side === 'ask') {
    body.volume = String(volume); // market sell uses coin volume
  } else {
    if (price)  body.price  = String(normalizeKrwPrice(price));
    if (volume) body.volume = String(volume);
  }

  if (smp_type) body.smp_type = smp_type;

  const { query_hash, query_hash_alg } = queryHash(body);
  const headers = {
    ...authHeader({ query_hash, query_hash_alg }),
    'Content-Type': 'application/json',
  };

  const res = await axios.post(`${BASE}/v1/orders`, body, { headers, timeout: 15000 });
  return res.data;
}

// ─── Query order by client identifier ────────────────────────────────────────
async function getOrderByIdentifier(identifier) {
  const params = { identifier };
  const { headers, qs } = authHeaderWithQuery(params);
  try {
    const res = await axios.get(`${BASE}/v1/order?${qs}`, { headers, timeout: 10000 });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// ─── Place a test order (preflight / post-deploy check) ──────────────────────
async function testOrder(market) {
  try {
    const params = { market };
    const { headers, qs } = authHeaderWithQuery(params);
    const res = await axios.get(`${BASE}/v1/orders/test?${qs}`, { headers, timeout: 10000 });
    return { ok: true, data: res.data };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error?.message || err.message };
  }
}

module.exports = {
  getTicker,
  getMinuteCandles,
  getDayCandles,
  getCandleData,
  getOrderBook,
  getAccounts,
  marketBuy,
  marketSell,
  getClosedOrders,
  getOrderChance,
  getOrderFees,
  normalizeKrwPrice,
  placeOrder,
  getOrderByIdentifier,
  testOrder,
  ping,
  // Cash movements (Phase A)
  authHeaderWithQuery,
  getDeposits,
  getWithdraws,
  paginateUpbit,
};
