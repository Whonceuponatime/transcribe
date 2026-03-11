/**
 * Interactive Brokers broker adapter.
 * Uses IBKR Client Portal Web API (REST) when gateway is running; otherwise stubs.
 * Set IBKR_GATEWAY_URL (e.g. https://localhost:5000) and ensure gateway is logged in.
 * LIVE mode only when LIVE_TRADING_ENABLED=true.
 */

const axios = require('axios');
const { createBrokerAdapter } = require('./brokerAdapter');

const DEFAULT_GATEWAY = 'https://localhost:5000';

function createIbkrBrokerAdapter(mode = 'paper') {
  const baseUrl = process.env.IBKR_GATEWAY_URL || DEFAULT_GATEWAY;
  const isLive = mode === 'live' && process.env.LIVE_TRADING_ENABLED === 'true';

  const impl = {
    name: 'ibkr',
    mode: isLive ? 'live' : 'paper',

    async placeOrder(params) {
      if (isLive) {
        try {
          const res = await axios.post(`${baseUrl}/v1/api/iserver/account/orders`, {
            acctId: process.env.IBKR_ACCOUNT_ID,
            conid: process.env.IBKR_USDKRW_CONID || 0,
            orderType: params.orderType || 'MKT',
            side: params.side?.toUpperCase(),
            quantity: params.quantity,
            price: params.limitPrice,
          }, { timeout: 10000, validateStatus: () => true });
          const data = res.data || [];
          const id = Array.isArray(data) ? data[0]?.order_id : data?.order_id;
          return { ok: !!id, brokerOrderId: id?.toString(), status: 'submitted', message: res.status === 200 ? null : res.statusText };
        } catch (err) {
          return { ok: false, message: err.message || 'IBKR gateway error', status: 'rejected' };
        }
      }
      return { ok: true, brokerOrderId: `ibkr-paper-${Date.now()}`, status: 'submitted' };
    },

    async cancelOrder(clientOrderId) {
      if (isLive) {
        try {
          await axios.delete(`${baseUrl}/v1/api/iserver/account/order/${clientOrderId}`, { timeout: 5000, validateStatus: () => true });
          return { ok: true, status: 'cancelled' };
        } catch (err) {
          return { ok: false, message: err.message };
        }
      }
      return { ok: true, status: 'cancelled' };
    },

    async getOrderStatus(clientOrderId) {
      try {
        const res = await axios.get(`${baseUrl}/v1/api/iserver/account/orders`, { timeout: 5000, validateStatus: () => true });
        const orders = res.data?.orders || [];
        const o = orders.find(x => x.order_ref === clientOrderId || x.order_id?.toString() === clientOrderId);
        if (o) return { ok: true, status: (o.status || 'unknown').toLowerCase(), filledQty: o.filled_quantity, avgPrice: o.avg_price };
      } catch (_) {}
      return { ok: false, status: 'unknown' };
    },

    async getPositions() {
      try {
        const res = await axios.get(`${baseUrl}/v1/api/portfolio/accounts`, { timeout: 5000, validateStatus: () => true });
        const accounts = res.data || [];
        const pos = [];
        for (const acc of accounts) {
          const pRes = await axios.get(`${baseUrl}/v1/api/portfolio/${acc.accountId}/positions/0`, { timeout: 5000, validateStatus: () => true });
          (pRes.data || []).forEach(p => pos.push({ symbol: p.ticker || p.assetClass, quantity: p.position, avgPrice: p.avgPrice }));
        }
        return pos;
      } catch (_) {
        return [];
      }
    },

    async getCash() {
      try {
        const res = await axios.get(`${baseUrl}/v1/api/portfolio/accounts`, { timeout: 5000, validateStatus: () => true });
        const accounts = res.data || [];
        let krw = 0, usd = 0;
        for (const acc of accounts) {
          const sRes = await axios.get(`${baseUrl}/v1/api/portfolio/${acc.accountId}/summary`, { timeout: 5000, validateStatus: () => true });
          const summary = sRes.data?.summary || {};
          const cash = summary.cashbalance?.amount ?? summary.totalcashvalue?.amount ?? 0;
          if ((summary.currency || '').toUpperCase() === 'KRW') krw += Number(cash);
          else usd += Number(cash);
        }
        return { krw, usd };
      } catch (_) {
        return { krw: 0, usd: 0 };
      }
    },

    async validatePair(symbol) {
      const pair = (symbol || '').toUpperCase();
      if (!pair.includes('USD') || !pair.includes('KRW')) return { available: false, message: 'Symbol must be USD/KRW or KRW/USD' };
      try {
        const res = await axios.get(`${baseUrl}/v1/api/iserver/secdef/search?symbol=USDKRW`, { timeout: 5000, validateStatus: () => true });
        const conids = res.data?.conids || [];
        return { available: conids.length > 0, conid: conids[0], message: conids.length ? null : 'USD/KRW not found in IBKR' };
      } catch (err) {
        return { available: false, message: err.message || 'IBKR gateway unreachable' };
      }
    },
  };

  return createBrokerAdapter(impl);
}

module.exports = { createIbkrBrokerAdapter };
