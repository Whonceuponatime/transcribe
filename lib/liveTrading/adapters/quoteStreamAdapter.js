/**
 * Quote stream adapter interface: provider-agnostic live or polling quote feed.
 * Implementations must expose: subscribe(symbol, onTick), unsubscribe(), getLastQuote(), getHealth().
 * Verify USD/KRW (or KRW/USD) is available before using; fail loudly if not.
 */

const EventEmitter = require('events');

const SYMBOL_USDKRW = 'USDKRW';
const SYMBOL_KRWUSD = 'KRWUSD';

/**
 * @typedef {Object} Tick
 * @property {string} symbol
 * @property {number} bid
 * @property {number} ask
 * @property {number} mid
 * @property {number} spread
 * @property {Date} eventTs
 * @property {Date} receivedTs
 * @property {Object} [raw]
 */

function createQuoteStreamAdapter(impl) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    name: impl.name || 'unknown',
    isLive: !!impl.isLive,

    subscribe(symbol, onTick) {
      if (!impl.subscribe) return () => {};
      const handler = (tick) => {
        emitter.emit('tick', tick);
        if (onTick) onTick(tick);
      };
      impl.subscribe(symbol, handler);
      return () => { if (impl.unsubscribe) impl.unsubscribe(symbol); };
    },

    unsubscribe(symbol) {
      if (impl.unsubscribe) impl.unsubscribe(symbol);
    },

    getLastQuote(symbol) {
      return impl.getLastQuote ? impl.getLastQuote(symbol) : null;
    },

    async fetchOnce() {
      if (impl.fetchOnce) return impl.fetchOnce();
      return impl.getLastQuote ? impl.getLastQuote('USDKRW') : null;
    },

    getHealth() {
      return impl.getHealth ? impl.getHealth() : { status: 'unknown', staleSeconds: null };
    },

    async validatePair(symbol) {
      if (!impl.validatePair) return { available: true };
      const out = await impl.validatePair(symbol);
      if (!out.available) {
        throw new Error(`Quote adapter ${impl.name}: ${symbol} not available. ${out.message || 'Check provider.'}`);
      }
      return out;
    },

    on(event, fn) { emitter.on(event, fn); return this; },
    off(event, fn) { emitter.off(event, fn); return this; },
  };
}

module.exports = {
  createQuoteStreamAdapter,
  SYMBOL_USDKRW,
  SYMBOL_KRWUSD,
};
