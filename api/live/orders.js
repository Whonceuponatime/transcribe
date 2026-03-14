require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const { data } = await supabase
      .from('order_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    res.json({ orders: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
