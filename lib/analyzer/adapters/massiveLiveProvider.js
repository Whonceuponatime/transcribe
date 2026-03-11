/**
 * Massive: primary live forex provider.
 * GET /v1/last_quote/currencies/{from}/{to}
 * Use for live USD/KRW quote. Pair as USD/KRW (from=USD, to=KRW).
 */

const axios = require('axios');
const { createLiveQuoteProvider } = require('./liveQuoteProvider');

// Massive REST base (per docs). Allow override for self-hosted/proxy setups.
const DEFAULT_BASE = 'https://api.massive.com';

function createMassiveLiveProvider() {
  const baseUrl = process.env.MASSIVE_API_BASE_URL || DEFAULT_BASE;
  const apiKey = process.env.MASSIVE_API_KEY;

  const impl = {
    name: 'massive',

    async getQuote(symbol) {
      if (!apiKey) return null;
      const pair = (symbol || 'USDKRW').toUpperCase().replace(/[^A-Z]/g, '');
      const from = pair.slice(0, 3);
      const to = pair.slice(3, 6);
      if (from.length !== 3 || to.length !== 3) return null;
      try {
        // Massive uses apiKey query param (docs omit auth mechanics, but API returns 401 when missing).
        const url = `${baseUrl}/v1/last_quote/currencies/${from}/${to}?apiKey=${encodeURIComponent(apiKey)}`;
        const res = await axios.get(url, { timeout: 15000 });
        const last = res.data?.last;
        if (!last || last.bid == null || last.ask == null) return null;
        const bid = Number(last.bid);
        const ask = Number(last.ask);
        const mid = (bid + ask) / 2;
        const spread = ask - bid;
        const timestamp = last.timestamp != null ? new Date(last.timestamp) : new Date();
        return {
          bid,
          ask,
          mid,
          spread,
          timestamp,
          provider: 'massive',
          raw: last,
        };
      } catch (err) {
        return null;
      }
    },

    async validatePair(symbol) {
      const q = await impl.getQuote(symbol);
      return { available: !!q, message: q ? null : 'Massive: no quote for pair' };
    },
  };

  return createLiveQuoteProvider(impl);
}

module.exports = { createMassiveLiveProvider };
