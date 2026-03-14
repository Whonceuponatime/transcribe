require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const quote = await liveTrading.getLatestQuote(supabase);
    const adapter = liveTrading.getQuoteAdapter();
    const health = adapter.getHealth();
    res.json({ quote, health, lastQuote: adapter.getLastQuote ? adapter.getLastQuote('USDKRW') : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
