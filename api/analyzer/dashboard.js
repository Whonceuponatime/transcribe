require('dotenv').config();
const analyzer = require('../../lib/analyzer');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = analyzer.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const quote = await analyzer.getLatestQuote(supabase);
    const signal = await analyzer.getLatestSignal(supabase);
    const days = Math.min(365, parseInt(req.query.days, 10) || 90);
    const from = new Date();
    from.setDate(from.getDate() - days);
    const { data: snapshots } = await supabase.from('fx_analyzer_snapshots').select('*').gte('snapshot_ts', from.toISOString()).order('snapshot_ts', { ascending: true });
    const { data: trades } = await supabase.from('fx_manual_trades').select('*').order('trade_ts', { ascending: false }).limit(50);
    const { data: health } = await supabase.from('provider_health').select('*').order('checked_at', { ascending: false }).limit(20);
    res.status(200).json({ quote, signal, snapshots: snapshots || [], trades: trades || [], provider_health: health || [] });
  } catch (err) {
    console.error('analyzer/dashboard', err);
    res.status(500).json({ error: err.message });
  }
};
