require('dotenv').config();
const analyzer = require('../../../lib/analyzer');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const supabase = analyzer.getSupabase();
    if (!supabase) {
      res.status(503).json({ error: 'Supabase not configured' });
      return;
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const result = await analyzer.recordTrade(supabase, body);
    res.status(200).json(result);
  } catch (err) {
    console.error('analyzer/trades/manual', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
