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
        // V2 bot_config (for current mode)
        safe(supabase.from('bot_config').select('mode, enabled, coins').limit(1).single()),
      ]);

      const botLogs      = botLogsRes.data    || [];
      const botEvents    = botEventsRes.data   || [];
      const v1Trades     = tradesRes.data      || [];
      const reconRuns    = reconRes.data        || [];
      const adoptionRuns = adoptionRes.data     || [];
      const positions    = positionsRes.data    || [];
      const v2Orders     = v2OrdersRes.data     || [];
      const v2CurrentMode = v2ConfigRes.data?.mode ?? 'unknown';

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
      // V1 always places live orders (crypto_trade_log). V1 has no paper mode.
      // V2 places orders in orders table, each tagged with mode=paper/shadow/live.
      const v1HasTrades          = v1Trades.length > 0;
      const v2LiveOrders         = v2Orders.filter((o) => o.mode === 'live');
      const v2PaperOrders        = v2Orders.filter((o) => o.mode === 'paper' || o.mode === 'shadow');
      const v2HasLiveOrders      = v2LiveOrders.length > 0;
      const v2HasAnyOrders       = v2Orders.length > 0;

      // Live account mutations: V1 trades are always live. V2 live orders are live.
      const liveMutationsDetected = v1HasTrades || v2HasLiveOrders;

      // Mixed-mode risk: V1 placed live trades while V2 is in paper mode.
      // This means live account state diverges from V2's internal position model.
      const mixedModeRisk = v1HasTrades && v2CurrentMode === 'paper';

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
        sellCycleAuditCoverage: {
          exit_evaluation_events:              (v2ByType['EXIT_EVALUATION']            || []).length,
          position_skip_protected_events:      (v2ByType['POSITION_SKIP_PROTECTED']    || []).length,
          execution_events:                    (v2ByType['EXECUTION']                  || []).length,
          cycle_frozen_events:                 (v2ByType['CYCLE_FROZEN']               || []).length,
          v2_frozen_entire_window:             v2WasFrozenEntireWindow,
          gap_detected:                        (v2ByType['EXIT_EVALUATION'] || []).length === 0,
          likely_cause:                        v2WasFrozenEntireWindow
            ? 'V2 was frozen the entire export window. executeCycleV2() returns early before reaching sell logic — EXIT_EVALUATION, POSITION_SKIP_PROTECTED, and EXECUTION are expected to be empty. See CYCLE_FROZEN events for details.'
            : (v2ByType['EXIT_EVALUATION'] || []).length === 0
              ? 'V2 may still be frozen or no positions reached the required profit edge. Check CYCLE_FROZEN and RECONCILIATION events.'
              : null,
        },
        // Q3: Live mutations while V2 was paper
        mixedModeAnalysis: {
          v1_live_trades_in_window:            v1Trades.length,
          v2_mode_at_export_time:              v2CurrentMode,
          v2_live_orders_in_window:            v2LiveOrders.length,
          v2_paper_orders_in_window:           v2PaperOrders.length,
          mixed_mode_risk_explanation:         mixedModeRisk
            ? 'V1 placed real trades on the Upbit account while V2 was in paper mode. V2 position quantities in the DB are now out of sync with the exchange. This caused the balance_mismatch reconciliation freeze.'
            : null,
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

        // ── Q1, Q2, Q3, Q7: Engine source + mode + mutations ─────────────
        orderSourceSummary,
        liveAccountMutationsDetected: liveMutationsDetected,
        mixedModeRisk,

        // ── Current system state ──────────────────────────────────────────
        systemState: {
          v2Mode:               v2CurrentMode,
          freezeState:          freezeRes.data?.value ?? null,
          latestReconciliation: reconStatusRes.data?.value ?? null,
          v2Portfolio:          portfolioRes.data?.value ?? null,
          v1LastCycle:          lastCycleRes.data?.value ?? null,
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
