require('dotenv').config();
const analyzer = require('../lib/analyzer');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const action = req.query.action || '';
  const supabase = analyzer.getSupabase();
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    if (action === 'dashboard' && req.method === 'GET') {
      const quote = await analyzer.getLatestQuote(supabase);
      const signal = await analyzer.getLatestSignal(supabase);
      const days = Math.min(365, parseInt(req.query.days, 10) || 90);
      const from = new Date();
      from.setDate(from.getDate() - days);
      const { data: snapshots } = await supabase.from('fx_analyzer_snapshots').select('*').gte('snapshot_ts', from.toISOString()).order('snapshot_ts', { ascending: true });
      const { data: trades } = await supabase.from('fx_manual_trades').select('*').order('trade_ts', { ascending: false }).limit(50);
      return res.status(200).json({ quote, signal, snapshots: snapshots || [], trades: trades || [] });
    }

    if (action === 'sync-live' && req.method === 'POST') {
      const result = await analyzer.runLiveSync(supabase);
      return res.status(200).json(result);
    }

    if (action === 'sync-macro' && req.method === 'POST') {
      const result = await analyzer.runMacroSync(supabase);
      return res.status(200).json(result);
    }

    if (action === 'trade' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const result = await analyzer.recordTrade(supabase, body);
      return res.status(200).json(result);
    }

    if (action === 'crypto' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const result = await analyzer.recordCrypto(supabase, body);
      return res.status(200).json(result);
    }

    if (action === 'portfolio' && req.method === 'GET') {
      const result = await analyzer.getPortfolio(supabase);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=dashboard|sync-live|sync-macro|trade|crypto|portfolio' });
  } catch (err) {
    console.error('analyzer', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
