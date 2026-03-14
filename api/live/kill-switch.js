require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const enabled = body.enabled !== false && (body.enabled === true || body.enable === true);
    await liveTrading.setKillSwitch(supabase, enabled);
    res.json({ ok: true, killSwitch: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
