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

  const [usdkrw, broad, vix, nasdaq, dgs10, dgs2] = await Promise.all([
    fetchFredSeries('DEXKOUS', apiKey, startStr),
    fetchFredSeries('DTWEXBGS', apiKey, startStr),
    fetchFredSeries('VIXCLS', apiKey, startStr),
    fetchFredSeries('NASDAQ100', apiKey, startStr),
    fetchFredSeries('DGS10', apiKey, startStr),
    fetchFredSeries('DGS2', apiKey, startStr),
  ]);
  return { usdkrw, broad, vix, nasdaq, dgs10, dgs2 };
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

// ─── Macro analysis helpers ─────────────────────────────────────────────
function last(arr) { return arr.length ? arr[arr.length - 1].value : null; }
function lastN(arr, n) { return arr.slice(-n).map((x) => x.value); }
function change(arr, days) {
  if (arr.length < days + 1) return null;
  const prev = arr[arr.length - 1 - days].value;
  const cur = arr[arr.length - 1].value;
  return prev ? ((cur - prev) / prev) * 100 : null;
}
function trend(arr, days) {
  const c = change(arr, days);
  if (c == null) return 'unknown';
  if (c > 1.5) return 'rising';
  if (c < -1.5) return 'falling';
  return 'flat';
}

function buildMacroAnalysis(history) {
  const broadVal = last(history.broad);
  const broadTrend20 = trend(history.broad, 20);
  const broadChange20 = change(history.broad, 20);
  const broadMa60 = ma(lastN(history.broad, 60), 60);

  const vixVal = last(history.vix);
  const vixTrend5 = trend(history.vix, 5);

  const nasdaqVal = last(history.nasdaq);
  const nasdaqChange20 = change(history.nasdaq, 20);

  const us10y = last(history.dgs10);
  const us2y = last(history.dgs2);
  const us10yTrend = trend(history.dgs10, 20);

  return { broadVal, broadTrend20, broadChange20, broadMa60, vixVal, vixTrend5, nasdaqVal, nasdaqChange20, us10y, us2y, us10yTrend };
}

