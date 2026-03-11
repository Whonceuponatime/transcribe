require('dotenv').config();
const analyzer = require('../../lib/analyzer');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const supabase = analyzer.getSupabase();
    if (!supabase) {
      res.status(503).json({ error: 'Supabase not configured' });
      return;
    }
    const quote = await analyzer.getLatestQuote(supabase);
    const signal = await analyzer.getLatestSignal(supabase);
    const bars = await analyzer.getBarsForSnapshot(supabase, 500);
    const days = Math.min(365, parseInt(req.query.days, 10) || 90);
    const from = new Date();
    from.setDate(from.getDate() - days);
    const { data: snapshots } = await supabase.from('fx_analyzer_snapshots').select('*').gte('snapshot_ts', from.toISOString()).order('snapshot_ts', { ascending: true });
    const { data: signals } = await supabase.from('fx_signal_runs').select('signal_ts, decision').gte('signal_ts', from.toISOString()).order('signal_ts', { ascending: true });
    const { data: trades } = await supabase.from('fx_manual_trades').select('*').order('trade_ts', { ascending: false }).limit(50);
    const { data: health } = await supabase.from('provider_health').select('*').order('checked_at', { ascending: false }).limit(20);
    res.status(200).json({
      quote,
      signal,
      bars: bars || [],
      snapshots: snapshots || [],
      signals: signals || [],
      trades: trades || [],
      provider_health: health || [],
    });
  } catch (err) {
    console.error('analyzer/dashboard', err);
    res.status(500).json({ error: err.message });
  }
};
