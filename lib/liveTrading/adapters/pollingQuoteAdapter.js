/**
 * Polling quote adapter: fetches USD/KRW from a REST API at an interval.
 * Uses EXCHANGERATE_API_KEY or ALPHA_VANTAGE_KEY. Verifies pair availability on start.
 */

const axios = require('axios');
const { createQuoteStreamAdapter } = require('./quoteStreamAdapter');

const DEFAULT_SYMBOL = 'USDKRW';
const POLL_MS = 15000;
const STALE_MS = 60000;

function toTick(symbol, bid, ask, raw) {
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const now = new Date();
  return { symbol, bid, ask, mid, spread, eventTs: now, receivedTs: now, raw };
}

/**
 * ExchangeRate-API: free tier has KRW. GET https://api.exchangerate-api.com/v4/latest/USD
 * Returns { rates: { KRW: 1350.5 } } -> so 1 USD = 1350.5 KRW (we want USD/KRW = 1350.5).
 */
async function fetchExchangeRateApi() {
  const key = process.env.EXCHANGERATE_API_KEY;
  const url = key
    ? `https://v6.exchangerate-api.com/v6/${key}/pair/USD/KRW`
    : 'https://api.exchangerate-api.com/v4/latest/USD';
  const res = await axios.get(url, { timeout: 10000 });
  let rate;
  if (res.data?.conversion_rate != null) rate = res.data.conversion_rate;
  else if (res.data?.rates?.KRW != null) rate = res.data.rates.KRW;
  else throw new Error('USD/KRW rate not in response');
  const r = Number(rate);
  if (Number.isNaN(r) || r <= 0) throw new Error('Invalid USD/KRW rate');
  return r;
}

function createPollingQuoteAdapter(options = {}) {
  const { pollMs = POLL_MS, symbol = DEFAULT_SYMBOL } = options;
  let intervalId = null;
  let lastQuote = null;
  let lastFetchTs = null;
  let subscribers = new Map();
  let failureCount = 0;

  const fetchQuote = async () => {
    try {
      const rate = await fetchExchangeRateApi();
      lastFetchTs = Date.now();
      failureCount = 0;
      const spread = rate * 0.0002;
      const tick = toTick(symbol, rate - spread / 2, rate + spread / 2, { rate });
      lastQuote = tick;
      subscribers.forEach((cb) => { try { cb(tick); } catch (_) {} });
      return tick;
    } catch (err) {
      failureCount += 1;
      throw err;
    }
  };

  const impl = {
    name: 'polling',
    isLive: false,

    subscribe(sym, onTick) {
      const s = sym || symbol;
      if (!subscribers.has(s)) subscribers.set(s, new Set());
      subscribers.get(s).add(onTick);
      if (!intervalId) {
        intervalId = setInterval(() => fetchQuote().catch(() => {}), pollMs);
        fetchQuote().catch(() => {});
      }
      return () => {
        const set = subscribers.get(s);
        if (set) { set.delete(onTick); if (set.size === 0) subscribers.delete(s); }
        if (subscribers.size === 0 && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      };
    },

    unsubscribe(sym) {
      const s = sym || symbol;
      subscribers.delete(s);
      if (subscribers.size === 0 && intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },

    getLastQuote(sym) {
      return lastQuote;
    },

    async fetchOnce() {
      try {
        await fetchQuote();
        return lastQuote;
      } catch (_) {
        return null;
      }
    },

    getHealth() {
      const staleSeconds = lastFetchTs ? (Date.now() - lastFetchTs) / 1000 : null;
      const status = failureCount >= 3 ? 'down' : (staleSeconds != null && staleSeconds > STALE_MS / 1000 ? 'degraded' : 'up');
      return { status, staleSeconds, lastFetchTs };
    },

    async validatePair(sym) {
      const s = (sym || symbol).toUpperCase();
      if (s !== 'USDKRW' && s !== 'KRWUSD') return { available: false, message: 'Only USDKRW supported' };
      try {
        await fetchQuote();
        return { available: true };
      } catch (err) {
        return { available: false, message: err.message };
      }
    },
  };

  return createQuoteStreamAdapter(impl);
}

module.exports = { createPollingQuoteAdapter, fetchExchangeRateApi };
