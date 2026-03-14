require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const trader = require('../lib/cryptoTrader');
const upbit = require('../lib/upbit');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const action = req.query.action || '';

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    // ── GET status / portfolio ──────────────────────────────────────────────
    if (action === 'status' && req.method === 'GET') {
      const status = await trader.getStatus(supabase);
      return res.status(200).json(status);
    }

    // ── POST execute trade cycle ────────────────────────────────────────────
    if (action === 'execute' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const forceDca = body.forceDca === true;
      const result = await trader.executeCycle(supabase, { forceDca });
      return res.status(200).json({ ok: true, result });
    }

    // ── POST update config ──────────────────────────────────────────────────
    if (action === 'config' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const allowed = ['dca_enabled', 'weekly_budget_krw', 'coins', 'split', 'profit_take_enabled', 'signal_boost_enabled'];
      const updates = {};
      for (const key of allowed) {
        if (body[key] !== undefined) updates[key] = body[key];
      }
      await trader.saveConfig(supabase, updates);
      const config = await trader.getConfig(supabase);
      return res.status(200).json({ ok: true, config });
    }

    // ── POST kill switch ────────────────────────────────────────────────────
    if (action === 'kill-switch' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const enabled = !!body.enabled;
      await supabase.from('app_settings')
        .upsert({ key: 'kill_switch', value: { enabled }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (enabled) {
        await supabase.from('risk_events').insert({
          severity: 'critical', category: 'kill_switch',
          message: 'Kill switch activated via crypto-trader API',
          event_ts: new Date().toISOString(),
        });
      }
      return res.status(200).json({ ok: true, killSwitch: enabled });
    }

    // ── GET ping Upbit credentials ──────────────────────────────────────────
    if (action === 'ping' && req.method === 'GET') {
      const result = await upbit.ping();
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=status|execute|config|kill-switch|ping' });
  } catch (err) {
    console.error('crypto-trader', err);
    const upbitMsg = err.response?.data?.error?.message;
    res.status(500).json({ ok: false, error: upbitMsg || err.message });
  }
};
