const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(503).json({ error: 'Supabase not configured' });
      return;
    }
    const days = Math.min(365, parseInt(req.query.days, 10) || 365);
    const start = new Date();
    start.setDate(start.getDate() - days);
    const startStr = start.toISOString().slice(0, 10);
    const { data: rows, error } = await supabase
      .from('fx_market_snapshots')
      .select('snapshot_date, usdkrw_spot, usdkrw_ma20, usdkrw_ma60, usdkrw_percentile_252, usd_broad_index_proxy, nasdaq100, korea_equity_proxy, vix, source_dates')
      .gte('snapshot_date', startStr)
      .order('snapshot_date', { ascending: true });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    const { data: adviceRows } = await supabase
      .from('fx_advice_runs')
      .select('snapshot_date, decision')
      .gte('snapshot_date', startStr)
      .order('snapshot_date', { ascending: true });
    const { data: convRows } = await supabase
      .from('fx_conversions')
      .select('executed_at, krw_amount, usd_amount, fx_rate')
      .order('executed_at', { ascending: true });
    const buyDates = new Set((adviceRows || []).filter((a) => a.decision === 'BUY_NOW').map((a) => a.snapshot_date));
    res.status(200).json({
      series: rows || [],
      buyMarkers: [...buyDates],
      conversions: convRows || [],
    });
  } catch (err) {
    console.error('fx-dashboard', err);
    res.status(500).json({ error: err.message });
  }
};
