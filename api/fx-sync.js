const { createClient } = require('@supabase/supabase-js');
const { runSync } = require('../lib/fxSync');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const supabase = getSupabase();
    const fredKey = process.env.FRED_API_KEY;
    if (!supabase) {
      res.status(503).json({ error: 'Supabase not configured' });
      return;
    }
    if (!fredKey) {
      res.status(503).json({ error: 'FRED not configured', hint: 'Set FRED_API_KEY' });
      return;
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const userCashKrw = body.user_cash_krw != null ? Number(body.user_cash_krw) : undefined;
    const result = await runSync(supabase, fredKey, { backfill: true, user_cash_krw: userCashKrw });
    res.status(200).json(result);
  } catch (err) {
    console.error('fx-sync', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
