require('dotenv').config();
const analyzer = require('../../lib/analyzer');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const supabase = analyzer.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const result = await analyzer.getPortfolio(supabase);
    res.status(200).json(result);
  } catch (err) {
    console.error('analyzer/portfolio', err);
    res.status(500).json({ error: err.message });
  }
};
