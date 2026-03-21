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

    // ── GET full log export (last 7 days, all levels & tags) ───────────────
    // Returns structured JSON you can paste into an AI for analysis and improvements.
    if (action === 'export' && req.method === 'GET') {
      const days  = Math.min(Number(req.query.days) || 7, 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const [logsRes, tradesRes, snapRes, portfolioRes] = await Promise.all([
        // All bot logs: trade, active, hourly, sell_diag, snapshot, errors
        supabase.from('crypto_bot_logs')
          .select('level, tag, message, meta, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(2000),
        // All trades in window
        supabase.from('crypto_trade_log')
          .select('*')
          .gte('executed_at', since)
          .order('executed_at', { ascending: false })
          .limit(500),
        // Latest cycle detail (indicators + portfolio)
        supabase.from('app_settings').select('value').eq('key', 'last_cycle_detail').single(),
        // Latest portfolio snapshot
        supabase.from('app_settings').select('value').eq('key', 'crypto_portfolio_snapshot').single(),
      ]);

      const logs      = logsRes.data    || [];
      const trades    = tradesRes.data  || [];
      const lastCycle = snapRes.data?.value ?? null;
      const portfolio = portfolioRes.data?.value ?? null;

      // Compute summary stats
      const tradeLogs   = logs.filter((l) => l.tag === 'trade');
      const hourlyLogs  = logs.filter((l) => l.tag === 'hourly');
      const snapshots   = logs.filter((l) => l.tag === 'snapshot');
      const sellDiags   = logs.filter((l) => l.tag === 'sell_diag');
      const errors      = logs.filter((l) => l.level === 'error');

      const totalPnlDelta = hourlyLogs.reduce((s, l) => s + (l.meta?.pnlDelta ?? 0), 0);
      const buyCount  = trades.filter((t) => t.side === 'buy').length;
      const sellCount = trades.filter((t) => t.side === 'sell').length;

      const summary = {
        exportedAt:   new Date().toISOString(),
        windowDays:   days,
        since,
        stats: {
          totalTrades:    trades.length,
          buys:           buyCount,
          sells:          sellCount,
          errorCount:     errors.length,
          snapshotCount:  snapshots.length,
          hourlyDigests:  hourlyLogs.length,
          approxPnlDeltaKrw: Math.round(totalPnlDelta),
        },
        currentPortfolio: portfolio,
        lastCycleDetail:  lastCycle,
        recentTrades:     trades.slice(0, 50),
        hourlyDigests:    hourlyLogs,
        snapshots:        snapshots.slice(0, 50),
        sellDiagnostics:  sellDiags.slice(0, 100),
        errors,
        allLogs:          logs.filter((l) => l.level !== 'debug').slice(0, 500),
      };

      res.setHeader('Content-Disposition', `attachment; filename="bot-logs-${days}d.json"`);
      return res.status(200).json(summary);
    }

    // ── GET v2 regime (EMA50/200/ADX + current classification) ─────────────
    if (action === 'regime' && req.method === 'GET') {
      let regimeData = null;
      try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'current_regime').single(); regimeData = data; } catch (_) {}
      return res.status(200).json({ regime: regimeData?.value ?? null });
    }

    // ── GET v2 positions (open, adopted, partial — all managed states) ──────────
    // Returns all active positions including adopted/unassigned ones so the
    // dashboard can show operator-action-required warnings.
    if (action === 'positions' && req.method === 'GET') {
      const { data: positions, error: posErr } = await supabase.from('positions')
        .select('*')
        .in('state', ['open', 'adopted', 'partial'])
        .order('opened_at', { ascending: false });
      if (posErr) return res.status(500).json({ error: posErr.message });

      // Enrich with current price from latest portfolio snapshot
      let snap = null;
      try { const { data: _s } = await supabase.from('app_settings').select('value').eq('key', 'v2_portfolio_snapshot').single(); snap = _s; } catch (_) {}
      const enriched = (positions || []).map((p) => {
        const priceKey = p.asset.toLowerCase();
        const valueKrw = snap?.value?.[`${priceKey}_value_krw`];
        const curPrice = p.qty_open > 0 && valueKrw ? valueKrw / p.qty_open : null;
        const gainPct  = curPrice && p.avg_cost_krw > 0 ? ((curPrice - p.avg_cost_krw) / p.avg_cost_krw) * 100 : null;
        const isProtected = p.origin === 'adopted_at_startup' && p.strategy_tag === 'unassigned';
        return {
          ...p,
          current_price_krw:  curPrice,
          unrealized_pnl_pct: gainPct,
          is_protected:       isProtected,       // fully excluded from all exit logic
          needs_classification: isProtected,      // operator action required
          cost_basis_missing: !p.avg_cost_krw || Number(p.avg_cost_krw) <= 0,
        };
      });

      return res.status(200).json({ positions: enriched });
    }

    // ── POST classify an adopted position ────────────────────────────────────
    // Operator action: assign a strategy sleeve to an adopted/unassigned position.
    //
    // classification must be one of:
    //   'core'      — retain as a long-term core holding; exits now apply normally
    //   'unmanaged' — exclude from strategy; managed=false; bot never touches it
    //
    // tactical is intentionally not available via dashboard; the bot assigns
    // tactical when it opens new positions through its own signal logic.
    //
    // avg_cost_krw (optional): set or update the cost basis for this position.
    // This unblocks exit logic which requires a valid cost basis to compute gain%.
    if (action === 'classify-position' && req.method === 'POST') {
      const { position_id, classification, avg_cost_krw, operator_note } = req.body ?? {};

      if (!position_id) {
        return res.status(400).json({ error: 'position_id is required' });
      }
      if (!['core', 'unmanaged'].includes(classification)) {
        return res.status(400).json({ error: 'classification must be core or unmanaged' });
      }

      // Fetch full position row so we can record previous values in the audit log
      const { data: pos, error: fetchErr } = await supabase.from('positions')
        .select('position_id, asset, origin, strategy_tag, state, managed, supported_universe, avg_cost_krw, operator_classified_at')
        .eq('position_id', position_id).single();
      if (fetchErr || !pos) {
        return res.status(404).json({ error: 'Position not found' });
      }

      const patch = {
        operator_classified_at: new Date().toISOString(),
        operator_note:          operator_note ?? null,
        updated_at:             new Date().toISOString(),
      };

      if (avg_cost_krw != null && Number(avg_cost_krw) > 0) {
        patch.avg_cost_krw = Number(avg_cost_krw);
      }

      if (classification === 'core') {
        // Promote to core sleeve — bot now manages exits on this position
        patch.strategy_tag = 'core';
        patch.managed      = true;
        if (pos.state === 'adopted') patch.state = 'open'; // activate it
      } else {
        // Unmanaged — exclude from all strategy logic permanently
        patch.managed      = false;
        patch.strategy_tag = 'unassigned'; // keep tag as unassigned but managed=false blocks all logic
        // Do NOT change state — position remains in DB for visibility
      }

      const { error: updateErr } = await supabase.from('positions')
        .update(patch).eq('position_id', position_id);
      if (updateErr) {
        return res.status(500).json({ error: updateErr.message });
      }

      // Log the operator action — full audit record with before/after fields
      try {
        await supabase.from('bot_events').insert({
          event_type:   'POSITION_CLASSIFIED',
          severity:     'info',
          subsystem:    'api',
          message:      `Operator classified ${pos.asset} as ${classification}: ${pos.strategy_tag} → ${patch.strategy_tag}${patch.avg_cost_krw ? ` | cost basis set ₩${Math.round(patch.avg_cost_krw).toLocaleString()}` : ''}`,
          context_json: {
            position_id,
            symbol:                pos.asset,
            previous_strategy_tag: pos.strategy_tag,
            new_strategy_tag:      patch.strategy_tag,
            previous_managed:      pos.managed,
            new_managed:           patch.managed,
            supported_universe:    pos.supported_universe,
            avg_cost_krw:          patch.avg_cost_krw ?? pos.avg_cost_krw ?? null,
            cost_basis_changed:    patch.avg_cost_krw != null,
            origin:                pos.origin,
            state_before:          pos.state,
            state_after:           patch.state ?? pos.state,
            operator_note:         operator_note ?? null,
            operator_classified_at: patch.operator_classified_at,
          },
        });
      } catch (_) {}

      return res.status(200).json({
        ok:             true,
        position_id,
        asset:          pos.asset,
        classification,
        new_strategy_tag: patch.strategy_tag,
        managed:        patch.managed,
        avg_cost_krw:   patch.avg_cost_krw ?? null,
      });
    }

    // ── GET v2 recent orders with state classification ───────────────────────
    if (action === 'orders' && req.method === 'GET') {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const { data: orders, error: ordErr } = await supabase.from('orders')
        .select('id, identifier, asset, side, state, reason, krw_requested, qty_requested, regime_at_order, mode, retry_count, error_message, created_at, updated_at')
        .order('created_at', { ascending: false }).limit(limit);
      if (ordErr) return res.status(500).json({ error: ordErr.message });
      return res.status(200).json({ orders: orders || [] });
    }

    // ── GET v2 NAV time series (for USD-proxy chart) ─────────────────────────
    if (action === 'nav' && req.method === 'GET') {
      const days = Math.min(Number(req.query.days) || 7, 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const { data: snaps, error: navErr } = await supabase.from('portfolio_snapshots_v2')
        .select('nav_krw, nav_usd_proxy, krw_pct, regime, circuit_breakers, created_at')
        .gte('created_at', since).order('created_at', { ascending: true }).limit(2000);
      if (navErr) return res.status(500).json({ error: navErr.message });
      return res.status(200).json({ snapshots: snaps || [] });
    }

    // ── GET v2 circuit breaker status ────────────────────────────────────────
    if (action === 'circuit-breakers' && req.method === 'GET') {
      let cbData = null;
      try { const { data } = await supabase.from('app_settings').select('value').eq('key', 'risk_engine_state').single(); cbData = data; } catch (_) {}
      return res.status(200).json({ circuitBreakers: cbData?.value ?? null });
    }

    // ── POST v2 config (mode + thresholds) ───────────────────────────────────
    if (action === 'v2-config' && req.method === 'POST') {
      const body = req.body ?? {};
      const allowed = ['mode', 'enabled', 'max_btc_pct', 'max_eth_pct', 'max_sol_pct',
        'max_risk_per_signal_pct', 'max_entries_per_coin_24h', 'daily_turnover_cap_pct',
        'loss_streak_limit', 'drawdown_7d_threshold', 'stop_loss_pct',
        'entry_bb_pct_uptrend', 'entry_rsi_min_uptrend', 'entry_rsi_max_uptrend',
        'exit_atr_trim1', 'exit_atr_trim2', 'exit_atr_trailing', 'exit_time_stop_hours'];
      const patch = {};
      for (const key of allowed) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No valid fields' });
      patch.updated_at = new Date().toISOString();
      const { error: cfgErr } = await supabase.from('bot_config').update(patch).not('id', 'is', null);
      if (cfgErr) return res.status(500).json({ error: cfgErr.message });
      return res.status(200).json({ ok: true, updated: patch });
    }

    // ── GET adoption + reconciliation status ─────────────────────────────────
    if (action === 'adoption' && req.method === 'GET') {
      const safe = async (query) => { try { const r = await query; return r; } catch (_) { return { data: null }; } };
      const [adoptionRow, reconRow, freezeRow, latestRunRow, latestReconRow] = await Promise.all([
        safe(supabase.from('app_settings').select('value').eq('key', 'adoption_status').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'latest_reconciliation').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'system_freeze').single()),
        safe(supabase.from('adoption_runs').select('*').order('run_at', { ascending: false }).limit(1).single()),
        safe(supabase.from('reconciliation_checks').select('*').order('run_at', { ascending: false }).limit(1).single()),
      ]);

      return res.status(200).json({
        adoption:             adoptionRow.data?.value   ?? null,
        latestRun:            latestRunRow.data         ?? null,
        reconciliation:       reconRow.data?.value      ?? null,
        latestReconciliation: latestReconRow.data       ?? null,
        systemFreeze:         freezeRow.data?.value     ?? null,
        tradingEnabled:       !(freezeRow.data?.value?.frozen ?? true),
      });
    }

    // ── POST manual clear freeze ──────────────────────────────────────────────
    // IMPORTANT: this action does NOT directly write frozen=false to the DB.
    // Directly unfreezing without a reconciliation check could allow trading
    // while a balance mismatch or unresolved order still exists.
    //
    // Instead, this action:
    //   1. Records the operator's intent in bot_events
    //   2. Queues a reconciliation trigger
    //   3. The Pi polls for reconcile_trigger within 10s, runs all checks,
    //      and clears the freeze ONLY if every check passes
    //
    // If the underlying issue has not been resolved, reconciliation will
    // re-freeze the system and the dashboard will show the updated reasons.
    if (action === 'clear-freeze' && req.method === 'POST') {
      const note = req.body?.note ?? 'operator_manual_clear';

      try {
        await supabase.from('bot_events').insert({
          event_type: 'FREEZE_CLEAR_REQUESTED', severity: 'warn', subsystem: 'api',
          message: `Operator requested freeze clear: ${note}. Queuing reconciliation.`,
        });
      } catch (_) {}

      // Queue reconciliation — Pi picks this up within 10s via pollReconcileTrigger
      await supabase.from('app_settings').upsert({
        key:        'reconcile_trigger',
        value:      { pending: true, requestedAt: new Date().toISOString(), requestedBy: note },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      return res.status(200).json({
        ok:      true,
        message: 'Reconciliation queued. The Pi will re-run all checks within 10 seconds. Freeze clears automatically if all checks pass. If the underlying issue persists, the system will remain frozen.',
      });
    }

    // ── POST run reconciliation now ────────────────────────────────────────────
    if (action === 'reconcile' && req.method === 'POST') {
      // Schedule reconciliation by setting a flag — Pi picks it up within 10s
      await supabase.from('app_settings').upsert({
        key:        'reconcile_trigger',
        value:      { pending: true, requestedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      return res.status(200).json({ ok: true, message: 'Reconciliation triggered — Pi will run within 10s' });
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=status|execute|config|v2-config|kill-switch|logs|diagnostics|export|regime|positions|classify-position|orders|nav|circuit-breakers|adoption|clear-freeze|reconcile' });
  } catch (err) {
    console.error('crypto-trader', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
