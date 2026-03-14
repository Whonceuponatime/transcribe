require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const signal = await liveTrading.getLatestSignal(supabase);
    const mode = await liveTrading.getTradingMode(supabase);
    const killOn = await liveTrading.isKillSwitchOn(supabase);
    res.json({ signal, mode, killSwitch: killOn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
