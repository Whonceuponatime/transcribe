/**
 * KRW→USD Buy Advisor. Analysis only, no execution.
 * Background assumption: KRW depreciates long-term. The question is WHEN to buy USD, not IF.
 *
 * Data sources:
 *   - ExchangeRate-API (free, no key needed) for current live USD/KRW rate
 *   - FRED DEXKOUS for historical daily USD/KRW (delayed 1-2 business days)
 *   - FRED DTWEXBGS, VIXCLS, NASDAQ100 for macro context
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// ─── Live rate ──────────────────────────────────────────────────────────
async function fetchLiveRate() {
  const url = 'https://api.exchangerate-api.com/v4/latest/USD';
  const res = await axios.get(url, { timeout: 10000 });
  const rate = res.data?.rates?.KRW;
  if (rate == null || Number(rate) <= 0) throw new Error('No KRW rate');
  return { rate: Number(rate), date: res.data?.date || new Date().toISOString().slice(0, 10), provider: 'exchangerate-api' };
}

// ─── FRED history ───────────────────────────────────────────────────────
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

async function fetchFredSeries(seriesId, apiKey, startDate) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=${startDate}&sort_order=asc`;
  const res = await axios.get(url, { timeout: 20000 });
  return (res.data?.observations || [])
    .filter((o) => o.value !== '.' && o.value != null && o.value !== '')
    .map((o) => ({ date: o.date, value: Number(o.value) }));
}

async function fetchHistory(apiKey) {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  const startStr = start.toISOString().slice(0, 10);

  const [usdkrw, broad, vix, nasdaq] = await Promise.all([
    fetchFredSeries('DEXKOUS', apiKey, startStr),
    fetchFredSeries('DTWEXBGS', apiKey, startStr),
    fetchFredSeries('VIXCLS', apiKey, startStr),
    fetchFredSeries('NASDAQ100', apiKey, startStr),
  ]);
  return { usdkrw, broad, vix, nasdaq };
}

// ─── Indicators ─────────────────────────────────────────────────────────
function ma(values, n) {
  if (values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function percentileRank(sorted, value) {
  if (!sorted.length) return null;
  return sorted.filter((v) => v <= value).length / sorted.length;
}

function zscore(values, n) {
  if (values.length < n) return null;
  const slice = values.slice(-n);
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (values[values.length - 1] - mean) / sd;
}

function computeIndicators(history, liveRate) {
  const closes = history.map((h) => h.value);
  closes.push(liveRate);
  const spot = liveRate;
  const ma20 = ma(closes, 20);
  const ma60 = ma(closes, 60);
  const ma120 = ma(closes, 120);
  const z20 = zscore(closes, 20);
  const sorted252 = closes.slice(-252).sort((a, b) => a - b);
  const pct252 = percentileRank(sorted252, spot);
  return { spot, ma20, ma60, ma120, zscore20: z20, percentile252: pct252 };
}

// ─── Signal engine ──────────────────────────────────────────────────────
// Background: KRW depreciates over time. We always want to buy USD.
// The question is timing: is NOW a good time (USD is cheap) or should we wait?
// Lower USD/KRW = USD is cheaper in KRW = better time to buy USD.

function generateSignal(indicators, macro) {
  const { spot, ma20, ma60, ma120, zscore20, percentile252 } = indicators;
  let score = 0;
  const reasons = [];
  const warnings = [];

  // Primary: where is USD/KRW vs recent history?
  // LOW percentile = USD is cheap relative to history = good time to buy
  if (percentile252 != null) {
    if (percentile252 <= 0.15) {
      score += 4;
      reasons.push(`USD/KRW is in the bottom 15% of the past year — USD is cheap`);
    } else if (percentile252 <= 0.30) {
      score += 3;
      reasons.push(`USD/KRW is in the bottom 30% — USD is below average price`);
    } else if (percentile252 <= 0.50) {
      score += 1;
      reasons.push(`USD/KRW is in the lower half — fair value`);
    } else if (percentile252 >= 0.85) {
      score -= 3;
      warnings.push(`USD/KRW is in the top 15% of the year — USD is expensive right now`);
    } else if (percentile252 >= 0.70) {
      score -= 2;
      warnings.push(`USD/KRW is in the top 30% — USD is pricey`);
    }
  }

  // Moving averages: is spot below MAs? That means USD has gotten cheaper recently
  if (spot != null && ma20 != null && spot < ma20) {
    score += 1;
    reasons.push('Spot is below 20-day average — short-term dip');
  }
  if (spot != null && ma60 != null && spot < ma60) {
    score += 1;
    reasons.push('Spot is below 60-day average — meaningful pullback');
  }
  if (spot != null && ma120 != null && spot < ma120) {
    score += 1;
    reasons.push('Spot is below 120-day average — significant discount');
  }

  // Z-score: how unusual is the current level?
  if (zscore20 != null) {
    if (zscore20 <= -1.0) {
      score += 2;
      reasons.push('Rate is unusually low vs recent 20 days (z-score below -1)');
    } else if (zscore20 <= -0.5) {
      score += 1;
      reasons.push('Rate is slightly below recent average');
    } else if (zscore20 >= 1.5) {
      score -= 2;
      warnings.push('Rate is unusually high vs recent 20 days');
    } else if (zscore20 >= 1.0) {
      score -= 1;
      warnings.push('Rate is elevated vs recent average');
    }
  }

  // Macro: VIX calm = less risk, Nasdaq up = risk-on (both slightly favor buying)
  if (macro.vixCalm) { score += 1; reasons.push('VIX is calm — low market stress'); }
  if (macro.vixHigh) { score -= 1; warnings.push('VIX is elevated — market stress (wait might be wise)'); }
  if (macro.nasdaqUp) { score += 1; reasons.push('Nasdaq trend positive — risk-on environment'); }

  // Background assumption: KRW will depreciate over time
  reasons.push('Long-term KRW depreciation trend supports accumulating USD');

  // Decision mapping
  let decision, allocation, summary;
  if (score >= 6) {
    decision = 'BUY_NOW';
    allocation = 100;
    summary = 'Strong buy signal. USD is cheap relative to recent history. Consider converting a large portion now.';
  } else if (score >= 4) {
    decision = 'BUY_NOW';
    allocation = 50;
    summary = 'Good buying opportunity. USD is attractively priced. Consider converting 50%.';
  } else if (score >= 2) {
    decision = 'SCALE_IN';
    allocation = 25;
    summary = 'Decent entry. Consider scaling in with a smaller amount (25%).';
  } else if (score >= 0) {
    decision = 'WAIT';
    allocation = 0;
    summary = 'USD is around fair value or slightly expensive. Wait for a better entry unless you need USD urgently.';
  } else {
    decision = 'WAIT';
    allocation = 0;
    summary = 'USD is expensive right now. Wait for the rate to come down before buying.';
  }

  const confidence = Math.min(100, Math.max(5, 40 + score * 8));

  const nextTriggers = [];
  if (decision === 'WAIT') {
    if (ma20 != null) nextTriggers.push(`Watch for USD/KRW to drop below ${Math.round(ma20)} (20-day avg)`);
    if (ma60 != null) nextTriggers.push(`Better entry around ${Math.round(ma60)} (60-day avg)`);
  }
  if (decision === 'SCALE_IN') {
    nextTriggers.push('If rate drops further, consider adding more');
  }

  return {
    decision,
    allocation_pct: allocation,
    confidence,
    score,
    valuation_label: percentile252 <= 0.30 ? 'CHEAP' : percentile252 >= 0.70 ? 'EXPENSIVE' : 'FAIR',
    summary,
    why: reasons,
    red_flags: warnings,
    next_trigger_to_watch: nextTriggers,
    levels: {
      spot: indicators.spot,
      ma20: indicators.ma20,
      ma60: indicators.ma60,
      ma120: indicators.ma120,
      zscore20: indicators.zscore20,
      percentile252: indicators.percentile252,
    },
  };
}

// ─── Sync: fetch live + history, compute, store ─────────────────────────
async function runLiveSync(supabase) {
  const apiKey = process.env.FRED_API_KEY;
  const live = await fetchLiveRate();
  const history = apiKey ? await fetchHistory(apiKey) : { usdkrw: [], broad: [], vix: [], nasdaq: [] };

  const indicators = computeIndicators(history.usdkrw, live.rate);

  const latestVix = history.vix.length ? history.vix[history.vix.length - 1].value : null;
  const latestNasdaq = history.nasdaq.length ? history.nasdaq[history.nasdaq.length - 1].value : null;
  const nasdaq20ago = history.nasdaq.length >= 21 ? history.nasdaq[history.nasdaq.length - 21].value : null;

  const macro = {
    vixCalm: latestVix != null && latestVix < 20,
    vixHigh: latestVix != null && latestVix > 28,
    nasdaqUp: latestNasdaq != null && nasdaq20ago != null && latestNasdaq > nasdaq20ago,
  };

  const signal = generateSignal(indicators, macro);
  const now = new Date().toISOString();

  await supabase.from('fx_live_quotes').insert({
    symbol: 'USDKRW',
    provider: live.provider,
    bid: null,
    ask: null,
    mid: live.rate,
    spread: null,
    quote_ts: now,
    received_ts: now,
    is_stale: false,
    raw_payload: { date: live.date },
  });

  await supabase.from('fx_signal_runs').insert({
    signal_ts: now,
    symbol: 'USDKRW',
    decision: signal.decision,
    allocation_pct: signal.allocation_pct,
    confidence: signal.confidence,
    score: signal.score,
    valuation_label: signal.valuation_label,
    live_provider: live.provider,
    quote_timestamp: now,
    is_stale: false,
    summary: signal.summary,
    why: signal.why,
    red_flags: signal.red_flags,
    next_trigger_to_watch: signal.next_trigger_to_watch,
    levels: signal.levels,
  });

  await supabase.from('provider_health').insert({
    provider: live.provider,
    checked_at: now,
    status: 'up',
    latency_ms: 0,
    stale_seconds: 0,
    details: { rate: live.rate },
  });

  return {
    ok: true,
    provider: live.provider,
    rate: live.rate,
    signal: { ...signal, live_provider: live.provider, quote_timestamp: now, is_stale: false },
  };
}

// ─── Macro sync: write FRED history into snapshots for charts ───────────
async function runMacroSync(supabase) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('FRED_API_KEY not set');
  const history = await fetchHistory(apiKey);

  const toMap = (arr) => { const m = new Map(); arr.forEach((o) => m.set(o.date, o.value)); return m; };
  const mUsd = toMap(history.usdkrw);
  const mBroad = toMap(history.broad);
  const mNas = toMap(history.nasdaq);
  const mVix = toMap(history.vix);

  const dates = Array.from(new Set([...mUsd.keys(), ...mBroad.keys(), ...mNas.keys(), ...mVix.keys()])).sort();

  let lastSpot = null;
  const rows = [];
  for (const date of dates) {
    let spot = mUsd.get(date) ?? null;
    if (typeof spot !== 'number' || !Number.isFinite(spot)) spot = null;
    if (spot != null) lastSpot = spot;
    if (spot == null) spot = lastSpot;
    if (spot == null) continue;
    rows.push({
      snapshot_ts: `${date}T00:00:00.000Z`,
      symbol: 'USDKRW',
      live_provider: 'fred',
      spot,
      usd_broad_index_proxy: mBroad.get(date) ?? null,
      nasdaq100: mNas.get(date) ?? null,
      vix: mVix.get(date) ?? null,
      source_dates: {},
    });
  }

  const chunkSize = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from('fx_analyzer_snapshots').upsert(chunk, { onConflict: 'snapshot_ts' });
    if (error) throw new Error(error.message);
    upserted += chunk.length;
  }

  return { ok: true, upserted_days: upserted };
}

// ─── Reads ──────────────────────────────────────────────────────────────
async function getLatestQuote(supabase) {
  const { data } = await supabase
    .from('fx_live_quotes').select('*').eq('symbol', 'USDKRW')
    .order('quote_ts', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

async function getLatestSignal(supabase) {
  const { data } = await supabase
    .from('fx_signal_runs').select('*')
    .order('signal_ts', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

async function getBarsForSnapshot(supabase, limit = 500) {
  const { data } = await supabase
    .from('fx_bars_1m').select('bucket_ts, open, high, low, close')
    .eq('symbol', 'USDKRW').order('bucket_ts', { ascending: true });
  return (data || []).slice(-limit);
}

// ─── Trade journal ──────────────────────────────────────────────────────
async function recordTrade(supabase, trade) {
  const { data, error } = await supabase
    .from('fx_manual_trades')
    .insert({
      action: trade.action,
      krw_amount: trade.krw_amount,
      usd_amount: trade.usd_amount,
      fx_rate: trade.fx_rate,
      fees_krw: trade.fees_krw ?? 0,
      note: trade.note,
      related_signal_id: trade.related_signal_id ?? null,
    })
    .select().single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, trade: data };
}

module.exports = {
  getSupabase,
  fetchLiveRate,
  fetchHistory,
  computeIndicators,
  generateSignal,
  runLiveSync,
  runMacroSync,
  getLatestQuote,
  getLatestSignal,
  getBarsForSnapshot,
  recordTrade,
};
