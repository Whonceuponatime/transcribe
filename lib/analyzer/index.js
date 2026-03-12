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

  // KRW depreciates long-term. You WILL buy USD. The only question is timing.
  // "Expensive" doesn't mean don't buy — it means buy less now and save ammo for dips.

  // Detect uptrend: if all MAs are rising and spot > MA120, KRW is actively weakening.
  // In an uptrend, "expensive" is the new normal — penalize less.
  const inUptrend = spot != null && ma60 != null && ma120 != null && spot > ma120 && ma60 > ma120;

  // Primary: where is USD/KRW vs recent history?
  if (percentile252 != null) {
    if (percentile252 <= 0.15) {
      score += 4;
      reasons.push('USD/KRW is in the bottom 15% of the past year — rare dip, great timing');
    } else if (percentile252 <= 0.30) {
      score += 3;
      reasons.push('USD/KRW is in the bottom 30% — below-average price, good timing');
    } else if (percentile252 <= 0.50) {
      score += 1;
      reasons.push('USD/KRW is in the lower half — fair timing');
    } else if (percentile252 >= 0.85) {
      if (inUptrend) {
        score -= 1;
        warnings.push('Rate is near yearly highs, but KRW is in a weakening trend — this may be the new floor');
      } else {
        score -= 2;
        warnings.push('Rate is near yearly highs — timing is poor, but KRW will keep weakening long-term');
      }
    } else if (percentile252 >= 0.70) {
      if (inUptrend) {
        warnings.push('Rate is elevated but trending up — current level may not come back');
      } else {
        score -= 1;
        warnings.push('Rate is somewhat elevated — consider buying less now');
      }
    }
  }

  // Moving averages: dips below MAs are better entry points
  if (spot != null && ma20 != null && spot < ma20) {
    score += 1;
    reasons.push('Spot is below 20-day average — short-term dip');
  }
  if (spot != null && ma60 != null && spot < ma60) {
    score += 1;
    reasons.push('Spot is below 60-day average — meaningful pullback');
  }
  if (spot != null && ma120 != null && spot < ma120) {
    score += 2;
    reasons.push('Spot is below 120-day average — significant discount vs trend');
  }

  // Z-score: how unusual is the current level?
  if (zscore20 != null) {
    if (zscore20 <= -1.0) {
      score += 2;
      reasons.push('Rate dropped sharply vs recent 20 days — good dip to buy into');
    } else if (zscore20 <= -0.5) {
      score += 1;
      reasons.push('Rate is slightly below recent average');
    } else if (zscore20 >= 1.5) {
      score -= 1;
      warnings.push('Rate spiked recently — might pull back short-term');
    }
  }

  // Macro context
  if (macro.vixCalm) { score += 1; reasons.push('VIX is calm — stable markets favor buying'); }
  if (macro.vixHigh) { warnings.push('VIX elevated — markets are stressed, but KRW weakens in stress too'); }
  if (macro.nasdaqUp) { score += 1; reasons.push('Nasdaq trending up — risk-on supports KRW stability short-term'); }

  // Core assumption: always accumulate
  if (inUptrend) {
    score += 1;
    reasons.push('KRW is actively weakening (uptrend confirmed) — delaying costs more');
  }
  reasons.push('KRW depreciates over time — steady accumulation of USD is the baseline strategy');

  // Decision mapping — never 0% because you always want to accumulate
  let decision, allocation, summary;
  if (score >= 6) {
    decision = 'BUY_NOW';
    allocation = 100;
    summary = 'Excellent timing. USD is cheap relative to recent history. Buy a large amount now.';
  } else if (score >= 4) {
    decision = 'BUY_NOW';
    allocation = 50;
    summary = 'Good timing. Consider converting 50% of what you planned.';
  } else if (score >= 2) {
    decision = 'SCALE_IN';
    allocation = 30;
    summary = 'Decent timing. Buy a moderate amount (30%) and keep some for potential dips.';
  } else if (score >= 0) {
    decision = 'SCALE_IN';
    allocation = 15;
    summary = 'Timing is neutral. Buy a small amount (15%) to keep accumulating — KRW will keep weakening, but a dip may come.';
  } else {
    decision = 'SCALE_IN';
    allocation = 10;
    summary = 'USD is pricier than usual right now. Buy a small amount (10%) to stay on schedule — but save most of your KRW for a better entry. KRW will keep depreciating either way.';
  }

  const confidence = Math.min(100, Math.max(10, 40 + score * 8));

  const nextTriggers = [];
  if (allocation < 50) {
    if (ma20 != null) nextTriggers.push(`Increase buying if rate dips below ₩${Math.round(ma20).toLocaleString()} (20-day avg)`);
    if (ma60 != null && spot > ma60) nextTriggers.push(`Strong buy zone around ₩${Math.round(ma60).toLocaleString()} (60-day avg)`);
  }
  if (inUptrend) {
    nextTriggers.push('Trend is up — waiting too long risks paying even more');
  }

  return {
    decision,
    allocation_pct: allocation,
    confidence,
    score,
    valuation_label: percentile252 != null && percentile252 <= 0.30 ? 'CHEAP'
      : percentile252 != null && percentile252 >= 0.70 ? (inUptrend ? 'ELEVATED (trending)' : 'PRICEY')
      : 'FAIR',
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
