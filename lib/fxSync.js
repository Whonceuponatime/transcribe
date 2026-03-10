/**
 * Daily sync: fetch FRED, compute indicators, upsert snapshots, run advisor, upsert advice.
 * Backfill = run for last 400+ trading days.
 */

const { fetchAllFredSeries } = require('./fredClient');
const { computeSnapshots } = require('./fxIndicators');
const { runAdvisor } = require('./fxDecisionEngine');

/**
 * observation_start for FRED: ~500 trading days ≈ 730 calendar days.
 */
function observationStartForBackfill() {
  const d = new Date();
  d.setDate(d.getDate() - 730);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} supabase - Supabase client (service role)
 * @param {string} fredApiKey
 * @param {object} options - { backfill?: boolean (use 730d start), user_cash_krw?: number }
 */
async function runSync(supabase, fredApiKey, options = {}) {
  const observationStart = options.backfill ? observationStartForBackfill() : observationStartForBackfill();
  const fredData = await fetchAllFredSeries(fredApiKey, observationStart);
  const snapshots = computeSnapshots(fredData);
  if (!snapshots.length) {
    return { ok: false, error: 'No snapshots computed', snapshots: 0 };
  }

  const { data: existingFlags } = await supabase.from('fx_manual_flags').select('flag_date, event_risk_flag');
  const flagByDate = new Map((existingFlags || []).map((f) => [f.flag_date, !!f.event_risk_flag]));

  for (const row of snapshots) {
    row.manual_event_risk_flag = flagByDate.get(row.snapshot_date) ?? false;
  }

  const upsertPayload = snapshots.map((s) => ({
    snapshot_date: s.snapshot_date,
    usdkrw_spot: s.usdkrw_spot,
    usd_broad_index_proxy: s.usd_broad_index_proxy,
    nasdaq100: s.nasdaq100,
    korea_equity_proxy: s.korea_equity_proxy,
    vix: s.vix,
    us2y: s.us2y,
    kr_rate_proxy: s.kr_rate_proxy,
    usdkrw_ma20: s.usdkrw_ma20,
    usdkrw_ma60: s.usdkrw_ma60,
    usdkrw_ma120: s.usdkrw_ma120,
    usdkrw_zscore_20: s.usdkrw_zscore_20,
    usdkrw_percentile_252: s.usdkrw_percentile_252,
    usd_broad_index_proxy_ma20: s.usd_broad_index_proxy_ma20,
    usd_broad_index_proxy_ma60: s.usd_broad_index_proxy_ma60,
    usd_broad_index_proxy_zscore_20: s.usd_broad_index_proxy_zscore_20,
    nasdaq100_return_20d: s.nasdaq100_return_20d,
    korea_equity_proxy_return_20d: s.korea_equity_proxy_return_20d,
    vix_change_5d: s.vix_change_5d,
    rate_spread_us_minus_kr: s.rate_spread_us_minus_kr,
    korea_rate_is_forward_filled: s.korea_rate_is_forward_filled,
    manual_event_risk_flag: s.manual_event_risk_flag,
    source_dates: s.source_dates || {},
  }));

  const { error: upsertErr } = await supabase
    .from('fx_market_snapshots')
    .upsert(upsertPayload, { onConflict: 'snapshot_date' });

  if (upsertErr) {
    return { ok: false, error: upsertErr.message, snapshots: snapshots.length };
  }

  const latest = snapshots[snapshots.length - 1];
  const advice = runAdvisor(latest, { user_cash_krw: options.user_cash_krw });

  const adviceRow = {
    snapshot_date: latest.snapshot_date,
    decision: advice.decision,
    allocation_pct: advice.allocation_pct,
    confidence: advice.confidence,
    score: advice.score,
    valuation_label: advice.valuation_label,
    summary: advice.summary,
    why: advice.why,
    red_flags: advice.red_flags,
    next_trigger_to_watch: advice.next_trigger_to_watch,
    advisor_version: 'fred-v1',
  };

  const { error: adviceErr } = await supabase
    .from('fx_advice_runs')
    .upsert(adviceRow, { onConflict: 'snapshot_date' });

  if (adviceErr) {
    return { ok: true, snapshots: snapshots.length, adviceError: adviceErr.message, latestAdvice: advice };
  }

  return {
    ok: true,
    snapshots: snapshots.length,
    latest_date: latest.snapshot_date,
    advice: { ...advice, snapshot_date: latest.snapshot_date },
  };
}

module.exports = {
  runSync,
  observationStartForBackfill,
};