// ─── Signal engine ──────────────────────────────────────────────────────
function generateSignal(indicators, macro) {
  const { spot, ma20, ma60, ma120, zscore20, percentile252 } = indicators;
  const { broadVal, broadTrend20, broadChange20, broadMa60, vixVal, vixTrend5, nasdaqChange20, us10y, us2y, us10yTrend } = macro;

  let score = 0;
  const analysis = []; // structured analysis sections
  const warnings = [];
  const nextTriggers = [];

  const inUptrend = spot != null && ma60 != null && ma120 != null && spot > ma120 && ma60 > ma120;

  // ── 1. USD STRENGTH (Dollar Index) ──
  const dollarSection = { title: 'USD Strength (Broad Dollar Index)', points: [] };
  if (broadVal != null) {
    dollarSection.points.push(`Dollar Index at ${broadVal.toFixed(1)}`);
    if (broadTrend20 === 'rising') {
      score += 1;
      dollarSection.points.push(`Dollar is strengthening (+${broadChange20?.toFixed(1)}% over 20 days) → KRW weakens when USD is strong → USD/KRW goes up → buying USD now locks in before it gets more expensive`);
    } else if (broadTrend20 === 'falling') {
      score += 1;
      dollarSection.points.push(`Dollar is weakening (${broadChange20?.toFixed(1)}% over 20 days) → KRW gets temporary relief → this is a GOOD window to buy USD cheaper before the long-term trend resumes`);
    } else {
      dollarSection.points.push('Dollar is stable — no strong directional pressure on KRW right now');
    }
    if (broadMa60 != null && broadVal > broadMa60) {
      dollarSection.points.push('Dollar is above its 60-day average — structurally strong, supports continued KRW weakness');
    }
  }
  analysis.push(dollarSection);

  // ── 2. US INTEREST RATES ──
  const rateSection = { title: 'US Interest Rates', points: [] };
  if (us10y != null) {
    rateSection.points.push(`US 10-year yield: ${us10y.toFixed(2)}%`);
    if (us10y > 4.0) {
      score += 1;
      rateSection.points.push('High US yields attract global capital into USD → money flows OUT of KRW into USD → KRW weakens. This supports buying USD.');
    } else if (us10y > 3.0) {
      rateSection.points.push('US yields are moderate — still attractive vs Korea rates, supporting USD demand');
    } else {
      rateSection.points.push('US yields are low — less pull factor for USD, but KRW still weakens from structural factors');
    }
    if (us10yTrend === 'rising') {
      rateSection.points.push('Yields are rising → Fed staying hawkish → more pressure on KRW. Buy USD sooner.');
    } else if (us10yTrend === 'falling') {
      score += 1;
      rateSection.points.push('Yields are falling → market expects rate cuts → USD might soften temporarily → good buying window');
    }
  }
  if (us2y != null && us10y != null) {
    const spread = us10y - us2y;
    rateSection.points.push(`Yield curve spread (10Y−2Y): ${spread.toFixed(2)}%${spread < 0 ? ' (inverted — recession signal, but USD usually strengthens in recessions as safe haven)' : ''}`);
  }
  analysis.push(rateSection);

  // ── 3. RISK SENTIMENT ──
  const riskSection = { title: 'Risk Sentiment', points: [] };
  if (vixVal != null) {
    riskSection.points.push(`VIX (fear index): ${vixVal.toFixed(1)}`);
    if (vixVal < 18) {
      score += 1;
      riskSection.points.push('Markets are calm — stable environment to convert KRW to USD without panic premium');
    } else if (vixVal > 25) {
      riskSection.points.push('Markets are stressed — KRW usually weakens MORE during stress (capital flight to USD). USD gets more expensive during crises, so buying before a panic spike is wise.');
      if (vixTrend5 === 'rising') {
        warnings.push('VIX is rising — volatility increasing. KRW may weaken further quickly.');
      }
    } else {
      riskSection.points.push('VIX is moderate — normal conditions');
    }
  }
  if (nasdaqChange20 != null) {
    if (nasdaqChange20 > 3) {
      score += 1;
      riskSection.points.push(`Nasdaq up ${nasdaqChange20.toFixed(1)}% over 20 days — risk-on mode, temporarily supports KRW (good time to buy USD while it's not spiking)`);
    } else if (nasdaqChange20 < -5) {
      riskSection.points.push(`Nasdaq down ${nasdaqChange20.toFixed(1)}% — risk-off, capital flows to USD safe haven → KRW weakens`);
    }
  }
  analysis.push(riskSection);

  // ── 4. USD/KRW VALUATION ──
  const valSection = { title: 'USD/KRW Rate Assessment', points: [] };
  valSection.points.push(`Current rate: ₩${Math.round(spot).toLocaleString()} per $1 USD`);
  if (ma20) valSection.points.push(`20-day avg: ₩${Math.round(ma20).toLocaleString()}`);
  if (ma60) valSection.points.push(`60-day avg: ₩${Math.round(ma60).toLocaleString()}`);
  if (ma120) valSection.points.push(`120-day avg: ₩${Math.round(ma120).toLocaleString()}`);

  if (percentile252 != null) {
    const pctLabel = (percentile252 * 100).toFixed(0);
    if (percentile252 <= 0.15) {
      score += 4;
      valSection.points.push(`Rate is in the bottom ${pctLabel}% of the past year — USD is unusually cheap in KRW. This is a rare buying opportunity.`);
    } else if (percentile252 <= 0.30) {
      score += 3;
      valSection.points.push(`Rate is in the ${pctLabel}th percentile — USD is cheaper than usual. Good timing.`);
    } else if (percentile252 <= 0.50) {
      score += 1;
      valSection.points.push(`Rate is around the ${pctLabel}th percentile — fair value zone.`);
    } else if (percentile252 >= 0.85) {
      score -= (inUptrend ? 1 : 2);
      valSection.points.push(`Rate is in the ${pctLabel}th percentile — USD is expensive vs recent history.${inUptrend ? ' However, KRW is in a weakening trend so this may be the new normal.' : ' Consider buying smaller amounts.'}`);
    } else if (percentile252 >= 0.70) {
      score -= (inUptrend ? 0 : 1);
      valSection.points.push(`Rate is in the ${pctLabel}th percentile — slightly elevated.${inUptrend ? ' Trend supports this level holding.' : ''}`);
    } else {
      valSection.points.push(`Rate is in the ${pctLabel}th percentile — middle range.`);
    }
  }

  if (spot < ma20) { score += 1; valSection.points.push('Spot dipped below 20-day avg — short-term buying opportunity'); }
  if (spot < ma60) { score += 1; valSection.points.push('Spot below 60-day avg — meaningful pullback from trend'); }
  if (spot < ma120) { score += 2; valSection.points.push('Spot below 120-day avg — significant discount, strong buy zone'); }
  if (zscore20 != null && zscore20 <= -1.0) { score += 2; valSection.points.push('Z-score below -1 — rate dropped sharply, good dip entry'); }
  else if (zscore20 != null && zscore20 <= -0.5) { score += 1; }
  if (zscore20 != null && zscore20 >= 1.5) { score -= 1; warnings.push('Rate spiked recently — might see a short-term pullback'); }
  analysis.push(valSection);

  // ── 5. STRUCTURAL VIEW ──
  const structSection = { title: 'Long-term KRW Outlook', points: [] };
  if (inUptrend) {
    score += 1;
    structSection.points.push('USD/KRW is in a confirmed uptrend (spot > 60-day > 120-day avg) — KRW is actively depreciating. Waiting means paying more.');
  }
  structSection.points.push('Korea runs persistent current account pressures, aging demographics, and lower growth vs US — structural KRW depreciation is the baseline expectation.');
  structSection.points.push('The question is not IF you should buy USD, but WHEN and HOW MUCH. Even at "expensive" levels, some accumulation is wise.');
  analysis.push(structSection);

  // ── DECISION ──
  let decision, allocation, summary;
  if (score >= 7) {
    decision = 'BUY_NOW'; allocation = 100;
    summary = 'Strong alignment across rate, macro, and trend. Excellent time to convert a large amount.';
  } else if (score >= 5) {
    decision = 'BUY_NOW'; allocation = 50;
    summary = 'Good conditions. Convert about half of what you planned.';
  } else if (score >= 3) {
    decision = 'SCALE_IN'; allocation = 30;
    summary = 'Conditions are decent. Buy a moderate amount and keep some KRW for potential dips.';
  } else if (score >= 1) {
    decision = 'SCALE_IN'; allocation = 15;
    summary = 'Neutral conditions. Buy a small amount to keep accumulating — KRW weakens over time, but better entries may come.';
  } else {
    decision = 'SCALE_IN'; allocation = 10;
    summary = 'USD is pricier than usual. Buy a small amount (10%) to stay on schedule — KRW will keep depreciating, but save most for a pullback.';
  }

  const confidence = Math.min(100, Math.max(10, 35 + score * 7));

  if (allocation < 50) {
    if (ma20 != null && spot > ma20) nextTriggers.push(`Buy more if rate drops below ₩${Math.round(ma20).toLocaleString()} (20-day avg)`);
    if (ma60 != null && spot > ma60) nextTriggers.push(`Strong buy zone: ₩${Math.round(ma60).toLocaleString()} (60-day avg)`);
  }
  if (inUptrend) nextTriggers.push('KRW trend is down — waiting too long risks paying more');
  if (broadTrend20 === 'falling') nextTriggers.push('Dollar is weakening — this window may not last');

  const valLabel = percentile252 != null && percentile252 <= 0.30 ? 'CHEAP'
    : percentile252 != null && percentile252 >= 0.70 ? (inUptrend ? 'ELEVATED (trend)' : 'PRICEY')
    : 'FAIR';

  return {
    decision,
    allocation_pct: allocation,
    confidence,
    score,
    valuation_label: valLabel,
    summary,
    analysis,
    red_flags: warnings,
    next_trigger_to_watch: nextTriggers,
    levels: { spot, ma20, ma60, ma120, zscore20, percentile252 },
    macro_snapshot: { dollar_index: broadVal, us10y, us2y, vix: macro.vixVal, nasdaq_20d_change: nasdaqChange20 },
  };
}

