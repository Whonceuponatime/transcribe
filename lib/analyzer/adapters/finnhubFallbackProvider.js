/**
 * Finnhub: fallback live/quote provider.
 * Use forex/candle for latest bar as quote proxy when Massive unavailable.
 * Symbol format OANDA:USD_KRW or FINNHUB:USDKRW - check Finnhub docs.
 */

const axios = require('axios');
const { createLiveQuoteProvider } = require('./liveQuoteProvider');

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

function toFinnhubSymbol(symbol) {
  const sym = (symbol || 'USDKRW').toUpperCase();
  return sym.length === 6 ? `OANDA:${sym.slice(0, 3)}_${sym.slice(3, 6)}` : sym;
}

async function fetchCandles1m(apiKey, symbol, fromSec, toSec) {
  const finnhubSymbol = toFinnhubSymbol(symbol);
  const url = `${FINNHUB_BASE}/forex/candle?symbol=${encodeURIComponent(finnhubSymbol)}&resolution=1&from=${fromSec}&to=${toSec}&token=${encodeURIComponent(apiKey)}`;
  const res = await axios.get(url, { timeout: 15000 });
  const o = res.data?.o || [];
  const h = res.data?.h || [];
  const l = res.data?.l || [];
  const c = res.data?.c || [];
  const t = res.data?.t || [];
  const n = Math.min(o.length, h.length, l.length, c.length, t.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      bucket_ts: new Date(t[i] * 1000).toISOString(),
      open: Number(o[i]),
      high: Number(h[i]),
      low: Number(l[i]),
      close: Number(c[i]),
    });
  }
  return out;
}

function createFinnhubFallbackProvider() {
  const apiKey = process.env.FINNHUB_API_KEY;

  const impl = {
    name: 'finnhub',

    async getQuote(symbol) {
      if (!apiKey) return null;
      try {
        const to = Math.floor(Date.now() / 1000);
        const from = to - 3600;
        const candles = await fetchCandles1m(apiKey, symbol, from, to);
        if (!candles.length) return null;
        const last = candles[candles.length - 1];
        const close = last.close;
        const ts = last.bucket_ts ? new Date(last.bucket_ts).getTime() : Date.now();
        return {
          // Finnhub candles do not provide true bid/ask. Do not fabricate BBO.
          bid: null,
          ask: null,
          mid: close,
          spread: null,
          timestamp: new Date(ts),
          provider: 'finnhub',
          raw: { candles_1m: candles.slice(-10) },
        };
      } catch (_) {
        return null;
      }
    },

    async validatePair(symbol) {
      const q = await impl.getQuote(symbol);
      return { available: !!q, message: q ? null : 'Finnhub: no quote for pair' };
    },

    async fetchCandles1m(symbol, fromSec, toSec) {
      if (!apiKey) return [];
      try {
        return await fetchCandles1m(apiKey, symbol, fromSec, toSec);
      } catch (_) {
        return [];
      }
    },
  };

  return createLiveQuoteProvider(impl);
}

module.exports = { createFinnhubFallbackProvider, toFinnhubSymbol };
