/**
 * Live quote provider interface.
 * Implementations: getQuote(symbol) -> { bid, ask, mid, spread, timestamp, provider } or null.
 */

function createLiveQuoteProvider(impl) {
  return {
    name: impl.name || 'unknown',

    async getQuote(symbol) {
      if (!impl.getQuote) return null;
      return impl.getQuote(symbol);
    },

    async validatePair(symbol) {
      if (!impl.validatePair) return { available: true };
      return impl.validatePair(symbol);
    },
  };
}

module.exports = { createLiveQuoteProvider };