// ─── Sync: fetch live + history, compute, store ─────────────────────────
async function runLiveSync(supabase) {
  const apiKey = process.env.FRED_API_KEY;
  const live = await fetchLiveRate();
  const history = apiKey ? await fetchHistory(apiKey) : { usdkrw: [], broad: [], vix: [], nasdaq: [], dgs10: [], dgs2: [] };

  const indicators = computeIndicators(history.usdkrw, live.rate);
  const macroData = buildMacroAnalysis(history);
  const signal = generateSignal(indicators, macroData);
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
    why: signal.analysis || [],
    red_flags: signal.red_flags || [],
    next_trigger_to_watch: signal.next_trigger_to_watch || [],
    levels: signal.levels || {},
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

// ─── Crypto purchases ───────────────────────────────────────────────────
async function recordCrypto(supabase, purchase) {
  const { data, error } = await supabase
    .from('crypto_purchases')
    .insert({
      coin: (purchase.coin || 'BTC').toUpperCase(),
      usd_spent: purchase.usd_spent,
      coin_amount: purchase.coin_amount,
      price_usd: purchase.price_usd,
      note: purchase.note || null,
    })
    .select().single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, purchase: data };
}

async function getCryptoPurchases(supabase) {
  const { data } = await supabase
    .from('crypto_purchases').select('*')
    .order('bought_at', { ascending: false }).limit(100);
  return data || [];
}

/** CoinGecko free API — no key needed. Returns { bitcoin: { usd: 60000 }, ... } */
async function fetchCryptoPrices(coins) {
  if (!coins.length) return {};
  const idMap = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
    DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2', DOT: 'polkadot',
    MATIC: 'matic-network', LINK: 'chainlink', UNI: 'uniswap', ATOM: 'cosmos',
    LTC: 'litecoin', BCH: 'bitcoin-cash', NEAR: 'near', ARB: 'arbitrum',
    OP: 'optimism', SUI: 'sui', APT: 'aptos', PEPE: 'pepe',
  };
  const ids = [...new Set(coins.map((c) => idMap[c.toUpperCase()] || c.toLowerCase()))];
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    const res = await axios.get(url, { timeout: 10000 });
    const prices = {};
    for (const [symbol, geckoId] of Object.entries(idMap)) {
      if (res.data[geckoId]?.usd != null) prices[symbol] = res.data[geckoId].usd;
    }
    for (const id of ids) {
      if (res.data[id]?.usd != null && !Object.values(prices).length) {
        prices[id.toUpperCase()] = res.data[id].usd;
      }
    }
    return prices;
  } catch (_) {
    return {};
  }
}

