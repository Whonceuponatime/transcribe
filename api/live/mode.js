require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const mode = (body.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
    const set = await liveTrading.setTradingMode(supabase, mode);
    res.json({ ok: true, mode: set });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
