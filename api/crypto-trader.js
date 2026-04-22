require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const reconEngine = require('../lib/reconciliationEngine');
const { buildStructuredDiagnosticsExport } = require('../lib/diagnosticStructuredExport');
// V1 (cryptoTrader.js) import removed. V2 is the only engine.

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  const action = req.query.action || '';

  const supabase = getSupabase();
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });

  try {
    // ── GET status — V2 live engine only ───────────────────────────────────
    // All state read from V2 sources: bot_config, v2_portfolio_snapshot,
    // positions table, system_freeze, current_regime, risk_engine_state.
    // V1 sources (crypto_trader_config, crypto_portfolio_snapshot,
    // last_cycle_result, fx_signal_runs, fear_greed) are not read.
    if (action === 'status' && req.method === 'GET') {
      const safe = async (q) => { try { const r = await q; return r; } catch (_) { return { data: null }; } };

      const [
        v2CfgRes, heartbeatRes, ksRes, triggerRes,
        v2SnapRes, freezeRes, regimeRes, reconRes, riskRes,
        positionsRes, recentTradesRes, liveUnresolvedRes,
      ] = await Promise.all([
        supabase.from('bot_config').select('*').limit(1).single(),
        safe(supabase.from('app_settings').select('value,updated_at').eq('key', 'pi_heartbeat').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'kill_switch').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'crypto_manual_trigger').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'v2_portfolio_snapshot').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'system_freeze').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'current_regime').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'latest_reconciliation').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'risk_engine_state').single()),
        // Include updated_at so dashboard can show how stale positions are
        supabase.from('positions').select('asset,strategy_tag,state,origin,managed,qty_open,avg_cost_krw,operator_classified_at,updated_at').in('state', ['open','adopted','partial']),
        supabase.from('v2_fills').select('asset,side,price_krw,qty,fee_krw,entry_reason,entry_regime,strategy_tag,order_id,position_id,executed_at').order('executed_at', { ascending: false }).limit(30),
        // Live unresolved order count — shows current reality independent of cached freeze reasons
        safe(supabase.from('orders').select('id', { count: 'exact', head: true }).in('state', ['intent_created','submitted','accepted','partially_filled'])),
      ]);

      const v2Cfg    = v2CfgRes.data      ?? {};
      const snap     = v2SnapRes.data?.value ?? {};
      const freeze   = freezeRes.data?.value ?? {};
      const regime   = regimeRes.data?.value ?? {};
      const recon    = reconRes.data?.value  ?? {};
      const riskSt   = riskRes.data?.value   ?? {};
      const hb       = heartbeatRes.data;

      const piLastSeen  = hb?.value?.lastSeen ?? null;
      const piOnline    = piLastSeen ? (Date.now() - new Date(piLastSeen).getTime()) < 10 * 60 * 1000 : false;

      // Build position array.
      // currentPrice: read from snapshot's per-coin price (stored by saveV2Snapshot from priceMap).
      //   Previously derived as (snapshot_value_krw / DB_qty_open) — this is WRONG when positions
      //   table is stale (e.g. after a sell whose fill was not applied). The derived price would be
      //   half the real price if DB shows 2x the actual exchange qty.
      // currentValueKrw: balance (DB qty) * currentPrice — coherent with the position row shown.
      const positions = (positionsRes.data || []).map((p) => {
        const priceKey     = p.asset.toLowerCase();
        // Prefer stored unit price; fall back to deriving it only if not yet in snapshot
        const storedPrice  = snap[`${priceKey}_price_krw`] ?? null;
        const snapValue    = snap[`${priceKey}_value_krw`]  ?? null;
        const currentPrice = storedPrice
          ?? (p.qty_open > 0 && snapValue ? snapValue / p.qty_open : null);
        const currentValueKrw = currentPrice && p.qty_open > 0
          ? currentPrice * Number(p.qty_open) : null;
        const gainPct      = currentPrice && p.avg_cost_krw > 0
          ? ((currentPrice - p.avg_cost_krw) / p.avg_cost_krw) * 100 : null;
        return {
          coin:            p.asset,
          balance:         Number(p.qty_open),
          avgBuyKrw:       p.avg_cost_krw ?? null,
          currentPrice,
          currentValueKrw,
          gainPct:         gainPct != null ? +gainPct.toFixed(2) : null,
          strategy_tag:    p.strategy_tag,
          state:           p.state,
          origin:          p.origin,
          managed:         p.managed,
          positionUpdatedAt: p.updated_at ?? null, // lets dashboard warn when position data is stale
        };
      });

      const liveUnresolvedCount = liveUnresolvedRes?.count ?? null;

      return res.status(200).json({
        // Engine identity
        engine:           'V2',
        execution_mode:   'live',
        // Pi state
        piOnline,
        piLastSeen,
        triggerPending:   triggerRes.data?.value?.pending === true,
        killSwitch:       ksRes.data?.value?.enabled ?? false,
        // V2 trading controls
        tradingEnabled:   v2Cfg.trading_enabled ?? true,
        buysEnabled:      v2Cfg.buys_enabled    ?? true,
        sellsEnabled:     v2Cfg.sells_enabled   ?? true,
        // System safety state (cached from last reconciliation run)
        systemFrozen:       freeze.frozen ?? true,
        freezeReasons:      freeze.reasons ?? [],
        freezeCachedAt:     freeze.updatedAt ?? null,     // when freeze reasons were last written
        liveUnresolvedOrders: liveUnresolvedCount,        // real-time check, independent of cache
        // Regime
        currentRegime:    regime.regime ?? null,
        regimeEma50:      regime.ema50  ?? null,
        regimeEma200:     regime.ema200 ?? null,
        regimeAdx:        regime.adxVal ?? null,
        // Portfolio (V2 sources)
        krwBalance:       snap.krw_balance  ?? 0,
        krwPct:           snap.krw_pct      ?? null,
        totalValueKrw:    snap.nav_krw      ?? null,
        totalValueUsd:    snap.nav_usd_proxy ?? null,
        positions,
        snapshotAge:      snap.created_at
          ? Math.round((Date.now() - new Date(snap.created_at).getTime()) / 1000) : null,
        snapshotAt:       snap.created_at ?? null,
        // Reconciliation
        latestReconciliation: recon,
        riskEngineState:  riskSt,
        // Recent V2 fills — gross/net explicit; entry_reason mapped to reason
        recentTrades: (recentTradesRes.data || []).map((f) => {
          const gross = f.price_krw && f.qty ? Math.round(f.price_krw * f.qty) : null;
          const fee   = f.fee_krw ? Math.round(f.fee_krw) : 0;
          return {
            coin:         f.asset,
            side:         f.side,
            gross_krw:    gross,
            fee_krw:      fee,
            net_krw:      gross != null ? gross - fee : null,
            coin_amount:  f.qty,
            price_krw:    f.price_krw,
            reason:       f.entry_reason  ?? null,   // was missing — entry_reason col → reason key
            entry_regime: f.entry_regime  ?? null,
            strategy_tag: f.strategy_tag  ?? null,
            order_id:     f.order_id      ?? null,
            position_id:  f.position_id   ?? null,
            executed_at:  f.executed_at,
            engine:       'V2',
          };
        }),
        // Full bot_config row for settings panel
        botConfig:     v2Cfg,
        // V1-era fields explicitly nulled so dashboard knows to ignore them
        config:        null,
        signalScore:   null,
        signalDecision:null,
        lastCycle:     null,
        fearGreed:     null,
      });
    }

    // ── POST backfill-orphaned-fills — repair fill audit trail ───────────────
    // Runs backfillOrphanedFills directly from the API without restarting Pi.
    // Safe to call multiple times — idempotency guard prevents double-insertion.
    if (action === 'backfill-orphaned-fills' && req.method === 'POST') {
      const result = await reconEngine.backfillOrphanedFills(supabase);
      return res.status(200).json({
        ok:      true,
        applied: result.applied ?? [],
        skipped: result.skipped ?? [],
        failed:  result.failed  ?? [],
        error:   result.error   ?? null,
      });
    }

    // ── POST trigger V2 cycle manually ──────────────────────────────────────
    // Writes to crypto_manual_trigger; Pi polls and calls runCycleV2.
    if (action === 'execute' && req.method === 'POST') {
      await supabase.from('app_settings').upsert({
        key: 'crypto_manual_trigger',
        value: { pending: true, requestedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      return res.status(200).json({ ok: true, message: 'V2 cycle triggered — Pi will execute within 10 seconds' });
    }

    // ── POST config — V1 retired ─────────────────────────────────────────────
    // The V1 crypto_trader_config table is no longer active.
    // V2 controls (trading_enabled, buys_enabled, sells_enabled) are at ?action=v2-config.
    if (action === 'config' && req.method === 'POST') {
      return res.status(410).json({
        error: 'V1 config endpoint retired. Use ?action=v2-config to update V2 trading controls.',
        v2_controls: ['trading_enabled', 'buys_enabled', 'sells_enabled', 'stop_loss_pct', 'max_btc_pct', 'max_eth_pct', 'max_sol_pct'],
      });
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

    // ── GET deploy-status — show last deploy result (git log, pm2 status) ──
    if (action === 'deploy-status' && req.method === 'GET') {
      const { data } = await supabase.from('app_settings').select('value, updated_at').eq('key', 'deploy_result').single();
      if (!data) return res.status(200).json({ ok: true, result: null });
      return res.status(200).json({ ok: true, result: { ...data.value, updated_at: data.updated_at } });
    }

    // ── POST terminal-exec — queue a shell command for the Pi to execute ──
    if (action === 'terminal-exec' && req.method === 'POST') {
      const pin = process.env.PI_TERMINAL_PIN;
      if (!pin) return res.status(503).json({ ok: false, error: 'PI_TERMINAL_PIN not configured on server' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!body.pin || body.pin !== pin) return res.status(403).json({ ok: false, error: 'Invalid PIN' });
      const cmd = (body.cmd || '').trim();
      if (!cmd) return res.status(400).json({ ok: false, error: 'Empty command' });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await supabase.from('app_settings').upsert({
        key: 'terminal_command',
        value: { pending: true, cmd, id, requestedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      return res.status(200).json({ ok: true, id });
    }

    // ── GET terminal-result — read the last command output from the Pi ─────
    if (action === 'terminal-result' && req.method === 'GET') {
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'terminal_result').single();
      if (!data) return res.status(200).json({ ok: true, result: null });
      return res.status(200).json({ ok: true, result: data.value });
    }

    // ── GET bot logs ────────────────────────────────────────────────────────
    // ── GET V2 bot event logs ─────────────────────────────────────────────
    // Reads from bot_events (V2 structured table).
    // Excludes per-cycle decision noise so only actionable events surface.
    if (action === 'logs' && req.method === 'GET') {
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      const NOISE_EVENTS = [
        'DECISION_CYCLE','DECISION_EMIT_ATTEMPT','DECISION_EMIT_SUCCESS',
        'CYCLE_START_HEARTBEAT','CYCLE_END_HEARTBEAT','SNAPSHOT_EMIT_SUCCESS',
        'RESEARCH_INDICATORS','EXIT_EVALUATION',
      ];
      const { data: logs, error: logsErr } = await supabase
        .from('bot_events')
        .select('id, event_type, severity, subsystem, message, context_json, created_at')
        .eq('mode', 'live')
        .in('severity', ['info', 'warn', 'error'])
        .not('event_type', 'in', `(${NOISE_EVENTS.map((e) => `"${e}"`).join(',')})`)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (logsErr) return res.status(500).json({ error: logsErr.message });
      return res.status(200).json({ logs: logs || [] });
    }

    // ── GET decision feed — recent DECISION_CYCLE events ─────────────────
    // Replaces the old V1 sell_diag endpoint.
    // Returns the last N DECISION_CYCLE rows across BTC/ETH/SOL so the
    // dashboard can show what the bot is evaluating every cycle.
    if (action === 'diagnostics' && req.method === 'GET') {
      const limit  = Math.min(Number(req.query.limit) || 60, 200);
      const { data: diags, error: diagErr } = await supabase
        .from('bot_events')
        .select('id, message, context_json, regime, created_at')
        .eq('event_type', 'DECISION_CYCLE')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (diagErr) return res.status(500).json({ error: diagErr.message });
      // Shape into compact rows for the dashboard
      const diagnostics = (diags || []).map((ev) => {
        const cx = ev.context_json ?? {};
        const bc = cx.buy_checks  ?? {};
        const sc = cx.sell_checks ?? {};
        return {
          id:             ev.id,
          created_at:     ev.created_at,
          symbol:         cx.symbol         ?? null,
          price:          cx.price          ?? null,
          regime:         cx.regime ?? ev.regime ?? null,
          qty_open:       cx.qty_open       ?? null,
          avg_cost_krw:   cx.avg_cost_krw   ?? null,
          pnl_percent:    cx.pnl_percent    ?? null,
          final_action:   cx.final_action   ?? null,
          final_reason:   cx.final_reason   ?? null,
          sell_blocker:   sc.final_sell_blocker ?? null,
          // buy_blocker: full reason string (not collapsed to 'signal_not_met')
          buy_blocker:    Object.keys(bc).length > 0 && !bc.final_buy_eligible
            ? (cx.final_reason ?? 'blocked') : null,
          risk_blocker:   bc.risk_blocker   ?? null,
          rsi:            bc.rsi    ?? sc.rsi    ?? null,
          bb_pctB:        bc.bb_pctB ?? sc.bb_pctB ?? null,
          ob_imbalance:   bc.ob_imbalance   ?? null,
          cycle_id:       cx.cycle_id       ?? null,
          // Effective runtime thresholds
          effective_bb_threshold: bc.effective_bb_threshold    ?? null,
          effective_ob_threshold: bc.effective_ob_imbalance_min ?? null,
          adaptive_signals:       bc.adaptive_offsets_applied?.signals ?? null,
          micro_bypassed:         bc.micro_bypassed    ?? null,
          pos_notional_krw:       bc.pos_notional_krw  ?? null,
          // Starter-into-existing diagnostics (migration 036 + diagnostics patch)
          starter_into_existing_attempted:   bc.starter_into_existing_attempted   ?? null,
          starter_into_existing_passed:      bc.starter_into_existing_passed      ?? null,
          starter_into_existing_blocker:     bc.starter_into_existing_blocker     ?? null,
          starter_addon_size_mult_effective: bc.starter_addon_size_mult_effective ?? null,
          starter_cooldown_ms_effective:     bc.starter_cooldown_ms_effective     ?? null,
          existing_position_strategy_tag:    bc.existing_position_strategy_tag    ?? null,
          route_to_existing_position:        bc.route_to_existing_position        ?? null,
          // Tactical profit-floor (lib/cryptoTraderV2 sell_checks) — explicit for exports/dashboard
          tactical_profit_floor_considered: sc.tactical_profit_floor_considered ?? null,
          tactical_profit_floor_blocker:    sc.tactical_profit_floor_blocker    ?? null,
          tactical_profit_floor_would_fire: sc.tactical_profit_floor_would_fire ?? null,
          tactical_profit_floor_fired:      sc.tactical_profit_floor_fired      ?? null,
          // Post-trim runner partial exit diagnostics
          post_trim_runner_considered:      sc.post_trim_runner_considered      ?? null,
          post_trim_runner_blocker:         sc.post_trim_runner_blocker         ?? null,
          post_trim_runner_would_fire:      sc.post_trim_runner_would_fire      ?? null,
          post_trim_runner_in_exits:        sc.post_trim_runner_in_exits        ?? null,
          post_trim_runner_fired:           sc.post_trim_runner_fired           ?? null,
          // Runner protection diagnostics
          runner_protect_considered:        sc.runner_protect_considered        ?? null,
          runner_protect_blocker:           sc.runner_protect_blocker           ?? null,
          runner_protect_peak_net_pct:      sc.runner_protect_peak_net_pct      ?? null,
          runner_protect_would_fire:        sc.runner_protect_would_fire        ?? null,
          runner_protect_fired:             sc.runner_protect_fired             ?? null,
        };
      });
      return res.status(200).json({ diagnostics });
    }

    // ── GET full log export ────────────────────────────────────────────────
    // Covers all logging tables: crypto_bot_logs, bot_events,
    // reconciliation_checks, adoption_runs, positions, v1 trade log,
    // and key app_settings snapshots.
    // Paste the downloaded JSON into an AI for full analysis.
    if (action === 'export' && req.method === 'GET') {
      const days  = Math.min(Number(req.query.days) || 7, 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const safe  = async (q) => { try { const r = await q; return r; } catch (_) { return { data: null }; } };

      const [
        botLogsRes, botEventsRes, tradesRes,
        reconRes, adoptionRes, positionsRes,
        v2OrdersRes, lastCycleRes, portfolioRes,
        freezeRes, reconStatusRes, v2ConfigRes,
      ] = await Promise.all([
        // V1 cycle logs
        supabase.from('crypto_bot_logs')
          .select('level, tag, message, meta, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(1000),
        // V2 structured events
        supabase.from('bot_events')
          .select('event_type, severity, subsystem, message, context_json, regime, mode, created_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(1000),
        // V1 trades — these are ALWAYS live account mutations (V1 has no paper mode)
        supabase.from('crypto_trade_log')
          .select('coin, side, krw_amount, coin_amount, price_krw, reason, signal_score, executed_at')
          .gte('executed_at', since)
          .order('executed_at', { ascending: false })
          .limit(500),
        // Reconciliation runs
        supabase.from('reconciliation_checks')
          .select('status, freeze_reasons, checks_run, trading_enabled, open_orders_found, discrepancies, run_at')
          .gte('run_at', since)
          .order('run_at', { ascending: false })
          .limit(50),
        // Adoption runs
        supabase.from('adoption_runs')
          .select('status, adopted_count, skipped_count, unsupported_count, adopted_assets, unsupported_assets, error_message, run_at, completed_at')
          .order('run_at', { ascending: false })
          .limit(10),
        // Current positions
        supabase.from('positions')
          .select('position_id, asset, strategy_tag, state, origin, managed, supported_universe, qty_open, avg_cost_krw, operator_classified_at, operator_note, opened_at, updated_at'),
        // V2 orders — includes engine source (always V2) and mode (paper/shadow/live)
        supabase.from('orders')
          .select('id, identifier, asset, side, state, reason, krw_requested, qty_requested, mode, strategy_tag, regime_at_order, retry_count, error_message, created_at, updated_at')
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(500),
        // Latest V1 cycle detail
        safe(supabase.from('app_settings').select('value').eq('key', 'last_cycle_detail').single()),
        // Latest V2 portfolio snapshot
        safe(supabase.from('app_settings').select('value').eq('key', 'v2_portfolio_snapshot').single()),
        // Current freeze state
        safe(supabase.from('app_settings').select('value').eq('key', 'system_freeze').single()),
        // Latest reconciliation summary
        safe(supabase.from('app_settings').select('value').eq('key', 'latest_reconciliation').single()),
        // V2 bot_config (trading controls)
        safe(supabase.from('bot_config').select('mode, enabled, coins, trading_enabled, buys_enabled, sells_enabled').limit(1).single()),
      ]);

      const botLogs      = botLogsRes.data    || [];
      const botEvents    = botEventsRes.data   || [];
      const v1Trades     = tradesRes.data      || [];
      const reconRuns    = reconRes.data        || [];
      const adoptionRuns = adoptionRes.data     || [];
      const positions    = positionsRes.data    || [];
      const v2Orders     = v2OrdersRes.data     || [];
      const v2CurrentMode     = 'live'; // always live in production
      const v2TradingEnabled  = v2ConfigRes.data?.trading_enabled ?? true;
      const v2BuysEnabled     = v2ConfigRes.data?.buys_enabled    ?? true;
      const v2SellsEnabled    = v2ConfigRes.data?.sells_enabled   ?? true;

      // ── Index by tag / type ──────────────────────────────────────────────
      const v1ByTag  = {};
      for (const log of botLogs) {
        if (!v1ByTag[log.tag]) v1ByTag[log.tag] = [];
        v1ByTag[log.tag].push(log);
      }
      const v2ByType = {};
      for (const ev of botEvents) {
        if (!v2ByType[ev.event_type]) v2ByType[ev.event_type] = [];
        v2ByType[ev.event_type].push(ev);
      }

      // ── Order source analysis (Q1, Q2, Q3) ───────────────────────────────
      const v1HasTrades       = v1Trades.length > 0;
      const v2LiveOrders      = v2Orders.filter((o) => o.mode === 'live');
      const v2PaperOrders     = v2Orders.filter((o) => o.mode === 'paper' || o.mode === 'shadow');
      const v2HasLiveOrders   = v2LiveOrders.length > 0;
      const v2HasAnyOrders    = v2Orders.length > 0;

      const liveMutationsDetected = v1HasTrades || v2HasLiveOrders;

      // ── Mode coherence analysis ───────────────────────────────────────────
      // The top-level v2CurrentMode comes from bot_config (the DB right now).
      // V2 events each carry the mode that was active WHEN they were written.
      // These can differ if mode was changed between events and the export.
      const v2EventModesInWindow = [...new Set(
        botEvents.filter((e) => e.mode).map((e) => e.mode)
      )];
      const modeChangedDuringWindow = v2EventModesInWindow.length > 1
        || (v2EventModesInWindow.length === 1 && !v2EventModesInWindow.includes(v2CurrentMode));

      const modeCoherence = {
        db_mode_at_export_time:          v2CurrentMode,
        modes_seen_in_events_this_window: v2EventModesInWindow,
        mode_changed_during_window:       modeChangedDuringWindow,
        explanation: v2EventModesInWindow.length === 0
          ? 'No V2 events with mode field in this window. Mode coherence cannot be verified from events — Pi may not have run V2 cycles yet or bot_events was recently cleared.'
          : modeChangedDuringWindow
            ? `DB mode is now "${v2CurrentMode}" but V2 events in this window were written with mode="${v2EventModesInWindow.join(' / ')}". Mode was changed in the DB after those events were written. Historical events reflect the correct mode at decision time.`
            : `Mode is consistent: all V2 events and DB show mode="${v2CurrentMode}".`,
      };

      // ── Strict mixed-mode risk calculation ───────────────────────────────
      // Mixed-mode risk = V1 placed real trades while V2 was NOT in live mode.
      // The previous check used CURRENT db mode, which is wrong if mode changed
      // after the V1 trades. We use the historical mode from events instead.
      //
      // V2 was in paper/shadow mode during this window if:
      //   a) V2 events show mode=paper/shadow, OR
      //   b) V2 placed no live orders (regardless of current DB mode), OR
      //   c) Current DB mode is still paper
      const v2WasPaperDuringWindow =
        v2EventModesInWindow.includes('paper') ||
        v2EventModesInWindow.includes('shadow') ||
        (v2EventModesInWindow.length === 0 && !v2HasLiveOrders) || // no events = no evidence of live
        (!v2HasLiveOrders && v2CurrentMode !== 'live');             // no live orders placed

      const mixedModeRisk = v1HasTrades && (
        v2CurrentMode === 'paper'           ||   // currently paper
        v2WasPaperDuringWindow              ||   // was paper when V1 traded
        (!v2HasAnyOrders && v2CurrentMode !== 'live')  // V2 was not operating live
      );

      // ── V1 suppression analysis ───────────────────────────────────────────
      // V1 suppression is DB-driven (isV1Suppressed reads bot_config every cycle)
      // and does NOT require a Pi restart. When mode=live, V1 should stop on its
      // next cycle. V1 trades timestamped BEFORE the mode change are expected.
      const v1ShouldBeSuppressed       = v2CurrentMode === 'live';
      const v1SuppressionViolationRisk = v1ShouldBeSuppressed && v1HasTrades;
      // Check if V1 trades are newer than any V2 'live' event (would indicate suppression failure)
      const latestV2LiveEvent   = botEvents.filter((e) => e.mode === 'live').sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      const latestV1Trade       = v1Trades[0]; // already sorted desc
      const v1TradesAfterLiveMode = latestV2LiveEvent && latestV1Trade
        && new Date(latestV1Trade.executed_at) > new Date(latestV2LiveEvent.created_at);

      const v1SuppressionAnalysis = {
        v1_should_be_suppressed:          v1ShouldBeSuppressed,
        v1_trades_in_window:              v1Trades.length,
        suppression_violation_risk:       v1SuppressionViolationRisk,
        v1_trades_after_live_mode_change: v1TradesAfterLiveMode,
        v1_most_recent_trade_at:          latestV1Trade?.executed_at ?? null,
        explanation: v1SuppressionViolationRisk
          ? v1TradesAfterLiveMode
            ? `SUPPRESSION FAILURE: V1 trades found AFTER V2 switched to live mode. V1 should be suppressed. Pi may not have read the mode change yet or isV1Suppressed() is not working.`
            : `V1 trades found in window but they appear to predate the mode change to live. V1 suppression is likely working correctly now — trades are historical.`
          : v1ShouldBeSuppressed
            ? `V2 is live — V1 is suppressed. No V1 trades in window.`
            : `V2 is in ${v2CurrentMode} mode — V1 is expected to be active alongside V2.`,
      };

      let orderSourceSummary;
      if (v1HasTrades && v2HasAnyOrders) orderSourceSummary = 'both';
      else if (v1HasTrades)              orderSourceSummary = 'V1_only';
      else if (v2HasAnyOrders)           orderSourceSummary = 'V2_only';
      else                               orderSourceSummary = 'neither';

      // ── Audit diagnostics — explain WHY events may be empty ──────────────
      const lastRecon    = reconRuns[0] ?? null;
      const lastAdoption = adoptionRuns[0] ?? null;
      const v2WasFrozenEntireWindow = (v2ByType['CYCLE_FROZEN'] || []).length > 0
        && (v2ByType['FREEZE_STATE_CHANGED'] || []).filter((e) => e.context_json?.new_frozen === false).length === 0;

      const adoptionImportCount = (v2ByType['ADOPTION_IMPORT'] || []).length
                                + (v2ByType['ADOPTION_ALREADY_COMPLETE'] || []).length;

      const auditDiagnostics = {
        // Q4: ADOPTION_IMPORT empty
        adoptionAuditCoverage: {
          adoption_import_events:              (v2ByType['ADOPTION_IMPORT']           || []).length,
          adoption_already_complete_events:    (v2ByType['ADOPTION_ALREADY_COMPLETE'] || []).length,
          total_adoption_evidence:             adoptionImportCount,
          adopted_positions_in_db:             positions.filter((p) => p.origin === 'adopted_at_startup').length,
          gap_detected:                        adoptionImportCount === 0 && positions.some((p) => p.origin === 'adopted_at_startup'),
          likely_cause:                        adoptionImportCount === 0
            ? 'bot_events was TRUNCATED after adoption ran. ADOPTION_IMPORT events from the original run were wiped. On next restart, ADOPTION_ALREADY_COMPLETE will be emitted instead.'
            : null,
        },
        // Q5: POSITION_CLASSIFIED incomplete
        classificationAuditCoverage: {
          position_classified_events:          (v2ByType['POSITION_CLASSIFIED'] || []).length,
          core_positions_in_db:                positions.filter((p) => p.strategy_tag === 'core').length,
          gap_detected:                        (v2ByType['POSITION_CLASSIFIED'] || []).length < positions.filter((p) => p.strategy_tag === 'core').length,
          likely_cause:                        (v2ByType['POSITION_CLASSIFIED'] || []).length < positions.filter((p) => p.strategy_tag === 'core').length
            ? 'Some classifications happened before the API .catch() bug was fixed (the 500 error meant the DB update succeeded but the bot_events insert was never reached). Future classifications will log correctly.'
            : null,
        },
        // Q6: EXIT_EVALUATION / POSITION_SKIP_PROTECTED / EXECUTION empty
        sellCycleAuditCoverage: (() => {
          const exitEvalCount    = (v2ByType['EXIT_EVALUATION']         || []).length;
          const skipProtCount    = (v2ByType['POSITION_SKIP_PROTECTED'] || []).length;
          const executionCount   = (v2ByType['EXECUTION']               || []).length;
          const cycleFrozenCount = (v2ByType['CYCLE_FROZEN']            || []).length;
          const allEmpty         = exitEvalCount === 0 && executionCount === 0;
          const hasCorePositions = positions.filter((p) => p.strategy_tag === 'core' && p.managed).length > 0;

          // Decision tree for root cause
          let likelyCause = null;
          if (allEmpty) {
            if (v2WasFrozenEntireWindow || cycleFrozenCount > 0) {
              likelyCause = 'FROZEN: V2 was frozen this entire window. executeCycleV2 returns before reaching sell logic. See CYCLE_FROZEN and RECONCILIATION events. Unfreeze to restore sell-cycle logging.';
            } else if (v2EventModesInWindow.length === 0 && !v2HasAnyOrders) {
              likelyCause = 'OLD_CODE_OR_NOT_STARTED: No V2 events at all in window. Either the Pi has not pulled the latest code (git pull + restart required), V2 cycles have not run yet, or bot_events was recently truncated. EXIT_EVALUATION logging was added in a recent deploy.';
            } else if (hasCorePositions) {
              likelyCause = 'UNDERWATER_POSITIONS: Core positions exist but are below required profit edge (fees + 0.20% buffer). EXIT_EVALUATION only fires on the 30-minute rate-limit timer — this requires the Pi to run at least one cycle with the new code deployed.';
            } else {
              likelyCause = 'NO_MANAGED_POSITIONS: No core managed positions found. V2 sell cycle has nothing to evaluate.';
            }
          }

          return {
            exit_evaluation_events:         exitEvalCount,
            position_skip_protected_events: skipProtCount,
            execution_events:               executionCount,
            cycle_frozen_events:            cycleFrozenCount,
            v2_frozen_entire_window:        v2WasFrozenEntireWindow,
            core_managed_positions:         hasCorePositions,
            gap_detected:                   allEmpty,
            likely_cause:                   likelyCause,
          };
        })(),
        // Q3: Live mutations while V2 was paper (uses strict historical detection)
        mixedModeAnalysis: {
          v1_live_trades_in_window:            v1Trades.length,
          v2_mode_at_export_time_db:           v2CurrentMode,
          v2_modes_seen_in_events:             v2EventModesInWindow,
          v2_was_paper_during_window:          v2WasPaperDuringWindow,
          v2_live_orders_in_window:            v2LiveOrders.length,
          v2_paper_orders_in_window:           v2PaperOrders.length,
          mixed_mode_risk:                     mixedModeRisk,
          mixed_mode_risk_explanation:         mixedModeRisk
            ? 'V1 placed real trades while V2 was not in live mode. V2 position quantities diverged from exchange. This caused balance_mismatch reconciliation freeze. Fix: sync qty_open in DB then click Reconcile.'
            : v1HasTrades && v2CurrentMode === 'live'
              ? 'V1 trades found but V2 is now live. Risk was present historically. Check v1SuppressionAnalysis to confirm V1 is fully suppressed going forward.'
              : 'No mixed-mode risk detected in this window.',
        },
      };

      // ── Reconstructed adoption timeline (A) ──────────────────────────────
      // Built from DB columns regardless of whether bot_events exist.
      // Answers: which positions were adopted, when, from which run, and whether
      // evidence is direct (bot_events) or reconstructed (DB columns only).
      const allAdoptionRuns = adoptionRuns; // all runs, not window-scoped
      const reconstructedAdoptionTimeline = positions
        .filter((p) => p.origin === 'adopted_at_startup')
        .map((p) => {
          const directImportEvent = (v2ByType['ADOPTION_IMPORT'] || [])
            .find((e) => e.context_json?.position_id === p.position_id);
          const replayEvent = (v2ByType['ADOPTION_ALREADY_COMPLETE'] || [])
            .find((e) => (e.context_json?.current_positions || []).some((cp) => cp.asset === p.asset));
          // Find which adoption run imported this position
          const adoptionRun = allAdoptionRuns.find((r) =>
            (r.adopted_assets || []).some((a) => a.currency === p.asset)
          );
          const posOpenedAt   = p.opened_at ? new Date(p.opened_at) : null;
          const runStartedAt  = adoptionRun?.run_at ? new Date(adoptionRun.run_at) : null;
          return {
            asset:                      p.asset,
            position_id:                p.position_id,
            first_seen_as_adopted_at:   p.opened_at,
            adoption_run_id:            p.adoption_run_id ?? adoptionRun?.id ?? null,
            adoption_run_found_in_records: !!adoptionRun,
            position_predated_current_run: posOpenedAt && runStartedAt && posOpenedAt < runStartedAt,
            current_strategy_tag:       p.strategy_tag,
            current_state:              p.state,
            operator_classified_at:     p.operator_classified_at ?? null,
            evidence_source:            directImportEvent ? 'direct_event'
                                        : replayEvent    ? 'replay_event'
                                        : 'db_only',
            evidence_reconstructed:     !directImportEvent,
            note: !adoptionRun
              ? 'Position predates export window or adoption_runs was truncated — position data is DB-authoritative.'
              : null,
          };
        });

      // ── Reconstructed classification history (B) ──────────────────────────
      // For every managed position, show current tag, when it was classified,
      // and whether a POSITION_CLASSIFIED event exists.
      const reconstructedClassificationHistory = positions
        .filter((p) => p.managed)
        .map((p) => {
          const classifyEvent = (v2ByType['POSITION_CLASSIFIED'] || [])
            .find((e) => e.context_json?.position_id === p.position_id);
          let evidenceSource;
          if (classifyEvent)                evidenceSource = 'direct_event';
          else if (p.operator_classified_at) evidenceSource = 'db_only';
          else if (p.strategy_tag !== 'unassigned') evidenceSource = 'db_only_no_timestamp';
          else                               evidenceSource = 'unclassified';

          return {
            position_id:                p.position_id,
            asset:                      p.asset,
            current_strategy_tag:       p.strategy_tag,
            managed:                    p.managed,
            supported_universe:         p.supported_universe,
            operator_classified_at:     p.operator_classified_at ?? null,
            classification_event_present: !!classifyEvent,
            evidence_source:            evidenceSource,
            classification_event:       classifyEvent
              ? {
                  previous_strategy_tag: classifyEvent.context_json?.previous_strategy_tag,
                  new_strategy_tag:      classifyEvent.context_json?.new_strategy_tag,
                  cost_basis_changed:    classifyEvent.context_json?.cost_basis_changed,
                  operator_note:         classifyEvent.context_json?.operator_note,
                }
              : null,
            note: !classifyEvent && p.strategy_tag !== 'unassigned'
              ? 'No POSITION_CLASSIFIED event found. Classification likely happened before the logging fix was deployed (API .catch() bug). DB columns are authoritative.'
              : null,
          };
        });

      // ── Audit completeness grade (E) ──────────────────────────────────────
      const adoptedPositions         = positions.filter((p) => p.origin === 'adopted_at_startup');
      const corePositions            = positions.filter((p) => p.strategy_tag === 'core');
      const adoptionEvidenceCount    = (v2ByType['ADOPTION_IMPORT'] || []).length
                                     + (v2ByType['ADOPTION_ALREADY_COMPLETE'] || []).length;
      const classificationEventCount = (v2ByType['POSITION_CLASSIFIED'] || []).length;
      const exitEvalCount            = (v2ByType['EXIT_EVALUATION'] || []).length;
      const reconEventCount          = (v2ByType['RECONCILIATION'] || []).length
                                     + (v2ByType['FREEZE_STATE_CHANGED'] || []).length;

      const adoptionHistoryComplete       = adoptedPositions.length === 0 || adoptionEvidenceCount > 0 || reconstructedAdoptionTimeline.length > 0;
      const classificationHistoryComplete = corePositions.every((p) =>
        (v2ByType['POSITION_CLASSIFIED'] || []).some((e) => e.context_json?.position_id === p.position_id)
        || !!p.operator_classified_at
      );
      const v2DecisionPathVisible         = exitEvalCount > 0 || (v2ByType['CYCLE_FROZEN'] || []).length > 0;
      const freezeHistoryVisible          = reconEventCount > 0;

      const grades = [adoptionHistoryComplete, classificationHistoryComplete, v2DecisionPathVisible, freezeHistoryVisible];
      const gradeScore = grades.filter(Boolean).length;
      const overallAuditGrade = gradeScore === 4 ? 'A — complete'
                              : gradeScore === 3 ? 'B — mostly complete, minor gaps'
                              : gradeScore === 2 ? 'C — partial, key gaps present'
                              : gradeScore === 1 ? 'D — mostly incomplete'
                              : 'F — no audit evidence';

      const auditCompleteness = {
        adoption_history_complete:       adoptionHistoryComplete,
        classification_history_complete: classificationHistoryComplete,
        v2_decision_path_visible:        v2DecisionPathVisible,
        freeze_history_visible:          freezeHistoryVisible,
        overall_audit_grade:             overallAuditGrade,
        notes: {
          adoption:       adoptionEvidenceCount === 0 && adoptedPositions.length > 0
            ? 'No bot_events for adoption. Positions exist in DB — reconstructed timeline is authoritative. Pull & Restart Pi to generate ADOPTION_ALREADY_COMPLETE event.'
            : null,
          classification: classificationEventCount < corePositions.length
            ? `${corePositions.length - classificationEventCount} of ${corePositions.length} core positions have no POSITION_CLASSIFIED event. Classified via DB only. See reconstructedClassificationHistory.`
            : null,
          decisionPath:   !v2DecisionPathVisible
            ? 'No EXIT_EVALUATION or CYCLE_FROZEN events. Either V2 has not run yet, positions have not been evaluated this window, or bot_events was recently truncated. Pull & Restart Pi to generate fresh evidence.'
            : null,
        },
      };

      // ── Summary stats ─────────────────────────────────────────────────────
      const buyCount  = v1Trades.filter((t) => t.side === 'buy').length;
      const sellCount = v1Trades.filter((t) => t.side === 'sell').length;
      const hourlyLogs = v1ByTag['hourly'] || [];
      const totalPnlDelta = hourlyLogs.reduce((s, l) => s + (l.meta?.pnlDelta ?? 0), 0);

      const summary = {
        exportedAt:  new Date().toISOString(),
        windowDays:  days,
        since,

        // ── Engine + mutation summary ─────────────────────────────────────
        // V2 is the only engine. V1 is removed. execution_mode is always live.
        engine:               'V2',
        execution_mode:       'live',
        orderSourceSummary,
        liveAccountMutationsDetected: liveMutationsDetected,
        // mixedModeRisk is no longer applicable — V1 is removed
        mixedModeRisk:        false,
        v1Status:             v1HasTrades ? 'V1_TRADES_FOUND_IN_WINDOW — investigate if unexpected' : 'no_v1_trades',

        // ── Current system state ──────────────────────────────────────────
        systemState: {
          execution_mode:       v2CurrentMode,
          trading_enabled:      v2TradingEnabled,
          buys_enabled:         v2BuysEnabled,
          sells_enabled:        v2SellsEnabled,
          freezeState:          freezeRes.data?.value ?? null,
          latestReconciliation: reconStatusRes.data?.value ?? null,
          v2Portfolio:          portfolioRes.data?.value ?? null,
        },

        // ── Audit completeness grade ──────────────────────────────────────
        auditCompleteness,

        // ── Audit diagnostics (Q4–Q6) ─────────────────────────────────────
        auditDiagnostics,

        // ── Reconstructed adoption timeline (A) ───────────────────────────
        reconstructedAdoptionTimeline,

        // ── Reconstructed classification history (B) ──────────────────────
        reconstructedClassificationHistory,

        // ── Current positions ─────────────────────────────────────────────
        positions,

        // ── Stats ─────────────────────────────────────────────────────────
        stats: {
          v1Trades:             v1Trades.length,
          v1Buys:               buyCount,
          v1Sells:              sellCount,
          v1HourlyPnlDeltaKrw:  Math.round(totalPnlDelta),
          v2OrdersTotal:        v2Orders.length,
          v2OrdersLive:         v2LiveOrders.length,
          v2OrdersPaper:        v2PaperOrders.length,
          v2EventCount:         botEvents.length,
          reconRuns:            reconRuns.length,
          lastReconPassed:      lastRecon?.trading_enabled ?? null,
          adoptionRuns:         adoptionRuns.length,
          lastAdoptionStatus:   lastAdoption?.status ?? null,
          protectedPositions:   positions.filter((p) => p.origin === 'adopted_at_startup' && p.strategy_tag === 'unassigned').length,
          corePositions:        positions.filter((p) => p.strategy_tag === 'core').length,
          managedPositions:     positions.filter((p) => p.managed).length,
        },

        // ── V2 bot_events by type ─────────────────────────────────────────
        v2Events: {
          RECONCILIATION:          v2ByType['RECONCILIATION']          || [],
          FREEZE_STATE_CHANGED:    v2ByType['FREEZE_STATE_CHANGED']    || [],
          FREEZE_CLEARED:          v2ByType['FREEZE_CLEARED']          || [],
          FREEZE_CLEAR_REQUESTED:  v2ByType['FREEZE_CLEAR_REQUESTED']  || [],
          CYCLE_FROZEN:            v2ByType['CYCLE_FROZEN']            || [],
          REGIME_SWITCH:           v2ByType['REGIME_SWITCH']           || [],
          ADOPTION_IMPORT:         v2ByType['ADOPTION_IMPORT']         || [],
          ADOPTION_ALREADY_COMPLETE: v2ByType['ADOPTION_ALREADY_COMPLETE'] || [],
          ADOPTION_UNSUPPORTED:    v2ByType['ADOPTION_UNSUPPORTED']    || [],
          POSITION_CLASSIFIED:     v2ByType['POSITION_CLASSIFIED']     || [],
          POSITION_SKIP_PROTECTED: v2ByType['POSITION_SKIP_PROTECTED'] || [],
          EXIT_EVALUATION:         v2ByType['EXIT_EVALUATION']         || [],
          EXECUTION:               v2ByType['EXECUTION']               || [],
          CYCLE_ERROR:             v2ByType['CYCLE_ERROR']             || [],
          other: botEvents.filter((e) => ![
            'RECONCILIATION','FREEZE_STATE_CHANGED','FREEZE_CLEARED','FREEZE_CLEAR_REQUESTED',
            'CYCLE_FROZEN','REGIME_SWITCH','ADOPTION_IMPORT','ADOPTION_ALREADY_COMPLETE',
            'ADOPTION_UNSUPPORTED','POSITION_CLASSIFIED','POSITION_SKIP_PROTECTED',
            'EXIT_EVALUATION','EXECUTION','CYCLE_ERROR','RESEARCH_INDICATORS',
          ].includes(e.event_type)),
        },

        // ── V2 orders (engine=V2, mode tagged per order) ──────────────────
        v2Orders: {
          all:    v2Orders,
          live:   v2LiveOrders,
          paper:  v2PaperOrders,
        },

        // ── Reconciliation history ────────────────────────────────────────
        reconciliationRuns: reconRuns,

        // ── Adoption history ──────────────────────────────────────────────
        adoptionRuns,

        // ── V1 trades (engine=V1, always live) ───────────────────────────
        v1Trades,

        // ── V1 logs by tag ────────────────────────────────────────────────
        v1Logs: {
          adoption:  v1ByTag['adoption']  || [],
          reconcile: v1ByTag['reconcile'] || [],
          trade:     v1ByTag['trade']     || [],
          active:    v1ByTag['active']    || [],
          hourly:    v1ByTag['hourly']    || [],
          snapshot:  (v1ByTag['snapshot'] || []).slice(0, 20),
          sell_diag: v1ByTag['sell_diag'] || [],
          error:     v1ByTag['error']     || [],
        },
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

    // ── POST v2 config (live-only controls + thresholds) ─────────────────────
    // 'mode' is not settable — always 'live' in production.
    if (action === 'v2-config' && req.method === 'POST') {
      const body = req.body ?? {};
      const allowed = [
        // Live trading controls (granular on/off without paper mode)
        'trading_enabled', 'buys_enabled', 'sells_enabled',
        // Exposure limits
        'max_btc_pct', 'max_eth_pct', 'max_sol_pct',
        'max_risk_per_signal_pct', 'max_entries_per_coin_24h', 'daily_turnover_cap_pct',
        'loss_streak_limit', 'drawdown_7d_threshold', 'stop_loss_pct',
        // Signal thresholds
        'entry_bb_pct_uptrend', 'entry_rsi_min_uptrend', 'entry_rsi_max_uptrend',
        'exit_atr_trim1', 'exit_atr_trim2', 'exit_atr_trailing', 'exit_time_stop_hours',
      ];
      const patch = {};
      for (const key of allowed) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No valid fields' });
      patch.updated_at = new Date().toISOString();
      // Fetch the singleton row's ID first so the update is always targeted by PK.
      // Previously used .not('id','is',null) which updated every row in the table.
      const { data: cfgRow } = await supabase.from('bot_config').select('id').limit(1).single();
      if (!cfgRow?.id) return res.status(500).json({ error: 'bot_config row not found' });
      const { error: cfgErr } = await supabase.from('bot_config').update(patch).eq('id', cfgRow.id);
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

    // ── GET diagnostic export — missed-trade decision audit ───────────────────
    // Clean per-symbol per-cycle decision rows for BTC, ETH, SOL.
    // Shows exactly why each buy or sell was blocked or executed.
    if (action === 'diagnostic-export' && req.method === 'GET') {
      const hours  = Math.min(Number(req.query.hours) || 24, 72);
      const since  = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const COINS  = ['BTC', 'ETH'];
      const safe   = async (q) => { try { const r = await q; return r; } catch (_) { return { data: null }; } };

      const [
        decisionCyclesRes, exitEvalsRes, skipProtRes,
        ordersRes, snapshotsRes,
        reconEventsRes, freezeEventsRes,
        systemFreezeRes, regimeRes, riskStateRes,
        botCfgRes,
      ] = await Promise.all([
        // DECISION_CYCLE: one row per symbol per cycle — the primary audit source
        supabase.from('bot_events').select('event_type, message, context_json, regime, created_at')
          .eq('event_type', 'DECISION_CYCLE').gte('created_at', since)
          .order('created_at', { ascending: true }).limit(5000),
        // EXIT_EVALUATION: legacy sell-side log (supplementary)
        supabase.from('bot_events').select('event_type, message, context_json, regime, created_at')
          .eq('event_type', 'EXIT_EVALUATION').gte('created_at', since)
          .order('created_at', { ascending: true }).limit(2000),
        supabase.from('bot_events').select('event_type, message, context_json, regime, created_at')
          .eq('event_type', 'POSITION_SKIP_PROTECTED').gte('created_at', since)
          .order('created_at', { ascending: true }).limit(500),
        supabase.from('orders').select('id, asset, side, state, reason, krw_requested, qty_requested, error_message, created_at')
          .in('asset', COINS).gte('created_at', since).order('created_at', { ascending: true }).limit(500),
        supabase.from('portfolio_snapshots_v2')
          .select('nav_krw, nav_usd_proxy, krw_balance, krw_pct, btc_value_krw, eth_value_krw, sol_value_krw, regime, circuit_breakers, created_at')
          .gte('created_at', since).order('created_at', { ascending: true }).limit(500),
        supabase.from('bot_events').select('event_type, message, context_json, created_at')
          .eq('event_type', 'RECONCILIATION').gte('created_at', since)
          .order('created_at', { ascending: true }).limit(100),
        supabase.from('bot_events').select('event_type, message, context_json, created_at')
          .in('event_type', ['FREEZE_STATE_CHANGED', 'FREEZE_CLEARED', 'FREEZE_CLEAR_REQUESTED'])
          .gte('created_at', since).order('created_at', { ascending: true }).limit(100),
        safe(supabase.from('app_settings').select('value').eq('key', 'system_freeze').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'current_regime').single()),
        safe(supabase.from('app_settings').select('value').eq('key', 'risk_engine_state').single()),
        safe(supabase.from('bot_config').select('trading_enabled, buys_enabled, sells_enabled, coins').limit(1).single()),
      ]);

      const decisionCycles = decisionCyclesRes.data || [];
      const exitEvals      = exitEvalsRes.data      || [];
      const skipProt      = skipProtRes.data        || [];
      const orders        = ordersRes.data          || [];
      const snapshots     = snapshotsRes.data       || [];
      const reconEvents   = reconEventsRes.data     || [];
      const freezeEvents  = freezeEventsRes.data    || [];

      const freeze       = systemFreezeRes.data?.value   ?? null;
      const regime       = regimeRes.data?.value         ?? null;
      const riskState    = riskStateRes.data?.value      ?? null;
      const botCfg       = botCfgRes.data                ?? {};

      // ── 1. System state ────────────────────────────────────────────────────
      const systemState = {
        window_hours:     hours,
        since,
        execution_mode:   'live',
        engine:           'V2',
        trading_enabled:  botCfg.trading_enabled ?? true,
        buys_enabled:     botCfg.buys_enabled    ?? true,
        sells_enabled:    botCfg.sells_enabled   ?? true,
        system_frozen:    freeze?.frozen ?? true,
        freeze_reasons:   freeze?.reasons ?? [],
        current_regime:   regime?.regime ?? null,
        regime_ema50:     regime?.ema50  ?? null,
        regime_ema200:    regime?.ema200 ?? null,
        regime_adx:       regime?.adxVal ?? null,
        risk_engine: {
          loss_streak:          riskState?.lossStreak         ?? 0,
          streak_paused_until:  riskState?.streakPausedUntil  ?? null,
          drawdown_halved:      riskState?.drawdownHalved      ?? false,
          daily_turnover_krw:   riskState?.dailyTurnoverKrw   ?? 0,
        },
      };

      // ── 2. Portfolio snapshots ─────────────────────────────────────────────
      const portfolioSnapshots = snapshots.map((s) => ({
        timestamp:          s.created_at,
        nav_krw:            s.nav_krw,
        nav_usd_proxy:      s.nav_usd_proxy,
        krw_free_cash:      s.krw_balance,
        reserve_pct:        s.krw_pct,
        btc_value_krw:      s.btc_value_krw,
        eth_value_krw:      s.eth_value_krw,
        sol_value_krw:      s.sol_value_krw,
        regime:             s.regime,
        drawdown_state:     s.circuit_breakers?.find?.(b => b.type === 'DRAWDOWN') ?? null,
        loss_streak_state:  s.circuit_breakers?.find?.(b => b.type === 'LOSS_STREAK') ?? null,
      }));

      // ── 3. Decision rows — directly from DECISION_CYCLE events ──────────────
      // Each DECISION_CYCLE event is one row: both buy and sell checks combined.
      // Attach matching order attempts by symbol + nearest timestamp (±3 min).
      const decisionRows = decisionCycles
        .filter((ev) => {
          const sym = ev.context_json?.symbol;
          return sym && COINS.includes(sym);
        })
        .map((ev) => {
          const cx  = ev.context_json ?? {};
          const sym = cx.symbol;
          // Find order attempts within ±3 min of this decision row
          const ts     = new Date(ev.created_at).getTime();
          const nearby = orders.filter((ord) =>
            ord.asset === sym && Math.abs(new Date(ord.created_at).getTime() - ts) <= 3 * 60 * 1000
          );
          const orderAttempt = nearby.length ? nearby.map((ord) => ({
            side: ord.side, state: ord.state, reason: ord.reason,
            krw: ord.krw_requested, error: ord.error_message ?? null,
          })) : null;

          const sc = cx.sell_checks ?? {};
          return {
            timestamp:         ev.created_at,
            symbol:            sym,
            price:             cx.price,
            regime:            cx.regime ?? ev.regime,
            qty_open:          cx.qty_open,
            avg_cost_krw:      cx.avg_cost_krw,
            pnl_percent:       cx.pnl_percent,
            protected:         cx.protected ?? false,
            cooldown_remaining: cx.cooldown_remaining ?? null,
            buy_checks:        cx.buy_checks  ?? null,
            sell_checks:       cx.sell_checks ?? null,
            sell_blocker:      sc.final_sell_blocker ?? null,
            buy_blocker:       (cx.buy_checks && !cx.buy_checks.final_buy_eligible) ? (cx.final_reason ?? null) : null,
            tactical_profit_floor_considered: sc.tactical_profit_floor_considered ?? null,
            tactical_profit_floor_blocker:    sc.tactical_profit_floor_blocker    ?? null,
            tactical_profit_floor_would_fire: sc.tactical_profit_floor_would_fire ?? null,
            tactical_profit_floor_fired:      sc.tactical_profit_floor_fired      ?? null,
            post_trim_runner_considered:      sc.post_trim_runner_considered      ?? null,
            post_trim_runner_blocker:         sc.post_trim_runner_blocker         ?? null,
            post_trim_runner_would_fire:      sc.post_trim_runner_would_fire      ?? null,
            post_trim_runner_in_exits:        sc.post_trim_runner_in_exits        ?? null,
            post_trim_runner_fired:           sc.post_trim_runner_fired           ?? null,
            runner_protect_considered:        sc.runner_protect_considered        ?? null,
            runner_protect_blocker:           sc.runner_protect_blocker           ?? null,
            runner_protect_peak_net_pct:      sc.runner_protect_peak_net_pct      ?? null,
            runner_protect_would_fire:        sc.runner_protect_would_fire        ?? null,
            runner_protect_fired:             sc.runner_protect_fired             ?? null,
            final_action:      cx.final_action,
            final_reason:      cx.final_reason,
            order_attempt:     orderAttempt,
          };
        });

      // Fall back to EXIT_EVALUATION if DECISION_CYCLE is empty
      // (Pi may be running old code without DECISION_CYCLE support)
      const exitEvalRows = decisionCycles.length === 0 ? exitEvals
        .filter((ev) => COINS.includes(ev.context_json?.symbol))
        .map((ev) => {
          const cx = ev.context_json ?? {};
          return {
            timestamp:    ev.created_at,
            symbol:       cx.symbol,
            price:        null,
            regime:       ev.regime,
            qty_open:     null,
            avg_cost_krw: null,
            pnl_percent:  cx.pnl_pct != null ? +cx.pnl_pct : null,
            protected:    cx.protected ?? false,
            buy_checks:   null,
            sell_checks: {
              required_edge_pct:   cx.required_edge_pct != null ? +cx.required_edge_pct : null,
              pnl_pct:             cx.pnl_pct           != null ? +cx.pnl_pct           : null,
              net_pnl_pct:         cx.net_pnl_pct       != null ? +cx.net_pnl_pct       : null,
              above_edge:          cx.above_edge ?? false,
              exits_triggered:     cx.exits_triggered ?? [],
              final_sell_eligible: cx.eligible ?? false,
              final_sell_blocker:  cx.blocker_summary ?? null,
              tactical_profit_floor_considered: cx.tactical_profit_floor_considered ?? null,
              tactical_profit_floor_blocker:    cx.tactical_profit_floor_blocker    ?? null,
              tactical_profit_floor_would_fire: cx.tactical_profit_floor_would_fire ?? null,
              tactical_profit_floor_in_exits:   cx.tactical_profit_floor_in_exits   ?? null,
              tactical_profit_floor_fired:      cx.tactical_profit_floor_fired      ?? null,
              post_trim_runner_considered:      cx.post_trim_runner_considered      ?? null,
              post_trim_runner_blocker:         cx.post_trim_runner_blocker         ?? null,
              post_trim_runner_would_fire:      cx.post_trim_runner_would_fire      ?? null,
              post_trim_runner_in_exits:        cx.post_trim_runner_in_exits        ?? null,
              post_trim_runner_fired:           cx.post_trim_runner_fired           ?? null,
              runner_protect_considered:        cx.runner_protect_considered        ?? null,
              runner_protect_blocker:           cx.runner_protect_blocker           ?? null,
              runner_protect_peak_net_pct:      cx.runner_protect_peak_net_pct      ?? null,
              runner_protect_would_fire:        cx.runner_protect_would_fire        ?? null,
              runner_protect_fired:             cx.runner_protect_fired             ?? null,
            },
            sell_blocker: cx.blocker_summary ?? null,
            tactical_profit_floor_considered: cx.tactical_profit_floor_considered ?? null,
            tactical_profit_floor_blocker:    cx.tactical_profit_floor_blocker    ?? null,
            tactical_profit_floor_would_fire: cx.tactical_profit_floor_would_fire ?? null,
            tactical_profit_floor_fired:      cx.tactical_profit_floor_fired      ?? null,
            post_trim_runner_considered:      cx.post_trim_runner_considered      ?? null,
            post_trim_runner_blocker:         cx.post_trim_runner_blocker         ?? null,
            post_trim_runner_would_fire:      cx.post_trim_runner_would_fire      ?? null,
            post_trim_runner_in_exits:        cx.post_trim_runner_in_exits        ?? null,
            post_trim_runner_fired:           cx.post_trim_runner_fired           ?? null,
            runner_protect_considered:        cx.runner_protect_considered        ?? null,
            runner_protect_blocker:           cx.runner_protect_blocker           ?? null,
            runner_protect_peak_net_pct:      cx.runner_protect_peak_net_pct      ?? null,
            runner_protect_would_fire:        cx.runner_protect_would_fire        ?? null,
            runner_protect_fired:             cx.runner_protect_fired             ?? null,
            final_action:  cx.eligible ? 'SELL_TRIGGERED' : 'NO_ACTION',
            final_reason:  cx.blocker_summary ?? ev.message,
            order_attempt: null,
          };
        }) : [];

      // ── 4. Order attempts ─────────────────────────────────────────────────
      const orderAttempts = orders.map((ord) => ({
        timestamp:      ord.created_at,
        symbol:         ord.asset,
        side:           ord.side,
        intent_state:   ord.state === 'intent_created' ? 'INTENT_CREATED'
                        : ['filled', 'dust_refunded_and_filled'].includes(ord.state) ? 'ORDER_FILLED'
                        : ord.state === 'cancelled_by_rule' ? 'INTENT_BLOCKED'
                        : ['submitted', 'accepted'].includes(ord.state) ? 'ORDER_SUBMITTED'
                        : 'ORDER_REJECTED',
        reason:         ord.reason,
        krw_amount:     ord.krw_requested,
        final_state:    ord.state,
        rejection_detail: ['failed_transient', 'failed_terminal'].includes(ord.state)
          ? ord.error_message : null,
      }));

      // ── 5. Reconciliation and freeze ──────────────────────────────────────
      const reconAndFreeze = {
        reconciliation_events: reconEvents.map((e) => ({
          timestamp:       e.created_at,
          status:          e.context_json?.trading_enabled ? 'passed' : 'frozen',
          trading_enabled: e.context_json?.trading_enabled,
          freeze_reasons:  e.context_json?.freeze_reasons ?? [],
          checks:          e.context_json?.checks ?? null,
        })),
        freeze_events: freezeEvents.map((e) => ({
          timestamp:       e.created_at,
          event_type:      e.event_type,
          message:         e.message,
          previous_frozen: e.context_json?.previous_frozen ?? null,
          new_frozen:      e.context_json?.new_frozen ?? null,
          reasons:         e.context_json?.reasons ?? [],
        })),
      };

      // ── Summary ───────────────────────────────────────────────────────────
      const allRows = decisionRows.length ? decisionRows : exitEvalRows;
      const allDecisionsBySymbol = {};
      for (const sym of COINS) {
        const symRows = allRows.filter((r) => r.symbol === sym);
        allDecisionsBySymbol[sym] = {
          total_evaluations:       symRows.length,
          buy_eligible_count:      symRows.filter((r) => r.buy_eligible).length,
          sell_eligible_count:     symRows.filter((r) => r.sell_eligible).length,
          protected_count:         symRows.filter((r) => r.protected).length,
          blocked_by_existing_pos: symRows.filter((r) => r.buy_blocker?.startsWith('existing_position')).length,
          blocked_by_signal:       symRows.filter((r) => r.buy_blocker?.startsWith('signal_not_met')).length,
          blocked_by_below_edge:   symRows.filter((r) => r.sell_blocker?.startsWith('below_required_edge')).length,
          blocked_by_risk_cap:     symRows.filter((r) => r.buy_blocker && !r.buy_blocker.startsWith('signal') && !r.buy_blocker.startsWith('existing') && !r.buy_blocker.startsWith('buys')).length,
        };
      }

      // Count top blockers across all symbols
      const blockerCounts = {};
      for (const row of allRows) {
        for (const b of [row.buy_blocker, row.sell_blocker]) {
          if (!b) continue;
          // Normalise blocker key (remove numeric values for grouping)
          const key = b.replace(/=[0-9.\-]+/g, '=N').replace(/\d+h/, 'Nh');
          blockerCounts[key] = (blockerCounts[key] ?? 0) + 1;
        }
      }
      const topBlockers = Object.entries(blockerCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));

      const totalRows     = allRows.length;
      const frozenRows    = reconAndFreeze.freeze_events.filter((e) => e.new_frozen === true).length;

      const diagnosticExport = {
        exported_at:    new Date().toISOString(),
        window_hours:   hours,
        since,
        coins:          COINS,

        // ── 1. System state ─────────────────────────────────────────────────
        system_state:  systemState,

        // ── 2. Portfolio snapshots ───────────────────────────────────────────
        portfolio_snapshots: portfolioSnapshots,

        // ── 3. Decision rows ─────────────────────────────────────────────────
        // Primary: DECISION_CYCLE events (one per symbol per cycle, all blockers)
        // Fallback: EXIT_EVALUATION events (sell-side only, if Pi is on old code)
        decision_rows: allRows,
        decision_source: decisionRows.length > 0 ? 'DECISION_CYCLE' : exitEvalRows.length > 0 ? 'EXIT_EVALUATION_fallback' : 'empty',

        // ── 4. Order attempts ────────────────────────────────────────────────
        order_attempts: orderAttempts,

        // ── 5. Reconciliation and freeze ─────────────────────────────────────
        reconciliation_and_freeze: reconAndFreeze,

        // ── Summary ──────────────────────────────────────────────────────────
        summary: {
          total_decision_rows:          totalRows,
          by_symbol:                    allDecisionsBySymbol,
          total_orders_submitted:       orderAttempts.filter((o) => o.intent_state === 'ORDER_SUBMITTED').length,
          total_orders_filled:          orderAttempts.filter((o) => o.intent_state === 'ORDER_FILLED').length,
          total_blocked_by_freeze:      reconAndFreeze.freeze_events.filter((e) => e.new_frozen).length,
          total_portfolio_snapshots:    portfolioSnapshots.length,
          top_5_blockers_by_frequency:  topBlockers,
          data_completeness: {
            decision_cycle_events:   decisionCycles.length,
            exit_evaluation_events:  exitEvals.length,
            protected_skips:         skipProt.length,
            data_source:             decisionRows.length > 0 ? 'DECISION_CYCLE' : 'EXIT_EVALUATION_fallback',
            note: decisionCycles.length === 0
              ? 'DECISION_CYCLE events not found. Pi must Pull & Restart to activate per-cycle decision logging. Once restarted, every BTC/ETH/SOL evaluation will emit one row unconditionally.'
              : `${decisionCycles.length} DECISION_CYCLE events (${(decisionCycles.length / hours / 3).toFixed(1)} per symbol per hour).`,
          },
        },
      };

      res.setHeader('Content-Disposition', `attachment; filename="diagnostic-export-${hours}h.json"`);
      return res.status(200).json(diagnosticExport);
    }

    // ── GET real-trade verification report ───────────────────────────────────
    // Proves whether each Upbit fill has a matching decision trail in the DB.
    // Uses Korea Standard Time (UTC+9) for all displayed timestamps.
    if (action === 'trade-verification' && req.method === 'GET') {
      const hours = Math.min(Number(req.query.hours) || 24, 168);
      const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const COINS = (req.query.coins ? req.query.coins.split(',') : ['BTC', 'ETH']).map((c) => c.toUpperCase());
      const safe  = async (q) => { try { const r = await q; return r; } catch (_) { return { data: null }; } };

      // KST helper — all displayed times in Korea Standard Time
      const kst = (iso) => {
        if (!iso) return null;
        const d = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
        return d.toISOString().replace('T', ' ').replace('Z', '') + ' KST';
      };

      const [
        v1TradesRes, v2FillsRes, ordersRes,
        decisionCyclesRes, executionEventsRes,
        reconciliationsRes, reconEventsRes, freezeEventsRes,
        snapshotsRes, positionsRes,
      ] = await Promise.all([
        // V1 fills — from crypto_trade_log (always live, no engine tag)
        supabase.from('crypto_trade_log')
          .select('id, coin, side, krw_amount, coin_amount, price_krw, reason, executed_at')
          .in('coin', COINS).gte('executed_at', since)
          .order('executed_at', { ascending: true }),
        // V2 fills — from v2_fills table
        supabase.from('v2_fills')
          .select('id, order_id, asset, side, price_krw, qty, fee_krw, fee_rate, strategy_tag, executed_at')
          .in('asset', COINS).gte('executed_at', since)
          .order('executed_at', { ascending: true }),
        // All V2 orders in window (all states)
        supabase.from('orders')
          .select('id, identifier, asset, side, state, reason, krw_requested, qty_requested, strategy_tag, regime_at_order, retry_count, error_message, raw_response, created_at, updated_at')
          .in('asset', COINS).gte('created_at', since)
          .order('created_at', { ascending: true }),
        // DECISION_CYCLE events (buy + sell checks per symbol per cycle)
        supabase.from('bot_events')
          .select('event_type, message, context_json, regime, created_at')
          .eq('event_type', 'DECISION_CYCLE').gte('created_at', since)
          .order('created_at', { ascending: true }).limit(5000),
        // EXECUTION events
        supabase.from('bot_events')
          .select('event_type, message, context_json, regime, created_at')
          .eq('event_type', 'EXECUTION').gte('created_at', since)
          .order('created_at', { ascending: true }),
        // reconciliation_checks table
        supabase.from('reconciliation_checks')
          .select('status, freeze_reasons, checks_run, trading_enabled, open_orders_found, discrepancies, run_at')
          .gte('run_at', since).order('run_at', { ascending: true }),
        // RECONCILIATION bot_events
        supabase.from('bot_events')
          .select('event_type, message, context_json, created_at')
          .eq('event_type', 'RECONCILIATION').gte('created_at', since)
          .order('created_at', { ascending: true }),
        // Freeze state changes
        supabase.from('bot_events')
          .select('event_type, message, context_json, created_at')
          .in('event_type', ['FREEZE_STATE_CHANGED', 'FREEZE_CLEARED'])
          .gte('created_at', since).order('created_at', { ascending: true }),
        // Portfolio snapshots (need first + last for balance_before_after)
        supabase.from('portfolio_snapshots_v2')
          .select('nav_krw, krw_balance, btc_value_krw, eth_value_krw, sol_value_krw, regime, created_at')
          .order('created_at', { ascending: true }).limit(1000),
        // Current positions
        supabase.from('positions')
          .select('asset, strategy_tag, state, qty_open, avg_cost_krw, opened_at, updated_at')
          .in('asset', COINS).in('state', ['open', 'adopted', 'partial']),
      ]);

      const v1Trades     = v1TradesRes.data    || [];
      const v2Fills      = v2FillsRes.data     || [];
      const orders       = ordersRes.data      || [];
      const decisions    = decisionCyclesRes.data || [];
      const execEvents   = executionEventsRes.data || [];
      const reconRuns    = reconciliationsRes.data || [];
      const reconEvents  = reconEventsRes.data || [];
      const freezeEvents = freezeEventsRes.data || [];
      const allSnapshots = snapshotsRes.data   || [];
      const positions    = positionsRes.data   || [];

      // Snapshots in-window
      const windowSnaps   = allSnapshots.filter((s) => s.created_at >= since);
      const snapBefore    = allSnapshots.filter((s) => s.created_at < since).slice(-1)[0] ?? windowSnaps[0] ?? null;
      const snapAfter     = windowSnaps[windowSnaps.length - 1] ?? null;

      // ── 1. Exchange fills ─────────────────────────────────────────────────
      // V1 fills = crypto_trade_log (always live, engine=V1)
      const v1ExchangeFills = v1Trades.map((t) => ({
        timestamp_kst:  kst(t.executed_at),
        timestamp_utc:  t.executed_at,
        symbol:         t.coin,
        side:           t.side,
        filled_qty:     t.coin_amount ?? null,
        krw_amount:     t.krw_amount  ?? null,
        price_krw:      t.price_krw   ?? null,
        reason:         t.reason,
        engine:         'V1',
        source_table:   'crypto_trade_log',
      }));

      // V2 fills = v2_fills joined with orders
      const ordersById = {};
      for (const o of orders) ordersById[o.id] = o;

      const v2ExchangeFills = v2Fills.map((f) => {
        const order = orders.find((o) => o.id === f.order_id);
        return {
          timestamp_kst:  kst(f.executed_at),
          timestamp_utc:  f.executed_at,
          symbol:         f.asset,
          side:           f.side,
          filled_qty:     f.qty,
          krw_amount:     f.price_krw && f.qty ? Math.round(f.price_krw * f.qty) : null,
          price_krw:      f.price_krw,
          fee_krw:        f.fee_krw,
          fee_rate:       f.fee_rate,
          order_id:       f.order_id,
          order_reason:   order?.reason ?? null,
          engine:         'V2',
          source_table:   'v2_fills',
        };
      });

      const exchangeFills = [...v1ExchangeFills, ...v2ExchangeFills]
        .sort((a, b) => a.timestamp_utc.localeCompare(b.timestamp_utc));

      // ── 2. Internal order intents ─────────────────────────────────────────
      // V2 orders that reached intent_created (or beyond) — these are the bot's decisions
      const internalOrderIntents = orders.map((o) => ({
        timestamp_kst:    kst(o.created_at),
        timestamp_utc:    o.created_at,
        symbol:           o.asset,
        side:             o.side,
        engine:           'V2',
        execution_mode:   'live',
        intent_state:     o.state,
        decision_reason:  o.reason,
        krw_requested:    o.krw_requested,
        strategy_tag:     o.strategy_tag,
        regime_at_order:  o.regime_at_order,
        identifier:       o.identifier,
        retry_count:      o.retry_count,
        error_message:    o.error_message ?? null,
      }));

      // ── 3. Execution events ───────────────────────────────────────────────
      const filledOrders = orders.filter((o) =>
        ['filled', 'dust_refunded_and_filled', 'submitted', 'accepted', 'partially_filled', 'failed_transient', 'failed_terminal'].includes(o.state)
      );

      const executionRecords = filledOrders.map((o) => {
        const matchingFill = v2Fills.find((f) => f.order_id === o.id);
        const execEvent    = execEvents.find((e) => e.context_json?.identifier === o.identifier);
        const rawResp      = o.raw_response;
        return {
          timestamp_kst:   kst(o.updated_at),
          timestamp_utc:   o.updated_at,
          symbol:          o.asset,
          side:            o.side,
          order_id:        o.id,
          identifier:      o.identifier,
          order_submitted: ['submitted', 'accepted', 'partially_filled', 'filled', 'dust_refunded_and_filled'].includes(o.state),
          order_filled:    ['filled', 'dust_refunded_and_filled'].includes(o.state),
          final_state:     o.state,
          filled_qty:      matchingFill?.qty ?? null,
          krw_amount:      matchingFill ? Math.round((matchingFill.price_krw ?? 0) * (matchingFill.qty ?? 0)) : null,
          fee_krw:         matchingFill?.fee_krw ?? null,
          result:          o.state,
          exchange_order_uuid:  rawResp?.uuid ?? null,
          exchange_state:       rawResp?.state ?? null,
          exchange_volume:      rawResp?.executed_volume ?? null,
          execution_event_found: !!execEvent,
          error_detail:    o.error_message ?? null,
        };
      });

      // ── 4. Balance before/after ───────────────────────────────────────────
      const dbPositionsSnap = positions.map((p) => ({
        asset:        p.asset,
        strategy_tag: p.strategy_tag,
        state:        p.state,
        qty_open:     Number(p.qty_open),
        avg_cost_krw: p.avg_cost_krw,
        last_updated: kst(p.updated_at),
      }));

      const balanceBeforeAfter = {
        window_start_kst: kst(since),
        window_end_kst:   kst(new Date().toISOString()),
        portfolio_before: snapBefore ? {
          timestamp_kst: kst(snapBefore.created_at),
          nav_krw:       snapBefore.nav_krw,
          krw_cash:      snapBefore.krw_balance,
          btc_value_krw: snapBefore.btc_value_krw,
          eth_value_krw: snapBefore.eth_value_krw,
          sol_value_krw: snapBefore.sol_value_krw,
          source:        'portfolio_snapshots_v2',
        } : null,
        portfolio_after: snapAfter ? {
          timestamp_kst: kst(snapAfter.created_at),
          nav_krw:       snapAfter.nav_krw,
          krw_cash:      snapAfter.krw_balance,
          btc_value_krw: snapAfter.btc_value_krw,
          eth_value_krw: snapAfter.eth_value_krw,
          sol_value_krw: snapAfter.sol_value_krw,
          source:        'portfolio_snapshots_v2',
        } : null,
        db_positions_current: dbPositionsSnap,
        nav_change_krw: snapBefore && snapAfter
          ? Math.round((snapAfter.nav_krw ?? 0) - (snapBefore.nav_krw ?? 0))
          : null,
        snapshot_count_in_window: windowSnaps.length,
      };

      // ── 5. Reconciliation results ─────────────────────────────────────────
      const reconciliationResults = {
        reconciliation_runs: reconRuns.map((r) => ({
          run_at_kst:         kst(r.run_at),
          status:             r.status,
          trading_enabled:    r.trading_enabled,
          open_orders_found:  r.open_orders_found,
          freeze_reasons:     r.freeze_reasons ?? [],
          discrepancies:      r.discrepancies  ?? null,
          checks: {
            adoption_complete:    r.checks_run?.adoption_complete?.passed    ?? null,
            no_unresolved_orders: r.checks_run?.no_unresolved_orders?.passed ?? null,
            balance_match:        r.checks_run?.balance_match?.passed        ?? null,
            ownership_clarity:    r.checks_run?.ownership_clarity?.passed    ?? null,
            position_integrity:   r.checks_run?.position_integrity?.passed   ?? null,
          },
        })),
        freeze_events: freezeEvents.map((e) => ({
          timestamp_kst: kst(e.created_at),
          event_type:    e.event_type,
          message:       e.message,
          frozen:        e.context_json?.new_frozen ?? null,
          reasons:       e.context_json?.reasons ?? [],
        })),
        mismatch_detected:     reconRuns.some((r) => r.discrepancies && Object.keys(r.discrepancies).length > 0),
        freeze_triggered:      freezeEvents.some((e) => e.context_json?.new_frozen === true),
        reconciliation_passed: reconRuns.some((r) => r.status === 'passed'),
      };

      // ── 6. Fill match report ──────────────────────────────────────────────
      // For each exchange fill, find matching intent/execution/balance/recon records.
      const fillMatchReport = exchangeFills.map((fill) => {
        const fillTs = new Date(fill.timestamp_utc).getTime();
        const W5     = 5 * 60 * 1000;   // ±5 min window for matching
        const W15    = 15 * 60 * 1000;  // ±15 min for reconciliation

        // matched_intent: V2 order intent OR DECISION_CYCLE showing buy/sell eligible
        let matchedIntent     = false;
        let intentDetail      = null;
        if (fill.engine === 'V2') {
          // V2 fill always has an order — check it exists in our orders table
          const matchOrder = orders.find((o) => o.id === fill.order_id);
          matchedIntent = !!matchOrder;
          intentDetail  = matchOrder
            ? `order ${matchOrder.id.slice(0,8)} state=${matchOrder.state} reason=${matchOrder.reason}`
            : 'order_record_missing';
        } else {
          // V1 fill — look for a DECISION_CYCLE event near the same time
          const nearDecision = decisions.find((d) => {
            const dc = d.context_json ?? {};
            return dc.symbol === fill.symbol
              && Math.abs(new Date(d.created_at).getTime() - fillTs) <= W5;
          });
          matchedIntent = !!nearDecision;
          intentDetail  = nearDecision
            ? `DECISION_CYCLE at ${kst(nearDecision.created_at)} action=${nearDecision.context_json?.final_action}`
            : 'no_DECISION_CYCLE_within_5min (V1 fill — V2 decision trail not expected)';
        }

        // matched_execution: V2 execution record exists, V1 has none (expected)
        let matchedExecution  = false;
        let executionDetail   = null;
        if (fill.engine === 'V2') {
          const matchExec = executionRecords.find((e) =>
            e.order_id === fill.order_id && e.order_filled
          );
          matchedExecution = !!matchExec;
          executionDetail  = matchExec
            ? `order filled state=${matchExec.final_state} qty=${matchExec.filled_qty}`
            : 'execution_record_not_filled_or_missing';
        } else {
          // V1 — no V2 execution table entry expected
          matchedExecution = null; // N/A for V1
          executionDetail  = 'V1_engine:execution_not_tracked_in_V2_tables';
        }

        // matched_balance_change: check if any snapshot near the fill time shows
        // a change in the relevant coin's value
        const snapNear = windowSnaps.filter((s) =>
          Math.abs(new Date(s.created_at).getTime() - fillTs) <= W15
        );
        const snapKey = `${fill.symbol.toLowerCase()}_value_krw`;
        let matchedBalanceChange = null;
        let balanceDetail        = null;
        if (snapNear.length >= 2) {
          const before = snapNear[0][snapKey];
          const after  = snapNear[snapNear.length - 1][snapKey];
          const changed = before != null && after != null && Math.abs(after - before) > 100;
          matchedBalanceChange = changed;
          balanceDetail = changed
            ? `${fill.symbol} value changed ₩${Math.round(before).toLocaleString()} → ₩${Math.round(after).toLocaleString()}`
            : `snapshot value unchanged before=${before} after=${after} (may be price-only move)`;
        } else if (snapNear.length === 1) {
          matchedBalanceChange = null;
          balanceDetail = 'only_one_snapshot_near_fill_time:cannot_determine_change';
        } else {
          matchedBalanceChange = null;
          balanceDetail = 'no_portfolio_snapshot_within_15min_of_fill';
        }

        // matched_reconciliation: reconciliation passed within 15 min after fill
        const reconAfter = reconRuns.find((r) =>
          new Date(r.run_at).getTime() > fillTs &&
          new Date(r.run_at).getTime() < fillTs + W15
        );
        const matchedReconciliation = reconAfter ? reconAfter.trading_enabled === true : null;
        const reconDetail = reconAfter
          ? `recon ran at ${kst(reconAfter.run_at)} → ${reconAfter.status}`
          : 'no_reconciliation_run_within_15min_after_fill';

        // Overall match — strict: all four must pass (N/A is treated as not-blocking)
        const strictChecks = [matchedIntent, matchedExecution, matchedBalanceChange, matchedReconciliation]
          .filter((v) => v !== null);
        const overallMatch = strictChecks.length > 0 && strictChecks.every(Boolean);

        let mismatchReason = null;
        if (!overallMatch) {
          const mismatches = [];
          if (matchedIntent === false)           mismatches.push('intent_not_found');
          if (matchedExecution === false)        mismatches.push('execution_record_missing_or_unfilled');
          if (matchedBalanceChange === false)    mismatches.push('no_balance_change_detected_in_snapshots');
          if (matchedReconciliation === false)   mismatches.push('reconciliation_failed_after_fill');
          if (strictChecks.length === 0)         mismatches.push('no_audit_data_available_for_this_fill');
          mismatchReason = mismatches.join(' | ');
        }

        return {
          fill_timestamp_kst:          fill.timestamp_kst,
          symbol:                      fill.symbol,
          side:                        fill.side,
          engine:                      fill.engine,
          filled_qty:                  fill.filled_qty,
          krw_amount:                  fill.krw_amount,
          matched_intent:              matchedIntent,
          intent_detail:               intentDetail,
          matched_execution:           matchedExecution,
          execution_detail:            executionDetail,
          matched_balance_change:      matchedBalanceChange,
          balance_detail:              balanceDetail,
          matched_reconciliation:      matchedReconciliation,
          reconciliation_detail:       reconDetail,
          overall_match:               overallMatch,
          mismatch_reason:             mismatchReason,
        };
      });

      // ── 7. Summary ────────────────────────────────────────────────────────
      const matchedFills   = fillMatchReport.filter((r) => r.overall_match).length;
      const unmatchedFills = fillMatchReport.filter((r) => !r.overall_match).length;
      const naFills        = fillMatchReport.filter((r) => r.overall_match === null).length;

      const unmatchedReasons = fillMatchReport
        .filter((r) => r.mismatch_reason)
        .map((r) => r.mismatch_reason);
      const reasonCounts = {};
      for (const reason of unmatchedReasons) {
        for (const part of reason.split(' | ')) {
          reasonCounts[part] = (reasonCounts[part] ?? 0) + 1;
        }
      }
      const topUnmatchedReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count }));

      // Classify overall health
      let overallVerification = 'CLEAN';
      if (unmatchedFills > 0) {
        const hasV1Only = fillMatchReport.filter((r) => !r.overall_match).every((r) => r.engine === 'V1');
        overallVerification = hasV1Only ? 'UNMATCHED_V1_ONLY' : 'UNMATCHED_V2_FILLS_DETECTED';
      }
      if (exchangeFills.length === 0) overallVerification = 'NO_FILLS_IN_WINDOW';

      const report = {
        generated_at_kst: kst(new Date().toISOString()),
        window_hours:      hours,
        window_start_kst:  kst(since),
        coins:             COINS,

        // ── 1 ───────────────────────────────────────────────────────────────
        exchange_fills: exchangeFills,

        // ── 2 ───────────────────────────────────────────────────────────────
        internal_order_intents: internalOrderIntents,

        // ── 3 ───────────────────────────────────────────────────────────────
        execution_events: executionRecords,

        // ── 4 ───────────────────────────────────────────────────────────────
        balance_before_after: balanceBeforeAfter,

        // ── 5 ───────────────────────────────────────────────────────────────
        reconciliation_results: reconciliationResults,

        // ── 6 ───────────────────────────────────────────────────────────────
        fill_match_report: fillMatchReport,

        // ── 7 ───────────────────────────────────────────────────────────────
        summary: {
          total_exchange_fills:    exchangeFills.length,
          v1_fills:                v1ExchangeFills.length,
          v2_fills:                v2ExchangeFills.length,
          total_matched_fills:     matchedFills,
          total_unmatched_fills:   unmatchedFills,
          total_na_fills:          naFills,
          overall_verification:    overallVerification,
          top_unmatched_reasons:   topUnmatchedReasons,
          likely_cause_of_unmatched: unmatchedFills === 0
            ? 'All fills matched'
            : v1ExchangeFills.length > 0 && fillMatchReport.filter((r) => !r.overall_match && r.engine === 'V1').length > 0
              ? 'V1 fills lack V2 execution records — expected when V1 engine was active. V1 fills are not tracked in v2_fills or orders tables.'
              : 'V2 fills have missing execution or reconciliation records — investigate execution_events section.',
          data_notes: [
            v1ExchangeFills.length > 0 ? `${v1ExchangeFills.length} V1 fills found — these predate the V2 live-only refactor and will not have V2 execution records. This is expected.` : null,
            v2ExchangeFills.length === 0 && v1ExchangeFills.length === 0 ? 'No fills in window — either no trades happened or v2_fills and crypto_trade_log both have no entries for this period.' : null,
            reconRuns.length === 0 ? 'No reconciliation runs found in window.' : null,
          ].filter(Boolean),
        },
      };

      res.setHeader('Content-Disposition', `attachment; filename="trade-verification-${hours}h.json"`);
      return res.status(200).json(report);
    }

    // ── GET tuning validation export ─────────────────────────────────────────
    // Compact per-symbol analysis of whether the strategy tuning increased
    // profitable rotation without making the bot reckless.
    // Sections: summary · blocker_counts_by_symbol · executed_trades ·
    //   near_miss_buys · near_miss_sells · realized_profit_summary ·
    //   turnover_summary · final_assessment_inputs
    if (action === 'tuning-export' && req.method === 'GET') {
      const hours  = Math.min(Number(req.query.hours) || 24, 72);
      const since  = new Date(Date.now() - hours * 3600000).toISOString();
      const until  = new Date().toISOString();
      const COINS  = ['BTC', 'ETH'];
      const safe   = async (q) => { try { return await q; } catch (_) { return { data: null }; } };

      // Korea Standard Time helper (UTC+9)
      const toKST = (iso) => {
        if (!iso) return null;
        const d = new Date(new Date(iso).getTime() + 9 * 3600000);
        return d.toISOString().replace('T', ' ').slice(0, 19) + ' KST';
      };

      const [decisionRes, ordersRes, fillsRes, snapshotsRes, cfgRes, positionsRes] = await Promise.all([
        supabase.from('bot_events')
          .select('message, context_json, created_at').eq('event_type', 'DECISION_CYCLE')
          .gte('created_at', since).order('created_at', { ascending: true }).limit(5000),
        supabase.from('orders')
          .select('id, asset, side, state, reason, krw_requested, qty_requested, created_at, position_id')
          .in('asset', COINS).gte('created_at', since).order('created_at', { ascending: true }).limit(500),
        safe(supabase.from('v2_fills')
          .select('order_id, position_id, asset, side, price_krw, qty, fee_krw, entry_reason, executed_at')
          .in('asset', COINS).gte('executed_at', since).order('executed_at', { ascending: true }).limit(500)),
        safe(supabase.from('portfolio_snapshots_v2')
          .select('nav_krw, created_at').gte('created_at', since).order('created_at', { ascending: true }).limit(500)),
        safe(supabase.from('bot_config').select('*').limit(1).single()),
        safe(supabase.from('positions')
          .select('position_id, asset, avg_cost_krw, qty_open')
          .in('state', ['open', 'adopted', 'partial']).in('asset', COINS)),
      ]);

      const decisions  = decisionRes.data  || [];
      const orders     = ordersRes.data    || [];
      const fills      = fillsRes.data     || [];
      const snapshots  = snapshotsRes.data || [];
      const cfg        = cfgRes.data       || {};

      // ── Blocker classifier ───────────────────────────────────────────────
      function classifyBlocker(raw) {
        if (!raw) return 'other';
        const r = raw.toLowerCase();
        if (r.includes('below_required_edge') || r.includes('below_edge')) return 'below_required_edge';
        if (r.includes('existing_position_add_rule'))   return 'existing_position_add_rule';
        if (r.includes('bb_pctb') || r.includes('bb_pct_b')) return 'bb_pctB_threshold';
        if (r.includes('rsi'))                          return 'rsi_threshold';
        if (r.includes('ob_imbalance'))                 return 'ob_imbalance_threshold';
        if (r.includes('cooldown'))                     return 'cooldown';
        if (r.includes('exposure') || r.includes('risk_cap') || r.includes('entries in last') || r.includes('turnover') || r.includes('streak')) return 'risk_cap';
        if (r.includes('frozen'))                       return 'system_frozen';
        if (r.includes('protected'))                    return 'protected_position';
        if (r === 'no_position' || r.includes('no_position')) return 'no_position';
        if (r.includes('cash') || r.includes('reserve')) return 'cash_not_ok';
        return 'other';
      }

      // ── Order classifier ─────────────────────────────────────────────────
      const filledStates    = new Set(['filled', 'dust_refunded_and_filled']);
      const submittedStates = new Set(['submitted', 'accepted', 'filled', 'dust_refunded_and_filled', 'intent_created']);

      function classifyOrder(ord) {
        const r = (ord.reason ?? '').toLowerCase();
        if (ord.side === 'buy')  return r.includes('_addon') ? 'add_on' : 'initial_entry';
        if (r.includes('trim1')) return 'trim1';
        if (r.includes('trim2')) return 'trim2';
        if (r.includes('runner') || r.includes('regime_break') || r.includes('time_stop')) return 'full_exit';
        return 'other';
      }

      // ── Process DECISION_CYCLE rows ──────────────────────────────────────
      const TRIM1_TARGET   = cfg.exit_quick_trim1_gross_pct ?? 0.85;
      const TRIM2_TARGET   = cfg.exit_quick_trim2_gross_pct ?? 1.25;
      const BLOCKER_KEYS   = ['below_required_edge','existing_position_add_rule','bb_pctB_threshold',
        'rsi_threshold','ob_imbalance_threshold','cooldown','risk_cap','system_frozen',
        'protected_position','no_position','cash_not_ok','other'];

      let totalDecisions = 0, totalNoAction = 0;
      const buyEligBySymbol  = { BTC: 0, ETH: 0, SOL: 0 };
      const sellEligBySymbol = { BTC: 0, ETH: 0, SOL: 0 };
      const blockerCounts    = {};
      const blockerBySym     = { BTC: {}, ETH: {}, SOL: {} };
      const nearMissBuys     = [];
      const nearMissSells    = [];

      for (const ev of decisions) {
        const cx  = ev.context_json ?? {};
        const sym = cx.symbol;
        if (!COINS.includes(sym)) continue;
        totalDecisions++;

        const fa  = cx.final_action ?? '';
        const fr  = cx.final_reason ?? '';
        const bc  = cx.buy_checks   ?? {};
        const sc  = cx.sell_checks  ?? {};
        const pnl = cx.pnl_percent;

        if (['BUY_ELIGIBLE','ADD_ON_ELIGIBLE','BUY_SUBMITTED','ADD_ON_SUBMITTED'].includes(fa)) buyEligBySymbol[sym]++;
        if (fa === 'SELL_TRIGGERED') sellEligBySymbol[sym]++;
        if (fa === 'NO_ACTION') totalNoAction++;

        // Extract and count blocker — prefer sell-side blocker for sell rows, buy-side for buy rows
        const rawSellBlocker = sc.final_sell_blocker ?? null;
        const rawBuyBlocker  = fr.includes('buy_blocked:') ? fr.replace(/^.*buy_blocked:/, '').split(' |')[0] : null;
        const rawBlocker     = rawBuyBlocker ?? rawSellBlocker ?? (fa === 'NO_ACTION' ? fr : null);

        if (rawBlocker) {
          const nb = classifyBlocker(rawBlocker);
          blockerCounts[nb] = (blockerCounts[nb] ?? 0) + 1;
          blockerBySym[sym][nb] = (blockerBySym[sym][nb] ?? 0) + 1;
        }

        // Near-miss buys — signal partially close to passing or add-on blocked by gap
        const bbPctB    = bc.bb_pctB     ?? null;
        const bbThresh  = bc.bb_threshold ?? null;
        const rsi       = bc.rsi          ?? null;
        const rsiStr    = bc.rsi_threshold ?? '';
        const obImb     = bc.ob_imbalance  ?? null;
        const obThresh  = bc.ob_threshold   ?? null;

        const bbClose = bbPctB != null && bbThresh != null && bbPctB >= bbThresh && bbPctB < bbThresh * 1.20;
        const rsiClose = (() => {
          if (rsi == null || !rsiStr) return false;
          const parts = rsiStr.split('-');
          if (parts.length === 2) { const max = Number(parts[1]); return rsi > max && rsi < max + 5; }
          const max = Number(rsiStr.replace(/[^0-9.]/g, ''));
          return !isNaN(max) && rsi >= max && rsi < max + 5;
        })();
        const obClose         = obImb != null && obThresh != null && obImb < 0 && obImb >= obThresh * 1.20 && obImb < obThresh;
        const isAddonBlocked  = (rawBuyBlocker ?? '').startsWith('existing_position_add_rule');

        if (fa === 'NO_ACTION' && bc.buys_enabled !== false && (bbClose || rsiClose || obClose || isAddonBlocked)) {
          const cooldownMatch = fr.match(/cooldown_(\d+)min/);
          nearMissBuys.push({
            timestamp_kst:    toKST(ev.created_at),
            symbol:           sym,
            price:            cx.price     ?? null,
            qty_open:         cx.qty_open  ?? null,
            avg_cost_krw:     cx.avg_cost_krw ?? null,
            buy_blocker:      rawBuyBlocker ? classifyBlocker(rawBuyBlocker) : null,
            rsi:              rsi,
            rsi_threshold:    rsiStr || null,
            bb_pctB:          bbPctB,
            bb_threshold:     bbThresh,
            ob_imbalance:     obImb,
            ob_threshold:     obThresh,
            cooldown_remaining: cooldownMatch ? `${cooldownMatch[1]}min` : null,
            risk_cap_ok:      bc.risk_cap_ok ?? null,
            final_reason:     fr,
          });
        }

        // Near-miss sells — has position, pnl positive but below trim1
        if (sc.qty_ok && pnl != null && pnl > 0 && pnl < TRIM1_TARGET) {
          nearMissSells.push({
            timestamp_kst:     toKST(ev.created_at),
            symbol:            sym,
            price:             cx.price       ?? null,
            qty_open:          cx.qty_open    ?? null,
            avg_cost_krw:      cx.avg_cost_krw ?? null,
            pnl_percent:       pnl,
            required_edge_pct: sc.required_edge_pct ?? null,
            final_sell_blocker: sc.final_sell_blocker ?? null,
            tranche_state:     sc.tranche_state      ?? null,
            trailing_stop_hit: sc.trailing_stop_hit  ?? null,
            regime_break_hit:  sc.regime_break_hit   ?? null,
            final_reason:      fr,
          });
        }
      }

      // Top 10 blockers overall
      const topBlockers = Object.entries(blockerCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([reason, count]) => ({ reason, count }));

      // Blocker counts per symbol (all keys, zero if absent)
      const blockerCountsBySymbol = {};
      for (const sym of COINS) {
        blockerCountsBySymbol[sym] = Object.fromEntries(BLOCKER_KEYS.map((k) => [k, blockerBySym[sym]?.[k] ?? 0]));
      }

      // ── Process orders ───────────────────────────────────────────────────
      let buySub = 0, sellSub = 0, buyFill = 0, sellFill = 0;
      let trim1Count = 0, trim2Count = 0, addonCount = 0, fullExitCount = 0;
      const turnoverBySym = { BTC: 0, ETH: 0, SOL: 0 };
      const addonBySym    = { BTC: 0, ETH: 0, SOL: 0 };
      const trimBySym     = { BTC: 0, ETH: 0, SOL: 0 };
      let totalTurnover   = 0;
      let realPnlTotal    = 0;
      const realPnlBySym  = { BTC: 0, ETH: 0, SOL: 0 };
      let pnlTrim1 = 0, pnlTrim2 = 0, pnlFullExit = 0;
      const pnlPerSell    = [];
      const executedTrades = [];

      for (const ord of orders) {
        const sym = ord.asset;
        if (!COINS.includes(sym)) continue;
        const cat      = classifyOrder(ord);
        const submitted = submittedStates.has(ord.state);
        const filled    = filledStates.has(ord.state);

        if (ord.side === 'buy')  { if (submitted) buySub++;  if (filled) buyFill++;  }
        if (ord.side === 'sell') { if (submitted) sellSub++; if (filled) sellFill++; }
        if (cat === 'trim1')     trim1Count++;
        if (cat === 'trim2')     trim2Count++;
        if (cat === 'add_on')    addonCount++;
        if (cat === 'full_exit') fullExitCount++;

        const krw = Number(ord.krw_requested ?? 0);
        if (submitted) {
          totalTurnover += krw;
          if (turnoverBySym[sym] != null) turnoverBySym[sym] += krw;
        }
        if (cat === 'add_on')                                            addonBySym[sym] = (addonBySym[sym] ?? 0) + 1;
        if (['trim1','trim2','full_exit'].includes(cat))                 trimBySym[sym]  = (trimBySym[sym]  ?? 0) + 1;

        // Approximate P&L for filled sells: find nearest DECISION_CYCLE with pnl_percent
        let pnlPct = null;
        if (ord.side === 'sell' && filled) {
          const ordMs = new Date(ord.created_at).getTime();
          const match = decisions.find((d) => {
            const dcx = d.context_json ?? {};
            return dcx.symbol === sym && dcx.pnl_percent != null
              && Math.abs(new Date(d.created_at).getTime() - ordMs) <= 5 * 60 * 1000;
          });
          pnlPct = match?.context_json?.pnl_percent ?? null;
          if (pnlPct != null) {
            const approxKrw = (pnlPct / 100) * krw;
            realPnlTotal += approxKrw;
            if (realPnlBySym[sym] != null) realPnlBySym[sym] += approxKrw;
            if (cat === 'trim1')     pnlTrim1    += approxKrw;
            if (cat === 'trim2')     pnlTrim2    += approxKrw;
            if (cat === 'full_exit') pnlFullExit += approxKrw;
            pnlPerSell.push(approxKrw);
          }
        }

        // Find matching fill for qty
        const matchFill = fills.find((f) =>
          f.order_id === ord.id ||
          (f.asset === sym && f.side === ord.side &&
           Math.abs(new Date(f.executed_at ?? 0).getTime() - new Date(ord.created_at).getTime()) < 5 * 60 * 1000)
        );

        executedTrades.push({
          timestamp_kst:    toKST(ord.created_at),
          symbol:           sym,
          side:             ord.side,
          category:         cat,
          order_submitted:  submitted,
          order_filled:     filled,
          krw_amount:       krw || null,
          filled_qty:       matchFill?.qty ?? null,
          gross_target_pct: cat === 'trim1' ? TRIM1_TARGET : cat === 'trim2' ? TRIM2_TARGET : null,
          pnl_percent:      pnlPct,
          final_reason:     ord.reason ?? null,
          order_id:         ord.id ?? null,
        });
      }

      const avgPnl = pnlPerSell.length ? pnlPerSell.reduce((a, b) => a + b, 0) / pnlPerSell.length : null;
      const sorted = [...pnlPerSell].sort((a, b) => a - b);
      const medPnl = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

      // ── Turnover vs NAV ──────────────────────────────────────────────────
      const latestNav    = snapshots.length ? snapshots[snapshots.length - 1].nav_krw : null;
      const turnoverPct  = latestNav && totalTurnover ? +((totalTurnover / latestNav) * 100).toFixed(2) : null;

      // ── Hold time from fills ─────────────────────────────────────────────
      const buyFillsByPos = {}, sellFillsByPos = {};
      for (const f of fills) {
        const bucket = f.side === 'buy' ? buyFillsByPos : sellFillsByPos;
        if (!bucket[f.position_id]) bucket[f.position_id] = [];
        bucket[f.position_id].push(f);
      }
      const holdTimes = [];
      for (const [pid, buys] of Object.entries(buyFillsByPos)) {
        const sells = sellFillsByPos[pid] ?? [];
        if (buys.length && sells.length) {
          const tBuy  = Math.min(...buys.map((b)  => new Date(b.executed_at).getTime()));
          const tSell = Math.min(...sells.map((s) => new Date(s.executed_at).getTime()));
          if (tSell > tBuy) holdTimes.push((tSell - tBuy) / 3600000);
        }
      }
      const avgHoldHours = holdTimes.length
        ? +( holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length).toFixed(1)
        : null;

      // ── Most common blockers per symbol ──────────────────────────────────
      const BUY_BLOCKER_KEYS  = ['bb_pctB_threshold','rsi_threshold','ob_imbalance_threshold','cooldown','risk_cap','existing_position_add_rule','cash_not_ok'];
      const SELL_BLOCKER_KEYS = ['below_required_edge','no_position','protected_position'];

      function topKey(symCounts, keys) {
        let best = null, bestN = 0;
        for (const k of keys) { if ((symCounts[k] ?? 0) > bestN) { bestN = symCounts[k]; best = k; } }
        return best;
      }

      const mostCommonBuyBlocker  = Object.fromEntries(COINS.map((s) => [s, topKey(blockerBySym[s], BUY_BLOCKER_KEYS)]));
      const mostCommonSellBlocker = Object.fromEntries(COINS.map((s) => [s, topKey(blockerBySym[s], SELL_BLOCKER_KEYS)]));

      // ── Build export ─────────────────────────────────────────────────────
      const tuningExport = {
        exported_at_kst: toKST(new Date().toISOString()),
        window_hours:    hours,
        engine:          'V2_live',

        summary: {
          window_start:                         toKST(since),
          window_end:                           toKST(until),
          total_decision_cycles:                totalDecisions,
          total_buys_submitted:                 buySub,
          total_sells_submitted:                sellSub,
          total_buys_filled:                    buyFill,
          total_sells_filled:                   sellFill,
          total_partial_trim1_fired:            trim1Count,
          total_partial_trim2_fired:            trim2Count,
          total_addon_buys_fired:               addonCount,
          total_full_exit_sells:                fullExitCount,
          total_no_action_cycles:               totalNoAction,
          total_buy_eligible_cycles_by_symbol:  buyEligBySymbol,
          total_sell_eligible_cycles_by_symbol: sellEligBySymbol,
          top_10_blocker_reasons_overall:       topBlockers,
        },

        blocker_counts_by_symbol: blockerCountsBySymbol,

        executed_trades: executedTrades,

        near_miss_buys:  nearMissBuys.slice(-30),
        near_miss_sells: nearMissSells.slice(-30),

        realized_profit_summary: {
          realized_pnl_krw_total:       realPnlTotal  ? +realPnlTotal.toFixed(0)  : null,
          realized_pnl_by_symbol:       Object.fromEntries(Object.entries(realPnlBySym).map(([k, v]) => [k, +v.toFixed(0)])),
          realized_pnl_from_trim1:      pnlTrim1      ? +pnlTrim1.toFixed(0)      : null,
          realized_pnl_from_trim2:      pnlTrim2      ? +pnlTrim2.toFixed(0)      : null,
          realized_pnl_from_full_exits: pnlFullExit   ? +pnlFullExit.toFixed(0)   : null,
          average_realized_pnl_per_sell: avgPnl != null ? +avgPnl.toFixed(0)      : null,
          median_realized_pnl_per_sell:  medPnl != null ? +medPnl.toFixed(0)      : null,
          note: pnlPerSell.length === 0
            ? 'No filled sell orders in window — all P&L fields are null.'
            : 'Approximate: pnl_percent from nearest DECISION_CYCLE × krw_amount. ±5% error is normal.',
        },

        turnover_summary: {
          turnover_krw_total:     totalTurnover ? +totalTurnover.toFixed(0) : 0,
          turnover_by_symbol:     Object.fromEntries(Object.entries(turnoverBySym).map(([k, v]) => [k, +v.toFixed(0)])),
          turnover_pct_of_nav:    turnoverPct,
          latest_nav_krw:         latestNav ? +latestNav.toFixed(0) : null,
          add_on_count_by_symbol: addonBySym,
          trim_count_by_symbol:   trimBySym,
          avg_hold_time_hours:    avgHoldHours,
        },

        final_assessment_inputs: {
          most_common_buy_blocker_by_symbol:    mostCommonBuyBlocker,
          most_common_sell_blocker_by_symbol:   mostCommonSellBlocker,
          did_trim1_fire:                        trim1Count > 0,
          did_trim2_fire:                        trim2Count > 0,
          did_addons_fire:                       addonCount > 0,
          did_realized_profit_occur:             realPnlTotal > 0,
          did_turnover_increase_vs_previous_window: null,
          current_thresholds: {
            entry_bb_pct_uptrend:          cfg.entry_bb_pct_uptrend          ?? 0.45,
            entry_rsi_min_uptrend:         cfg.entry_rsi_min_uptrend         ?? 42,
            entry_rsi_max_uptrend:         cfg.entry_rsi_max_uptrend         ?? 55,
            entry_bb_pct_range:            cfg.entry_bb_pct_range            ?? 0.30,
            entry_rsi_max_range:           cfg.entry_rsi_max_range           ?? 45,
            ob_imbalance_min:              cfg.ob_imbalance_min              ?? -0.45,
            exit_safety_buffer_pct:        cfg.exit_safety_buffer_pct        ?? 0.10,
            exit_quick_trim1_gross_pct:    cfg.exit_quick_trim1_gross_pct    ?? 0.85,
            exit_quick_trim2_gross_pct:    cfg.exit_quick_trim2_gross_pct    ?? 1.25,
            addon_min_dip_pct:             cfg.addon_min_dip_pct             ?? 1.0,
            addon_size_mult:               cfg.addon_size_mult                ?? 0.5,
            max_entries_per_coin_24h:      cfg.max_entries_per_coin_24h      ?? 3,
          },
        },
      };

      res.setHeader('Content-Disposition', `attachment; filename="tuning-export-${hours}h.json"`);
      return res.status(200).json(tuningExport);
    }

    // ── GET structured export — canonical DB rows only (no PM2 text logs) ───────
    // Same payload as GET /api/diagnostics/export — download diagnostics-{hours}h.json
    if (action === 'structured-export' && req.method === 'GET') {
      const hours = Math.min(Number(req.query.hours) || 24, 168);
      const payload = await buildStructuredDiagnosticsExport(supabase, { hours });
      res.setHeader('Content-Disposition', `attachment; filename="diagnostics-${hours}h.json"`);
      return res.status(200).json(payload);
    }

    // ── PATCH bot-config — update a single tunable field ─────────────────────
    if (action === 'bot-config' && req.method === 'PATCH') {
      const body = req.body ?? {};
      const { key, value } = body;
      if (!key || value === undefined) {
        return res.status(400).json({ error: 'Body must include { key, value }' });
      }
      const ALLOWLIST = [
        // Capital deployment
        'target_deployment_pct', 'target_entries_per_position', 'krw_min_reserve_pct', 'daily_turnover_cap_pct',
        // Entry thresholds
        'entry_rsi_min_uptrend', 'entry_rsi_max_uptrend', 'entry_bb_pct_uptrend',
        'ob_imbalance_min', 'starter_ob_imbalance_min',
        // Exit thresholds
        'exit_quick_trim1_gross_pct', 'exit_quick_trim2_gross_pct',
        'exit_tactical_final_exit_hours', 'exit_tactical_final_exit_min_net_pct',
        'exit_core_final_exit_hours', 'exit_core_time_stop_hours', 'exit_tactical_time_stop_hours',
        // Timing / cooldowns
        'buy_cooldown_ms', 'core_exit_reentry_cooldown_ms',
        // Risk controls
        'max_addons_per_position', 'max_btc_pct', 'max_eth_pct', 'max_xrp_pct', 'loss_streak_limit',
      ];
      if (!ALLOWLIST.includes(key)) {
        return res.status(400).json({ error: `Key "${key}" is not in the allowlist`, allowed: ALLOWLIST });
      }
      const { data: cfgRow } = await supabase.from('bot_config').select('id').limit(1).single();
      if (!cfgRow?.id) return res.status(500).json({ error: 'bot_config row not found' });
      const { error: updErr } = await supabase
        .from('bot_config')
        .update({ [key]: value, updated_at: new Date().toISOString() })
        .eq('id', cfgRow.id);
      if (updErr) return res.status(500).json({ error: updErr.message });
      return res.status(200).json({ success: true, key, value });
    }

    // ── POST manual-sell — PIN-protected manual partial sell ────────────────
    if (action === 'manual-sell' && req.method === 'POST') {
      const pin = process.env.PI_TERMINAL_PIN;
      if (!pin) return res.status(503).json({ ok: false, error: 'PI_TERMINAL_PIN not configured' });

      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { asset, pct, pin: userPin } = body;

      if (!userPin || userPin !== pin) return res.status(403).json({ ok: false, error: 'Invalid PIN' });
      if (!asset || !['BTC', 'ETH', 'XRP', 'SOL'].includes(asset)) return res.status(400).json({ ok: false, error: 'Invalid asset' });
      if (pct == null || pct < 1 || pct > 95) return res.status(400).json({ ok: false, error: 'pct must be 1–95' });

      const { data: posRow } = await supabase.from('positions')
        .select('position_id, asset, qty_open, avg_cost_krw, strategy_tag, state')
        .eq('asset', asset).eq('managed', true).in('state', ['open', 'adopted', 'partial'])
        .order('created_at', { ascending: false }).limit(1).single();

      if (!posRow || Number(posRow.qty_open) <= 0) {
        return res.status(400).json({ ok: false, error: `No open position for ${asset}` });
      }

      const sellQty = Number(posRow.qty_open) * (pct / 100);
      const upbit = require('../lib/upbit');
      let ticker;
      try {
        const tickers = await upbit.getTicker([`KRW-${asset}`]);
        ticker = tickers?.[0];
      } catch (_) {}
      const currentPrice = ticker?.trade_price ?? 0;
      const estimatedKrw = sellQty * currentPrice;

      if (estimatedKrw < 5000) {
        return res.status(400).json({ ok: false, error: `Order too small: ≈₩${Math.round(estimatedKrw)} (min ₩5,000)` });
      }

      const { executeSell } = require('../lib/executionEngine');
      const exit = { asset, sellPct: pct, reason: `manual_withdrawal_${pct}%` };
      const result = await executeSell(supabase, exit, posRow, currentPrice, { regime: null });

      if (!result.ok) {
        return res.status(500).json({ ok: false, error: result.error || 'Sell failed' });
      }

      // Apply fill to position (qty_open update)
      const filledQty = result.fills?.reduce((s, f) => s + Number(f.qty || 0), 0) || sellQty;
      const newQtyOpen = Math.max(0, Number(posRow.qty_open) - filledQty);
      const pnl = (currentPrice - (posRow.avg_cost_krw ?? 0)) * filledQty;
      await supabase.from('positions').update({
        qty_open: newQtyOpen,
        realized_pnl: (Number(posRow.realized_pnl ?? 0) + pnl),
        state: newQtyOpen <= 0 ? 'closed' : 'partial',
        closed_at: newQtyOpen <= 0 ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq('position_id', posRow.position_id);

      await supabase.from('bot_events').insert({
        event_type: 'MANUAL_WITHDRAWAL',
        severity: 'warn',
        subsystem: 'manual',
        message: `Manual sell ${pct}% of ${asset} — ${filledQty.toFixed(8)} ${asset} ≈₩${Math.round(estimatedKrw).toLocaleString()}`,
        context_json: {
          asset, pct, sellQty: +sellQty.toFixed(8), filledQty: +filledQty.toFixed(8),
          estimatedKrw: Math.round(estimatedKrw), newQtyOpen: +newQtyOpen.toFixed(8),
          orderId: result.orderId, fills: result.fills?.length ?? 0,
        },
      });

      return res.status(200).json({
        ok: true, success: true,
        soldQty: +filledQty.toFixed(8),
        estimatedKrw: Math.round(estimatedKrw),
        newQtyOpen: +newQtyOpen.toFixed(8),
      });
    }

    // ── GET weekly-summary — pre-aggregated 7-day performance ──────────────
    if (action === 'weekly-summary' && req.method === 'GET') {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [fillsRes, closedRes, cfgRes] = await Promise.all([
        supabase.from('v2_fills')
          .select('side,price_krw,qty,fee_krw,entry_reason,executed_at')
          .gte('executed_at', since)
          .order('executed_at', { ascending: true }),
        supabase.from('positions')
          .select('realized_pnl,avg_cost_krw,opened_at,closed_at')
          .eq('state', 'closed')
          .gte('closed_at', since),
        supabase.from('bot_config')
          .select('target_deployment_pct,target_entries_per_position,krw_min_reserve_pct')
          .limit(1).single(),
      ]);

      const fills = fillsRes.data || [];
      const closed = closedRes.data || [];
      const cfg = cfgRes.data || {};

      // Daily P&L from sells (gross - fee per fill, grouped by date)
      const dailyPnl = {};
      const dailyBuys = {};
      const dailySells = {};
      const rungStats = {};
      const buyRsiValues = [];

      for (const f of fills) {
        const day = f.executed_at?.slice(0, 10) || 'unknown';
        if (!dailyBuys[day]) { dailyBuys[day] = 0; dailySells[day] = 0; dailyPnl[day] = 0; }

        if (f.side === 'buy') {
          dailyBuys[day]++;
          const rsiMatch = f.entry_reason?.match(/RSI[=:]?([\d.]+)/i);
          if (rsiMatch) buyRsiValues.push(Number(rsiMatch[1]));
        } else if (f.side === 'sell') {
          dailySells[day]++;
          const gross = Number(f.price_krw || 0) * Number(f.qty || 0);
          const fee = Number(f.fee_krw || 0);
          const net = gross - fee;
          dailyPnl[day] += net;

          // Parse rung from entry_reason
          const reason = f.entry_reason || '';
          const rungMatch = reason.match(/^([a-z_]+?)(?:_[\d.]+|$)/);
          const rung = rungMatch ? rungMatch[1] : reason.split('_').slice(0, 2).join('_') || 'unknown';
          if (!rungStats[rung]) rungStats[rung] = { fires: 0, totalNet: 0 };
          rungStats[rung].fires++;
          rungStats[rung].totalNet += net;
        }
      }

      // Build daily array for last 7 days
      const dailyArr = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        dailyArr.push({
          date: d,
          pnl: Math.round(dailyPnl[d] || 0),
          buys: dailyBuys[d] || 0,
          sells: dailySells[d] || 0,
        });
      }

      // Rung performance table
      const rungTable = Object.entries(rungStats)
        .map(([rung, s]) => ({ rung, fires: s.fires, totalNet: Math.round(s.totalNet), avgNet: Math.round(s.totalNet / s.fires) }))
        .sort((a, b) => b.fires - a.fires);

      // Closed positions stats
      const holdHours = closed
        .filter(p => p.opened_at && p.closed_at)
        .map(p => (new Date(p.closed_at) - new Date(p.opened_at)) / 3_600_000);
      const avgHoldHours = holdHours.length > 0 ? holdHours.reduce((a, b) => a + b, 0) / holdHours.length : null;

      // Summary stats
      const totalRealized = dailyArr.reduce((s, d) => s + d.pnl, 0);
      const bestDay = dailyArr.reduce((best, d) => d.pnl > best.pnl ? d : best, dailyArr[0]);
      const worstDay = dailyArr.reduce((worst, d) => d.pnl < worst.pnl ? d : worst, dailyArr[0]);
      const avgDailyPnl = Math.round(totalRealized / 7);
      const avgBuyRsi = buyRsiValues.length > 0 ? +(buyRsiValues.reduce((a, b) => a + b, 0) / buyRsiValues.length).toFixed(1) : null;

      return res.status(200).json({
        daily: dailyArr,
        summary: {
          totalRealized: Math.round(totalRealized),
          bestDay: { date: bestDay?.date, pnl: bestDay?.pnl },
          worstDay: { date: worstDay?.date, pnl: worstDay?.pnl },
          avgDailyPnl,
        },
        rungTable,
        entryQuality: {
          avgBuyRsi,
          avgHoldHours: avgHoldHours != null ? +avgHoldHours.toFixed(1) : null,
          positionsClosed: closed.length,
        },
        config: {
          target_deployment_pct: cfg.target_deployment_pct,
          target_entries_per_position: cfg.target_entries_per_position,
          krw_min_reserve_pct: cfg.krw_min_reserve_pct,
        },
      });
    }

    return res.status(400).json({ error: 'Unknown action. Use ?action=status|execute|config|v2-config|kill-switch|logs|diagnostics|export|diagnostic-export|structured-export|trade-verification|tuning-export|regime|positions|classify-position|orders|nav|circuit-breakers|adoption|clear-freeze|reconcile|bot-config|weekly-summary|manual-sell' });
  } catch (err) {
    console.error('crypto-trader', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
