require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const mode = await liveTrading.getTradingMode(supabase);
    const broker = liveTrading.getBrokerAdapter(mode);
    const cash = await broker.getCash();
    const positions = await broker.getPositions();
    const { data: latest } = await supabase
      .from('portfolio_snapshots')
      .select('*')
      .order('snapshot_ts', { ascending: false })
      .limit(1)
      .single();
    res.json({ cash, positions, snapshot: latest, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
