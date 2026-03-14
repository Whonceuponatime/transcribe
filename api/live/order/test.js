require('dotenv').config();
const liveTrading = require('../../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const mode = await liveTrading.getTradingMode(supabase);
    const broker = liveTrading.getBrokerAdapter(mode);
    const safety = await liveTrading.checkSafety(supabase, {
      notionalKrw: 100000,
      quoteStaleSeconds: 10,
      spreadBps: 20,
      circuitFailureCount: 0,
    });
    if (!safety.allowed) return res.status(400).json({ ok: false, reason: safety.reason, detail: safety.detail });
    const result = await liveTrading.placeOrder(supabase, broker, {
      clientOrderId: `test-${Date.now()}`,
      symbol: 'USDKRW',
      side: 'buy',
      orderType: 'MKTABLE_LMT',
      quantity: 10,
      notionalKrw: 13500,
      limitPrice: 1355,
      idempotencyKey: `test-${Date.now()}`,
      mode,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
