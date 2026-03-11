/**
 * Broker adapter interface. All order placement goes through the order service;
 * this adapter is the execution layer (IBKR, paper, etc.).
 * Implementations: placeOrder, cancelOrder, getOrderStatus, getPositions, getCash.
 */

/**
 * @typedef {Object} PlaceOrderParams
 * @property {string} clientOrderId
 * @property {string} symbol - e.g. USDKRW
 * @property {string} side - 'buy' | 'sell'
 * @property {string} orderType - 'MKT' | 'LMT' | 'MKTABLE_LMT'
 * @property {number} quantity - in base currency (USD for KRW→USD = buy USD)
 * @property {number} [limitPrice]
 * @property {number} [notionalKrw] - for logging
 */

/**
 * @typedef {Object} OrderResult
 * @property {boolean} ok
 * @property {string} [brokerOrderId]
 * @property {string} [status] - pending | submitted | filled | partial | cancelled | rejected
 * @property {string} [message]
 */

/**
 * @typedef {Object} Position
 * @property {string} symbol
 * @property {number} quantity
 * @property {number} [avgPrice]
 */

/**
 * @typedef {Object} CashBalance
 * @property {number} krw
 * @property {number} usd
 */

/**
 * @interface BrokerAdapter
 * @param {string} mode - 'paper' | 'live'
 */

function createBrokerAdapter(impl) {
  return {
    name: impl.name || 'unknown',
    mode: impl.mode || 'paper',

    async placeOrder(params) {
      if (!impl.placeOrder) return { ok: false, message: 'placeOrder not implemented' };
      return impl.placeOrder(params);
    },

    async cancelOrder(clientOrderId) {
      if (!impl.cancelOrder) return { ok: false, message: 'cancelOrder not implemented' };
      return impl.cancelOrder(clientOrderId);
    },

    async getOrderStatus(clientOrderId) {
      if (!impl.getOrderStatus) return { ok: false, status: 'unknown' };
      return impl.getOrderStatus(clientOrderId);
    },

    async getPositions() {
      if (!impl.getPositions) return [];
      return impl.getPositions();
    },

    async getCash() {
      if (!impl.getCash) return { krw: 0, usd: 0 };
      return impl.getCash();
    },

    async validatePair(symbol) {
      if (!impl.validatePair) return { available: true };
      return impl.validatePair(symbol);
    },
  };
}

module.exports = { createBrokerAdapter };
