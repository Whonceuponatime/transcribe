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
  return res.data; // [{ market, trade_price, ... }]
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

module.exports = {
  getTicker,
  getAccounts,
  marketBuy,
  marketSell,
  getClosedOrders,
  getOrderChance,
  ping,
};
