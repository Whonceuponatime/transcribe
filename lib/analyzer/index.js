/**
 * Analyzer-only KRW→USD advisor. No execution, no broker, manual trading only.
 */

const { createClient } = require('@supabase/supabase-js');
const { ingestQuote } = require('./quoteIngestion');
const { aggregateBarsFromQuotes, getRecentQuotes, ensureRecentBars } = require('./barAggregation');
const { syncMacro } = require('./macroSync');
const { computeFromBars } = require('./indicatorEngine');
const { runSignal } = require('./signalEngine');
const { recordTrade, getTrades, getJournalStats } = require('./manualTradeJournal');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

async function getLatestQuote(supabase) {
  const { data } = await supabase
    .from('fx_live_quotes')
    .select('*')
    .eq('symbol', 'USDKRW')
    .order('quote_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function getLatestSignal(supabase) {
  const { data } = await supabase
    .from('fx_signal_runs')
    .select('*')
    .order('signal_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function runLiveSync(supabase) {
  const ingest = await ingestQuote(supabase);
  if (!ingest.ok) return { ok: false, error: 'No quote from Massive or Finnhub' };
  await aggregateBarsFromQuotes(supabase, 'USDKRW');
  await ensureRecentBars(supabase, 'USDKRW', 240);

  const bars = await getBarsForSnapshot(supabase, 500);
  const levels = computeFromBars(bars);
  const quote = await getLatestQuote(supabase);
  const macro = await getLatestMacroForSignal(supabase);

  const levelsWithQuote = {
    ...(levels || {}),
    spot: (levels && levels.spot != null) ? levels.spot : quote?.mid,
    bid: quote?.bid,
    ask: quote?.ask,
    spread: quote?.spread,
  };

  const context = {
    spreadAcceptable: quote?.spread != null && quote.spread < quote.mid * 0.005,
    quoteFresh: !quote?.is_stale,
    dataStale: !!quote?.is_stale,
    spreadWide: quote?.spread != null && quote.spread >= quote.mid * 0.01,
    fallbackProvider: ingest.provider === 'finnhub',
    isStale: !!quote?.is_stale,
    insufficientHistory: (bars || []).length < 20,
    dollarWeak: macro?.usd_broad_index_proxy != null && macro.usd_broad_index_proxy_ma20 != null && macro.usd_broad_index_proxy < macro.usd_broad_index_proxy_ma20,
    dollarStrong: macro?.usd_broad_index_proxy != null && macro.usd_broad_index_proxy_ma20 != null && macro.usd_broad_index_proxy > macro.usd_broad_index_proxy_ma20 * 1.02,
    vixCalm: macro?.vix != null && macro.vix < 22,
    vixHigh: macro?.vix != null && macro.vix > 25,
    nasdaqPositive: macro?.nasdaq100_return_20d != null && macro.nasdaq100_return_20d >= 0,
    nasdaqNegative: macro?.nasdaq100_return_20d != null && macro.nasdaq100_return_20d < -0.05,
  };

  const result = runSignal(levelsWithQuote, macro, context);
  const signal_ts = new Date().toISOString();
  await supabase.from('fx_signal_runs').insert({
    signal_ts,
    symbol: 'USDKRW',
    decision: result.decision,
    allocation_pct: result.allocation_pct,
    confidence: result.confidence,
    score: result.score,
    valuation_label: result.valuation_label,
    live_provider: ingest.provider,
    quote_timestamp: quote?.quote_ts ?? null,
    is_stale: !!quote?.is_stale,
    summary: result.summary,
    why: result.why,
    red_flags: result.red_flags,
    next_trigger_to_watch: result.next_trigger_to_watch,
    levels: result.levels,
  });

  await supabase.from('fx_analyzer_snapshots').upsert({
    snapshot_ts: signal_ts,
    symbol: 'USDKRW',
    live_provider: ingest.provider,
    spot: levelsWithQuote.spot,
    bid: quote?.bid,
    ask: quote?.ask,
    spread: quote?.spread,
    ma20: levelsWithQuote.ma20,
    ma60: levelsWithQuote.ma60,
    ma120: levelsWithQuote.ma120,
    zscore20: levelsWithQuote.zscore20,
    percentile252: levelsWithQuote.percentile252,
    usd_broad_index_proxy: macro?.usd_broad_index_proxy,
    usd_broad_index_proxy_ma20: macro?.usd_broad_index_proxy_ma20,
    nasdaq100: macro?.nasdaq100,
    nasdaq100_return_20d: macro?.nasdaq100_return_20d,
    vix: macro?.vix,
    vix_change_5d: macro?.vix_change_5d,
    macro_payload: macro || {},
    source_dates: {},
  }, { onConflict: 'snapshot_ts' });

  return {
    ok: true,
    provider: ingest.provider,
    quote: ingest.quote,
    signal: {
      ...result,
      live_provider: ingest.provider,
      quote_timestamp: quote?.quote_ts ?? null,
      is_stale: !!quote?.is_stale,
    },
  };
}

async function getBarsForSnapshot(supabase, limit = 500) {
  const { data } = await supabase
    .from('fx_bars_1m')
    .select('bucket_ts, open, high, low, close')
    .eq('symbol', 'USDKRW')
    .order('bucket_ts', { ascending: true });
  const bars = (data || []).slice(-limit);
  return bars;
}

async function getLatestMacroForSignal(supabase) {
  const { data } = await supabase
    .from('fx_analyzer_snapshots')
    .select('usd_broad_index_proxy, usd_broad_index_proxy_ma20, nasdaq100, nasdaq100_return_20d, vix, vix_change_5d')
    .order('snapshot_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

module.exports = {
  getSupabase,
  getLatestQuote,
  getLatestSignal,
  runLiveSync,
  syncMacro,
  recordTrade,
  getTrades,
  getJournalStats,
  ingestQuote,
  aggregateBarsFromQuotes,
  getBarsForSnapshot,
};
