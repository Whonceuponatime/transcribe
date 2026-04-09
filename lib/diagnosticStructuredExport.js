/**
 * Unified structured diagnostic export — source-of-truth DB rows only (no PM2 text logs).
 * Used by GET /api/crypto-trader?action=structured-export and GET /api/diagnostics/export.
 */

const { getApiRuntimeMetadata } = require('./runtimeMetadata');

function normalizeBlockerKey(s) {
  if (!s || typeof s !== 'string') return null;
  return s
    .replace(/=[0-9.\-]+/g, '=N')
    .replace(/\d+h/g, 'Nh')
    .replace(/\d+m/g, 'Nm');
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ hours?: number }} opts
 * @returns {Promise<object>}
 */
async function buildStructuredDiagnosticsExport(supabase, { hours = 24 } = {}) {
  const windowHours = Math.min(Math.max(Number(hours) || 24, 1), 168);
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const safe = async (q) => {
    try {
      const r = await q;
      return r;
    } catch (_) {
      return { data: null, error: _ };
    }
  };

  const [
    cfgRes,
    freezeRes,
    regimeRes,
    riskRes,
    ksRes,
    hbRes,
    snapRes,
    reconAppRes,
    traderRuntimeRes,
    positionsRes,
    fillsRes,
    ordersRes,
    decisionRes,
    exitEvalRes,
    reconEventsRes,
    errorEventsRes,
    execEventsRes,
  ] = await Promise.all([
    supabase.from('bot_config').select('*').limit(1).single(),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'system_freeze').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'current_regime').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'risk_engine_state').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'kill_switch').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'pi_heartbeat').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'v2_portfolio_snapshot').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'latest_reconciliation').single()),
    safe(supabase.from('app_settings').select('value, updated_at').eq('key', 'trader_runtime_metadata').single()),
    supabase.from('positions').select('*').in('state', ['open', 'adopted', 'partial']),
    supabase
      .from('v2_fills')
      .select('*')
      .gte('executed_at', since)
      .order('executed_at', { ascending: false })
      .limit(2000),
    supabase
      .from('orders')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    supabase
      .from('bot_events')
      .select('id, event_type, severity, subsystem, message, context_json, regime, mode, created_at')
      .eq('event_type', 'DECISION_CYCLE')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('bot_events')
      .select('id, event_type, severity, subsystem, message, context_json, regime, mode, created_at')
      .eq('event_type', 'EXIT_EVALUATION')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(3000),
    supabase
      .from('bot_events')
      .select('id, event_type, severity, subsystem, message, context_json, regime, mode, created_at')
      .eq('event_type', 'RECONCILIATION')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('bot_events')
      .select('id, event_type, severity, subsystem, message, context_json, regime, mode, created_at')
      .in('severity', ['error', 'warn'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('bot_events')
      .select('id, event_type, severity, subsystem, message, context_json, regime, mode, created_at')
      .eq('event_type', 'EXECUTION')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
  ]);

  const fills = fillsRes.data || [];
  const decisions = decisionRes.data || [];
  const exitEvals = exitEvalRes.data || [];

  const blockerMap = new Map();
  function bump(source, raw) {
    const norm = normalizeBlockerKey(raw) || raw;
    if (!norm) return;
    const key = `${source}|${norm}`;
    blockerMap.set(key, (blockerMap.get(key) || 0) + 1);
  }

  for (const ev of decisions) {
    const cx = ev.context_json || {};
    const sc = cx.sell_checks || {};
    if (sc.final_sell_blocker) bump('DECISION_CYCLE.sell', sc.final_sell_blocker);
    const bc = cx.buy_checks || {};
    if (bc && Object.keys(bc).length > 0 && bc.final_buy_eligible === false && cx.final_reason) {
      bump('DECISION_CYCLE.buy', cx.final_reason);
    }
  }
  for (const ev of exitEvals) {
    const cx = ev.context_json || {};
    if (cx.blocker_summary) bump('EXIT_EVALUATION', cx.blocker_summary);
  }

  const blocker_summaries = Array.from(blockerMap.entries())
    .map(([compound, count]) => {
      const pipe = compound.indexOf('|');
      const source = pipe >= 0 ? compound.slice(0, pipe) : 'unknown';
      const blocker_normalized = pipe >= 0 ? compound.slice(pipe + 1) : compound;
      return { source, blocker_normalized, count };
    })
    .sort((a, b) => b.count - a.count);

  const top_blockers_by_count = blocker_summaries.slice(0, 25);

  let buy = 0;
  let sell = 0;
  for (const f of fills) {
    if (f.side === 'buy') buy += 1;
    else if (f.side === 'sell') sell += 1;
  }

  const active_bot_config = cfgRes.data && !cfgRes.error ? cfgRes.data : null;
  const openPositions = positionsRes.error ? [] : positionsRes.data || [];

  const latest_system_state = {
    system_freeze: freezeRes.data?.value ?? null,
    system_freeze_updated_at: freezeRes.data?.updated_at ?? null,
    current_regime: regimeRes.data?.value ?? null,
    current_regime_updated_at: regimeRes.data?.updated_at ?? null,
    risk_engine_state: riskRes.data?.value ?? null,
    risk_engine_updated_at: riskRes.data?.updated_at ?? null,
    kill_switch: ksRes.data?.value ?? null,
    pi_heartbeat: hbRes.data?.value ?? null,
    v2_portfolio_snapshot: snapRes.data?.value ?? null,
    latest_reconciliation: reconAppRes.data?.value ?? null,
  };

  const recent_fills_executions = [
    ...(fillsRes.data || []).map((row) => ({ record_type: 'v2_fill', ...row })),
    ...(execEventsRes.data || []).map((row) => ({
      record_type: 'execution_event',
      id: row.id,
      severity: row.severity,
      message: row.message,
      context_json: row.context_json,
      regime: row.regime,
      created_at: row.created_at,
    })),
  ];

  return {
    export_schema_version: 3,
    generated_at: new Date().toISOString(),
    api_runtime_metadata: getApiRuntimeMetadata(),
    trader_runtime_metadata: traderRuntimeRes.data?.value ?? null,
    trader_runtime_metadata_updated_at: traderRuntimeRes.data?.updated_at ?? null,
    window_hours: windowHours,
    window_since_iso: since,
    active_bot_config,
    latest_system_state,
    open_positions: openPositions,
    recent_fills_executions,
    recent_orders_intents: ordersRes.data || [],
    recent_decision_cycles: decisions,
    recent_exit_evaluations: exitEvals,
    recent_reconciliation_events: reconEventsRes.data || [],
    recent_error_events: errorEventsRes.data || [],
    blocker_summaries,
    buy_sell_counts: { buy, sell },
    top_blockers_by_count,
  };
}

module.exports = {
  buildStructuredDiagnosticsExport,
  normalizeBlockerKey,
};
