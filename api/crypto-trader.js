require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const trader = require('../lib/cryptoTrader');

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
      const config = await trader.getConfig(supabase);

      // Latest signal score
      const { data: sigData } = await supabase
        .from('fx_signal_runs')
        .select('score, decision')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Recent trades
      const { data: recentTrades } = await supabase
        .from('crypto_trade_log')
        .select('*')
        .order('executed_at', { ascending: false })
        .limit(20);

      // Last cycle result
      const { data: lastCycle } = await supabase
        .from('app_settings')
        .select('value, updated_at')
        .eq('key', 'last_cycle_result')
        .single();

      // Pi heartbeat — determine if Pi is online (seen in last 10 min)
      const { data: heartbeat } = await supabase
        .from('app_settings')
        .select('value, updated_at')
        .eq('key', 'pi_heartbeat')
        .single();

      const piLastSeen = heartbeat?.value?.lastSeen ?? null;
      const piOnline = piLastSeen
        ? (Date.now() - new Date(piLastSeen).getTime()) < 10 * 60 * 1000
        : false;

      // Manual trigger pending?
      const { data: triggerRow } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'crypto_manual_trigger')
        .single();
      const triggerPending = triggerRow?.value?.pending === true;

      // Kill switch
      const { data: ks } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'kill_switch')
        .single();

      // Portfolio snapshot — saved by Pi each cycle (Pi has Upbit keys, Vercel doesn't)
      const { data: snapshotRow } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'crypto_portfolio_snapshot')
        .single();

      const { data: fgRow } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'fear_greed')
        .single();

      const snap = snapshotRow?.value ?? {};

      return res.status(200).json({
        config,
        signalScore:      sigData?.score ?? null,
        signalDecision:   sigData?.decision ?? null,
        recentTrades:     recentTrades || [],
        lastCycle:        lastCycle?.value ?? null,
        piOnline,
        piLastSeen,
        triggerPending,
        killSwitch:       ks?.value?.enabled ?? false,
        // Portfolio data from Pi snapshot
        krwBalance:       snap.krwBalance ?? 0,
        krwBalanceUsd:    snap.krwBalanceUsd ?? null,
        usdKrw:           snap.usdKrw ?? null,
        positions:        snap.positions ?? [],
        totalValueKrw:    snap.totalValueKrw ?? null,
        totalValueUsd:    snap.totalValueUsd ?? null,
        effectiveDcaBudget: snap.effectiveDcaBudget ?? null,
        effectiveDipBudget: snap.effectiveDipBudget ?? null,
        fearGreed:        fgRow?.value ?? null,
        snapshotAge:      snap.updatedAt ? Math.round((Date.now() - new Date(snap.updatedAt).getTime()) / 1000) : null,
      });
    }

    // ── POST send trigger to Pi ─────────────────────────────────────────────
    // Vercel does NOT call Upbit directly — Pi has the allowlisted home IP.
    // We write a flag to Supabase; Pi picks it up within 10 seconds.
    if (action === 'execute' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const forceDca = body.forceDca === true;

      await supabase.from('app_settings').upsert({
        key: 'crypto_manual_trigger',
        value: { pending: true, forceDca, requestedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      return res.status(200).json({
        ok: true,
        message: 'Trigger sent — Pi trader will execute within 10 seconds',
        forceDca,
      });
    }

    // ── POST update config ──────────────────────────────────────────────────
    if (action === 'config' && req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const allowed = [
        'dca_enabled', 'weekly_budget_krw', 'dip_buy_enabled', 'dip_budget_krw',
        'coins', 'split', 'profit_take_enabled', 'signal_sell_enabled',
        'signal_buy_enabled', 'signal_boost_enabled', 'fear_greed_gate_enabled',
        'trailing_stop_enabled', 'trailing_stop_pct', 'bear_market_pause_enabled',
        'min_signal_score', 'capital_pct_mode', 'dca_pct_of_krw', 'dip_pct_of_krw',
        'max_dca_krw', 'max_dip_krw', 'dca_cooldown_days', 'stop_loss_pct',
      ];
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

    // ── POST deploy — trigger git pull + PM2 restart on Pi ────────────────
    if (action === 'deploy' && req.method === 'POST') {
      await supabase.from('app_settings').upsert({
        key: 'crypto_deploy_trigger',
        value: { pending: true, requestedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      return res.status(200).json({ ok: true, message: 'Deploy triggered — Pi will git pull and restart within 10 seconds' });
    }

    // ── GET bot logs ────────────────────────────────────────────────────────
    if (action === 'logs' && req.method === 'GET') {
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      // Exclude debug/diagnostic logs from the main log panel (too noisy)
      const { data: logs, error: logsErr } = await supabase
        .from('crypto_bot_logs')
        .select('id, level, tag, message, meta, created_at')
        .neq('level', 'debug')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (logsErr) return res.status(500).json({ error: logsErr.message });
      return res.status(200).json({ logs: logs || [] });
    }

    // ── GET sell diagnostics (last 7 days, one entry every ~15 min) ─────────
    if (action === 'diagnostics' && req.method === 'GET') {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: diags, error: diagErr } = await supabase
        .from('crypto_bot_logs')
        .select('id, tag, message, meta, created_at')
        .eq('level', 'debug')
        .eq('tag', 'sell_diag')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(500);
      if (diagErr) return res.status(500).json({ error: diagErr.message });
      return res.status(200).json({ diagnostics: diags || [] });
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=status|execute|config|kill-switch|logs|diagnostics' });
  } catch (err) {
    console.error('crypto-trader', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
