/**
 * Paper broker: simulates order execution (dry-run). No real orders.
 * Tracks "positions" and "cash" in memory for the session; for persistence use DB.
 */

const { createBrokerAdapter } = require('./brokerAdapter');

const PAPER_CASH_KRW = 50_000_000;
const PAPER_CASH_USD = 0;

function createPaperBrokerAdapter() {
  const state = {
    cashKrw: PAPER_CASH_KRW,
    cashUsd: PAPER_CASH_USD,
    positions: [],
    orders: new Map(),
    nextId: 1,
  };

  const impl = {
    name: 'paper',
    mode: 'paper',

    async placeOrder(params) {
      const id = `paper-${state.nextId++}`;
      state.orders.set(params.clientOrderId, {
        brokerOrderId: id,
        params,
        status: 'submitted',
        filledQty: 0,
        avgPrice: params.limitPrice || 0,
      });
      const qty = params.quantity || 0;
      const price = params.limitPrice || 1350;
      if (params.side === 'buy' && qty > 0) {
        const costKrw = qty * price;
        if (state.cashKrw >= costKrw) {
          state.cashKrw -= costKrw;
          state.cashUsd += qty;
          state.orders.get(params.clientOrderId).status = 'filled';
          state.orders.get(params.clientOrderId).filledQty = qty;
          state.orders.get(params.clientOrderId).avgPrice = price;
        }
      }
      return {
        ok: true,
        brokerOrderId: id,
        status: state.orders.get(params.clientOrderId).status,
      };
    },

    async cancelOrder(clientOrderId) {
      const o = state.orders.get(clientOrderId);
      if (!o) return { ok: false, message: 'Order not found' };
      if (o.status === 'pending' || o.status === 'submitted') {
        o.status = 'cancelled';
        return { ok: true, status: 'cancelled' };
      }
      return { ok: false, message: 'Order already filled or cancelled' };
    },

    async getOrderStatus(clientOrderId) {
      const o = state.orders.get(clientOrderId);
      if (!o) return { ok: false, status: 'unknown' };
      return { ok: true, status: o.status, filledQty: o.filledQty, avgPrice: o.avgPrice };
    },

    async getPositions() {
      return state.cashUsd > 0 ? [{ symbol: 'USD', quantity: state.cashUsd, avgPrice: 0 }] : [];
    },

    async getCash() {
      return { krw: state.cashKrw, usd: state.cashUsd };
    },

    async validatePair() {
      return { available: true };
    },
  };

  return createBrokerAdapter(impl);
}

module.exports = { createPaperBrokerAdapter };