/** Compute portfolio: USD profit + crypto value */
async function getPortfolio(supabase) {
  const live = await fetchLiveRate();
  const currentRate = live.rate;

  const { data: trades } = await supabase
    .from('fx_manual_trades').select('*')
    .order('trade_ts', { ascending: true });
  const { data: cryptos } = await supabase
    .from('crypto_purchases').select('*')
    .order('bought_at', { ascending: true });

  const usdTrades = (trades || []).filter((t) => t.action === 'BUY_USD');
  const totalKrwSpent = usdTrades.reduce((s, t) => s + (Number(t.krw_amount) || 0), 0);
  const totalUsdBought = usdTrades.reduce((s, t) => s + (Number(t.usd_amount) || 0), 0);
  const avgBuyRate = totalUsdBought > 0 ? totalKrwSpent / totalUsdBought : null;

  const totalUsdSpentOnCrypto = (cryptos || []).reduce((s, c) => s + (Number(c.usd_spent) || 0), 0);
  const usdRemaining = totalUsdBought - totalUsdSpentOnCrypto;

  // USD profit: compare what you paid in KRW vs what it's worth now
  const currentValueKrw = totalUsdBought * currentRate;
  const usdProfitKrw = currentValueKrw - totalKrwSpent;
  const usdProfitPct = totalKrwSpent > 0 ? (usdProfitKrw / totalKrwSpent) * 100 : 0;

  // Crypto holdings
  const holdings = {};
  for (const c of (cryptos || [])) {
    const coin = (c.coin || 'BTC').toUpperCase();
    if (!holdings[coin]) holdings[coin] = { amount: 0, usdCost: 0 };
    holdings[coin].amount += Number(c.coin_amount) || 0;
    holdings[coin].usdCost += Number(c.usd_spent) || 0;
  }

  const coins = Object.keys(holdings);
  const prices = coins.length ? await fetchCryptoPrices(coins) : {};

  let totalCryptoValueUsd = 0;
  let totalCryptoCostUsd = 0;
  const cryptoPositions = coins.map((coin) => {
    const h = holdings[coin];
    const currentPrice = prices[coin] || null;
    const currentValue = currentPrice != null ? h.amount * currentPrice : null;
    if (currentValue != null) totalCryptoValueUsd += currentValue;
    totalCryptoCostUsd += h.usdCost;
    return {
      coin,
      amount: h.amount,
      costUsd: h.usdCost,
      avgPrice: h.amount > 0 ? h.usdCost / h.amount : null,
      currentPrice,
      currentValueUsd: currentValue,
      profitUsd: currentValue != null ? currentValue - h.usdCost : null,
      profitPct: currentValue != null && h.usdCost > 0 ? ((currentValue - h.usdCost) / h.usdCost) * 100 : null,
    };
  });

  const cryptoProfitUsd = totalCryptoValueUsd - totalCryptoCostUsd;

  // Total portfolio in KRW
  const totalValueKrw = (usdRemaining * currentRate) + (totalCryptoValueUsd * currentRate);
  const totalProfitKrw = totalValueKrw - totalKrwSpent;

  return {
    currentRate,
    usd: {
      totalKrwSpent,
      totalUsdBought,
      avgBuyRate,
      usdRemaining,
      usdSpentOnCrypto: totalUsdSpentOnCrypto,
      currentValueKrw,
      profitKrw: usdProfitKrw,
      profitPct: usdProfitPct,
    },
    crypto: {
      positions: cryptoPositions,
      totalCostUsd: totalCryptoCostUsd,
      totalValueUsd: totalCryptoValueUsd,
      profitUsd: cryptoProfitUsd,
      profitPct: totalCryptoCostUsd > 0 ? (cryptoProfitUsd / totalCryptoCostUsd) * 100 : 0,
      prices,
    },
    total: {
      totalKrwInvested: totalKrwSpent,
      totalValueKrw,
      profitKrw: totalProfitKrw,
      profitPct: totalKrwSpent > 0 ? (totalProfitKrw / totalKrwSpent) * 100 : 0,
    },
    trades: usdTrades,
    cryptoPurchases: cryptos || [],
  };
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
  recordCrypto,
  getCryptoPurchases,
  fetchCryptoPrices,
  getPortfolio,
};
