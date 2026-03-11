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
    const result = await analyzer.runLiveSync(supabase);
    res.status(200).json(result);
  } catch (err) {
    console.error('analyzer/sync/live', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
