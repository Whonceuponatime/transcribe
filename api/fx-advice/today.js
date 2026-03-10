const { createClient } = require('@supabase/supabase-js');
const { portfolioFromConversions, unrealizedKrwValue } = require('../../lib/fxPortfolio');

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
      res.status(503).json({ error: 'Supabase not configured', hint: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY' });
      return;
    }
    const [snapRes, adviceRes, convRes] = await Promise.all([
      supabase.from('fx_market_snapshots').select('*').order('snapshot_date', { ascending: false }).limit(1).single(),
      supabase.from('fx_advice_runs').select('*').order('snapshot_date', { ascending: false }).limit(1).single(),
      supabase.from('fx_conversions').select('krw_amount, usd_amount, fx_rate').order('executed_at', { ascending: false }),
    ]);
    const snapshot = snapRes.data;
    const advice = adviceRes.data;
    const conversions = convRes.data || [];
    const portfolio = portfolioFromConversions(conversions);
    const unrealizedKrw = snapshot?.usdkrw_spot ? unrealizedKrwValue(portfolio.totalUsdAcquired, snapshot.usdkrw_spot) : 0;
    res.status(200).json({
      snapshot: snapshot || null,
      advice: advice || null,
      portfolio: { ...portfolio, unrealizedKrwValue: unrealizedKrw },
    });
  } catch (err) {
    console.error('fx-advice/today', err);
    res.status(500).json({ error: 'Failed to load FX advice', details: err.message });
  }
};
