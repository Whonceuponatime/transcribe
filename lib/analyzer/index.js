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

// ─── Live rate (ExchangeRate-API with Frankfurter fallback) ──────────────
async function fetchLiveRateFromProvider(url, provider, extract) {
  const res = await axios.get(url, { timeout: 10000 });
  const rate = extract(res.data);
  if (rate == null || Number(rate) <= 0) throw new Error(`No KRW rate from ${provider}`);
  const date = res.data?.date || new Date().toISOString().slice(0, 10);
  return { rate: Number(rate), date, provider };
}

// Yahoo Finance returns real-time mid price for USDKRW=X
async function fetchYahooRate() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X?interval=1m&range=1d';
  const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const meta = res.data?.chart?.result?.[0]?.meta;
  const rate = meta?.regularMarketPrice;
  if (rate == null || Number(rate) <= 0) throw new Error('No KRW rate from yahoo');
  const date = new Date().toISOString().slice(0, 10);
  return { rate: Number(rate), date, provider: 'yahoo' };
}

async function fetchLiveRate() {
  const providers = [
    { fn: fetchYahooRate },
    {
      fn: () => fetchLiveRateFromProvider(
        'https://api.exchangerate-api.com/v4/latest/USD',
        'exchangerate-api',
        (d) => d?.rates?.KRW,
      ),
    },
    {
      fn: () => fetchLiveRateFromProvider(
        'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW',
        'frankfurter',
        (d) => d?.rates?.KRW,
      ),
    },
  ];
  let lastErr;
  for (const p of providers) {
    try {
      return await p.fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status) console.warn(`live-rate provider failed (${status}):`, err.message);
    }
  }
  throw new Error(lastErr?.message || 'No live KRW rate from any provider');
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

async function fetchFredSeriesSafe(seriesId, apiKey, startDate) {
  try {
    return await fetchFredSeries(seriesId, apiKey, startDate);
  } catch (err) {
    if (err.response?.status === 400) console.warn(`FRED 400 for ${seriesId}:`, err.response?.data || err.message);
    return [];
  }
}

async function fetchHistory(apiKey) {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  const startStr = start.toISOString().slice(0, 10);

  const [usdkrw, broad, vix, nasdaq, dgs10, dgs2, oil, gold, sp500, fedFunds, cpi, bokRate, kospiProxy, yuanUsd, koreaTrade] = await Promise.all([
    fetchFredSeriesSafe('DEXKOUS', apiKey, startStr),
    fetchFredSeriesSafe('DTWEXBGS', apiKey, startStr),
    fetchFredSeriesSafe('VIXCLS', apiKey, startStr),
    fetchFredSeriesSafe('NASDAQ100', apiKey, startStr),
    fetchFredSeriesSafe('DGS10', apiKey, startStr),
    fetchFredSeriesSafe('DGS2', apiKey, startStr),
    fetchFredSeriesSafe('DCOILWTICO', apiKey, startStr),
    fetchFredSeriesSafe('GOLDAMGBD228NLBM', apiKey, startStr),
    fetchFredSeriesSafe('SP500', apiKey, startStr),
    fetchFredSeriesSafe('FEDFUNDS', apiKey, startStr),
    fetchFredSeriesSafe('CPIAUCSL', apiKey, startStr),
    fetchFredSeriesSafe('INTDSRKRM193N', apiKey, startStr),
    fetchFredSeriesSafe('SPASTT01KRM661N', apiKey, startStr),
    fetchFredSeriesSafe('DEXCHUS', apiKey, startStr),
    fetchFredSeriesSafe('XTNTVA01KRQ667S', apiKey, startStr),
  ]);
  return { usdkrw, broad, vix, nasdaq, dgs10, dgs2, oil, gold, sp500, fedFunds, cpi, bokRate, kospiProxy, yuanUsd, koreaTrade };
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

  const oilVal = last(history.oil);
  const oilTrend20 = trend(history.oil, 20);
  const oilChange20 = change(history.oil, 20);

  const goldVal = last(history.gold);
  const goldTrend20 = trend(history.gold, 20);
  const goldChange20 = change(history.gold, 20);

  const sp500Val = last(history.sp500);
  const sp500Change20 = change(history.sp500, 20);

  const fedFundsVal = last(history.fedFunds);
  const bokRateVal = last(history.bokRate);
  const rateDiff = (fedFundsVal != null && bokRateVal != null) ? fedFundsVal - bokRateVal : null;

  const cpiVal = last(history.cpi);
  const cpiChange12m = change(history.cpi, 12);

  const kospiVal = last(history.kospiProxy);
  const kospiTrend = trend(history.kospiProxy, 3);

  const yuanVal = last(history.yuanUsd);
  const yuanTrend20 = trend(history.yuanUsd, 20);

  const tradeBalVal = last(history.koreaTrade);

  return {
    broadVal, broadTrend20, broadChange20, broadMa60,
    vixVal, vixTrend5,
    nasdaqVal, nasdaqChange20,
    us10y, us2y, us10yTrend,
    oilVal, oilTrend20, oilChange20,
    goldVal, goldTrend20, goldChange20,
    sp500Val, sp500Change20,
    fedFundsVal, bokRateVal, rateDiff,
    cpiVal, cpiChange12m,
    kospiVal, kospiTrend,
    yuanVal, yuanTrend20,
    tradeBalVal,
  };
}

// ─── Signal engine ──────────────────────────────────────────────────────
function generateSignal(indicators, macro) {
  const { spot, ma20, ma60, ma120, zscore20, percentile252 } = indicators;
  const {
    broadVal, broadTrend20, broadChange20, broadMa60, vixVal, vixTrend5, nasdaqChange20, us10y, us2y, us10yTrend,
    oilVal, oilTrend20, oilChange20, goldVal, goldTrend20, goldChange20,
    sp500Val, sp500Change20, fedFundsVal, bokRateVal, rateDiff,
    cpiVal, cpiChange12m, kospiVal, kospiTrend, yuanVal, yuanTrend20, tradeBalVal,
  } = macro;

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

  // ── 5. OIL & ENERGY ──
  const oilSection = { title: 'Oil & Energy (Korea imports all oil in USD)', points: [] };
  if (oilVal != null) {
    oilSection.points.push(`WTI crude oil: $${oilVal.toFixed(2)}/barrel`);
    if (oilVal > 85) {
      oilSection.points.push('Oil is expensive → Korea needs more USD to pay for energy imports → increased USD demand weakens KRW. This adds urgency to buying USD.');
    } else if (oilVal < 65) {
      score += 1;
      oilSection.points.push('Oil is cheap → less USD demand from Korea for energy → takes pressure off KRW. Good window to buy USD while KRW has relief.');
    } else {
      oilSection.points.push('Oil is in the moderate range — no strong directional pressure on KRW from energy costs.');
    }
    if (oilTrend20 === 'rising') {
      oilSection.points.push(`Oil rising (${oilChange20?.toFixed(1)}% over 20 days) → if this continues, KRW weakens from energy import costs.`);
    } else if (oilTrend20 === 'falling') {
      score += 1;
      oilSection.points.push(`Oil falling (${oilChange20?.toFixed(1)}% over 20 days) → eases pressure on KRW. Favorable for buying USD at a better rate.`);
    }
  }
  analysis.push(oilSection);

  // ── 6. KOREA FUNDAMENTALS ──
  const koreaSection = { title: 'Korea Fundamentals', points: [] };
  if (fedFundsVal != null && bokRateVal != null) {
    koreaSection.points.push(`US Fed Funds rate: ${fedFundsVal.toFixed(2)}% vs Korea BOK rate: ${bokRateVal.toFixed(2)}%`);
    if (rateDiff != null && rateDiff > 1.5) {
      score += 1;
      koreaSection.points.push(`US rates are ${rateDiff.toFixed(2)}% HIGHER than Korea → capital flows to USD for better returns → KRW weakens. Strong reason to hold USD.`);
    } else if (rateDiff != null && rateDiff > 0) {
      koreaSection.points.push(`US rates are ${rateDiff.toFixed(2)}% above Korea → mild USD pull. Rate differential still favors USD.`);
    } else if (rateDiff != null && rateDiff <= 0) {
      koreaSection.points.push(`Korea rates at or above US rates → less capital pull to USD. But structural KRW weakness persists from other factors.`);
    }
  }
  if (kospiVal != null) {
    koreaSection.points.push(`Korea equity index (OECD proxy): ${kospiVal.toFixed(1)}`);
    if (kospiTrend === 'falling') {
      score += 1;
      koreaSection.points.push('Korea equities declining → foreign investors pulling out → capital outflow weakens KRW. Buy USD now before further KRW weakness.');
    } else if (kospiTrend === 'rising') {
      koreaSection.points.push('Korea equities rising → foreign capital flowing in → temporary KRW support. Good window to buy USD while KRW is stable.');
    }
  }
  if (tradeBalVal != null) {
    koreaSection.points.push(`Korea trade balance: $${(tradeBalVal / 1e9).toFixed(1)}B`);
    if (tradeBalVal < 0) {
      koreaSection.points.push('Trade deficit → Korea importing more than exporting → more USD flowing out → KRW weakens.');
    } else {
      koreaSection.points.push('Trade surplus → healthy exports generate USD inflows → provides some KRW support.');
    }
  }
  analysis.push(koreaSection);

  // ── 7. CHINA / REGIONAL ──
  const chinaSection = { title: 'China & Regional (Korea\'s largest trade partner)', points: [] };
  if (yuanVal != null) {
    chinaSection.points.push(`Chinese Yuan/USD: ${yuanVal.toFixed(4)}`);
    if (yuanTrend20 === 'rising') {
      score += 1;
      chinaSection.points.push('Yuan weakening vs USD → regional EM currencies weaken in sympathy → KRW depreciates alongside yuan. Buy USD before KRW follows further.');
    } else if (yuanTrend20 === 'falling') {
      chinaSection.points.push('Yuan strengthening vs USD → regional stability → temporary relief for KRW. A calm window to buy USD without panic premium.');
    } else {
      chinaSection.points.push('Yuan is stable → no strong regional currency pressure on KRW.');
    }
  }
  analysis.push(chinaSection);

  // ── 8. US INFLATION & FED POLICY ──
  const fedSection = { title: 'US Inflation & Fed Policy', points: [] };
  if (fedFundsVal != null) {
    fedSection.points.push(`Fed Funds rate: ${fedFundsVal.toFixed(2)}%`);
    if (fedFundsVal >= 4.5) {
      score += 1;
      fedSection.points.push('Fed rate is high → USD is very attractive as a yield asset globally → strong floor under USD. Holding USD earns meaningful interest.');
    } else if (fedFundsVal >= 3.0) {
      fedSection.points.push('Fed rate is moderate → USD still attractive but less aggressively so.');
    } else {
      fedSection.points.push('Fed rate is low → less yield advantage for USD, but KRW still depreciates from structural factors.');
    }
  }
  if (cpiChange12m != null) {
    fedSection.points.push(`US CPI (12-month change): ${cpiChange12m.toFixed(1)}%`);
    if (cpiChange12m > 3.5) {
      fedSection.points.push('Inflation elevated → Fed likely to keep rates high → USD stays strong → KRW under pressure.');
    } else if (cpiChange12m < 2.0) {
      fedSection.points.push('Inflation cooling → Fed may cut rates → potential USD softening ahead → could be a window to buy before the next KRW weakening catalyst.');
    } else {
      fedSection.points.push('Inflation near target → Fed in wait-and-see mode → stable USD environment.');
    }
  }
  if (sp500Change20 != null) {
    fedSection.points.push(`S&P 500 (20-day): ${sp500Change20 > 0 ? '+' : ''}${sp500Change20.toFixed(1)}%`);
    if (sp500Change20 > 3) {
      fedSection.points.push('US equities rising → risk-on globally → KRW gets temporary support from foreign inflows to Korean stocks. Buy USD while it\'s not spiking.');
    } else if (sp500Change20 < -5) {
      fedSection.points.push('US equities falling sharply → risk-off → global capital runs to USD safe haven → KRW weakens. USD may get more expensive soon.');
    }
  }
  analysis.push(fedSection);

  // ── 9. COMMODITY SAFE HAVENS ──
  const goldSection = { title: 'Gold & Safe Haven Flows', points: [] };
  if (goldVal != null) {
    goldSection.points.push(`Gold price: $${goldVal.toFixed(0)}/oz`);
    if (goldTrend20 === 'rising') {
      goldSection.points.push(`Gold rising (${goldChange20?.toFixed(1)}% over 20 days) → investors hedging risk/inflation → safe-haven demand rising → USD typically strengthens in parallel.`);
      if (vixVal != null && vixVal > 22) {
        score += 1;
        goldSection.points.push('Gold AND VIX both elevated → crisis/stress mode → capital flight to USD intensifies → KRW at significant risk. Buy USD now.');
      }
    } else if (goldTrend20 === 'falling') {
      goldSection.points.push('Gold falling → risk appetite returning → less safe-haven demand → stable environment for FX conversion.');
    } else {
      goldSection.points.push('Gold is stable — no strong safe-haven signal.');
    }
  }
  analysis.push(goldSection);

  // ── 10. STRUCTURAL VIEW ──
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
    summary = 'Strong alignment across rate, macro, and trend. Convert a large amount now.';
  } else if (score >= 5) {
    decision = 'BUY_NOW'; allocation = 50;
    summary = 'Good conditions. Convert about half of what you planned.';
  } else if (score >= 3) {
    decision = 'SCALE_IN'; allocation = 30;
    summary = 'Decent conditions. Buy a moderate amount and keep some KRW for dips.';
  } else if (score >= 1) {
    decision = 'SCALE_IN'; allocation = 15;
    summary = 'Neutral. Buy a small amount to keep accumulating.';
  } else {
    decision = 'SCALE_IN'; allocation = 10;
    summary = 'Rate is elevated. Buy a small amount to stay on schedule.';
  }

  const confidence = Math.min(100, Math.max(10, 35 + score * 7));

  // ── SITUATION REPORT: what the data says NOW, not homework ──
  const situation = [];

  if (ma20 != null) {
    const diff20 = spot - ma20;
    const diff20pct = ((diff20 / ma20) * 100).toFixed(1);
    if (spot > ma20) {
      situation.push(`Rate ₩${Math.round(spot).toLocaleString()} is ₩${Math.round(diff20).toLocaleString()} ABOVE the 20-day avg (₩${Math.round(ma20).toLocaleString()}, +${diff20pct}%) — you're paying a premium right now.`);
    } else {
      situation.push(`Rate ₩${Math.round(spot).toLocaleString()} is ₩${Math.round(Math.abs(diff20)).toLocaleString()} BELOW the 20-day avg (₩${Math.round(ma20).toLocaleString()}, ${diff20pct}%) — this is a dip. Buy more.`);
    }
  }

  if (ma60 != null) {
    if (spot > ma60) {
      situation.push(`Also above 60-day avg (₩${Math.round(ma60).toLocaleString()}) — rate has been climbing steadily.`);
    } else {
      situation.push(`Below 60-day avg (₩${Math.round(ma60).toLocaleString()}) — meaningful pullback from the trend. Good entry.`);
    }
  }

  if (inUptrend) {
    situation.push(`KRW is in a confirmed weakening trend. Today's ₩${Math.round(spot).toLocaleString()} could be tomorrow's floor — delaying may cost you more.`);
  }

  if (broadTrend20 === 'rising' && broadVal != null) {
    situation.push(`Dollar Index is rising (${broadVal.toFixed(1)}) — USD is getting stronger globally. KRW will likely weaken further.`);
  } else if (broadTrend20 === 'falling' && broadVal != null) {
    situation.push(`Dollar Index is falling (${broadVal.toFixed(1)}) — USD is temporarily weaker. This is a window to buy before it strengthens again.`);
  }

  // Bottom line
  if (allocation >= 50) {
    situation.push(`Bottom line: conditions favor buying. Convert ${allocation}% of your available KRW to USD now.`);
  } else if (allocation >= 25) {
    situation.push(`Bottom line: buy ${allocation}% now to keep accumulating. Save the rest — if rate dips to ₩${ma20 ? Math.round(ma20).toLocaleString() : '—'} or lower, increase your purchase.`);
  } else {
    situation.push(`Bottom line: buy a small amount (${allocation}%) to stay on schedule. Rate is elevated but KRW keeps weakening — skipping entirely is worse than buying small.${ma20 ? ` If it drops to ₩${Math.round(ma20).toLocaleString()}, buy aggressively.` : ''}`);
  }

  const valLabel = percentile252 != null && percentile252 <= 0.30 ? 'CHEAP'
    : percentile252 != null && percentile252 >= 0.70 ? 'EXPENSIVE'
    : 'FAIR';

  // ── NEXT TRIGGERS TO WATCH ──
  const triggers = [];
  if (ma20 != null) triggers.push(`USD/KRW drops to ₩${Math.round(ma20).toLocaleString()} (20-day avg) → buy more aggressively`);
  if (ma60 != null) triggers.push(`USD/KRW drops to ₩${Math.round(ma60).toLocaleString()} (60-day avg) → strong buy zone`);
  if (vixVal != null && vixVal < 25) triggers.push(`VIX spikes above 30 (now ${vixVal.toFixed(0)}) → fear event, USD typically surges → deploy remaining KRW`);
  if (broadTrend20 === 'falling') triggers.push('Dollar Index reverses back up → add more USD before it strengthens further');
  if (broadTrend20 === 'rising') triggers.push('Dollar Index stalls or reverses down → wait for pullback to buy more');
  if (triggers.length === 0) triggers.push('Watch for a pullback in USD/KRW toward the 20-day moving average before adding more');

  // ── WHAT TO DO WITH YOUR USD (deploy plan) ──
  const usdDeploy = [];

  // Cash recommendation
  usdDeploy.push({
    category: 'Keep as USD cash',
    pct: 40,
    reason: 'Liquid emergency reserve in USD. Earns ~5% in US money market funds (e.g. SGOV ETF). Protects against KRW emergencies.',
    action: 'Open a USD account at Wise, Interactive Brokers, or a Korean bank's USD account. Park in SGOV or similar for yield.',
  });

  // US equities
  const spDown = sp500Val != null && sp500Change20 != null && sp500Change20 < -5;
  usdDeploy.push({
    category: 'US Index ETFs',
    pct: 40,
    reason: spDown
      ? `S&P 500 is down ~${Math.abs(macroData.sp500Change20).toFixed(1)}% over 20 days — dip buying opportunity. US equities historically recover.`
      : 'Long-term S&P 500 returns ~10%/year. Holding KRW in a Korean bank account earns far less after KRW depreciation.',
    action: 'Buy VOO (S&P 500) or QQQ (NASDAQ 100) via Interactive Brokers or a Korean securities firm with US market access (e.g. Kiwoom, Mirae). Cost-average monthly.',
  });

  // Crypto
  const btcMomentum = vixVal != null && vixVal < 20;
  usdDeploy.push({
    category: 'Bitcoin / Crypto',
    pct: 20,
    reason: btcMomentum
      ? 'VIX is low and risk appetite is high — crypto tends to outperform in low-fear environments.'
      : 'Small crypto allocation (10-20%) can amplify returns but adds volatility. Keep this as a speculative bet only.',
    action: 'Buy BTC or ETH in small amounts via Binance, Coinbase, or Upbit using your USD. Log each purchase above.',
  });

  return {
    decision,
    allocation_pct: allocation,
    confidence,
    score,
    valuation_label: valLabel,
    summary,
    situation,
    analysis,
    red_flags: warnings,
    next_trigger_to_watch: triggers,
    usd_deploy: usdDeploy,
    levels: { spot, ma20, ma60, ma120, zscore20, percentile252 },
    macro_snapshot: {
      dollar_index: broadVal, us10y, us2y, vix: vixVal, nasdaq_20d_change: nasdaqChange20,
      oil: oilVal, gold: goldVal, sp500: sp500Val,
      fed_rate: fedFundsVal, bok_rate: bokRateVal, rate_diff: rateDiff,
      cpi_12m: cpiChange12m, kospi: kospiVal, yuan: yuanVal, trade_bal: tradeBalVal,
    },
  };
}

// ─── Sync: fetch live + history, compute, store ─────────────────────────
async function runLiveSync(supabase) {
  const apiKey = process.env.FRED_API_KEY;
  const live = await fetchLiveRate();
  const history = apiKey ? await fetchHistory(apiKey) : {
    usdkrw: [], broad: [], vix: [], nasdaq: [], dgs10: [], dgs2: [],
    oil: [], gold: [], sp500: [], fedFunds: [], cpi: [], bokRate: [], kospiProxy: [], yuanUsd: [], koreaTrade: [],
  };

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

/**
 * Fetch crypto prices in KRW from Upbit public API (no key required).
 * Returns { BTC: 135000000, ETH: 4200000, ... } — prices in KRW.
 */
const UPBIT_KRW_MARKETS = {
  BTC: 'KRW-BTC', ETH: 'KRW-ETH', SOL: 'KRW-SOL', XRP: 'KRW-XRP',
  DOGE: 'KRW-DOGE', ADA: 'KRW-ADA', AVAX: 'KRW-AVAX', DOT: 'KRW-DOT',
  MATIC: 'KRW-MATIC', LINK: 'KRW-LINK', ATOM: 'KRW-ATOM', LTC: 'KRW-LTC',
  BCH: 'KRW-BCH', NEAR: 'KRW-NEAR', ARB: 'KRW-ARB', OP: 'KRW-OP',
  SUI: 'KRW-SUI', APT: 'KRW-APT', PEPE: 'KRW-PEPE', UNI: 'KRW-UNI',
};

async function fetchCryptoPricesUpbit(coins) {
  const markets = [...new Set(coins.map((c) => UPBIT_KRW_MARKETS[c.toUpperCase()]).filter(Boolean))];
  if (!markets.length) return {};
  const url = `https://api.upbit.com/v1/ticker?markets=${markets.join(',')}`;
  const res = await axios.get(url, { timeout: 10000, headers: { accept: 'application/json' } });
  const pricesKrw = {};
  for (const item of (res.data || [])) {
    const coin = item.market.split('-')[1]; // "KRW-BTC" → "BTC"
    if (item.trade_price > 0) pricesKrw[coin] = item.trade_price;
  }
  return pricesKrw;
}

/**
 * CoinGecko fallback for coins not listed on Upbit KRW market.
 * Returns { COIN: usdPrice, ... }
 */
async function fetchCryptoPricesCoinGecko(coins) {
  const idMap = {
    BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
    DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2', DOT: 'polkadot',
    MATIC: 'matic-network', LINK: 'chainlink', UNI: 'uniswap', ATOM: 'cosmos',
    LTC: 'litecoin', BCH: 'bitcoin-cash', NEAR: 'near', ARB: 'arbitrum',
    OP: 'optimism', SUI: 'sui', APT: 'aptos', PEPE: 'pepe',
  };
  const ids = [...new Set(coins.map((c) => idMap[c.toUpperCase()] || c.toLowerCase()))];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const res = await axios.get(url, { timeout: 10000 });
  const prices = {};
  for (const [symbol, geckoId] of Object.entries(idMap)) {
    if (res.data[geckoId]?.usd != null) prices[symbol] = res.data[geckoId].usd;
  }
  return prices;
}

/**
 * Primary: Upbit KRW prices converted to USD via live rate.
 * Fallback: CoinGecko for any coins missing from Upbit response.
 * Returns { BTC: 95000, ETH: 3200, ... } — prices in USD.
 */
async function fetchCryptoPrices(coins, currentRate) {
  if (!coins.length) return {};

  const upperCoins = [...new Set(coins.map((c) => c.toUpperCase()))];
  const prices = {};

  // 1. Try Upbit KRW market
  if (currentRate > 0) {
    try {
      const krwPrices = await fetchCryptoPricesUpbit(upperCoins);
      for (const [coin, krwPrice] of Object.entries(krwPrices)) {
        prices[coin] = krwPrice / currentRate;
      }
    } catch (err) {
      console.warn('Upbit price fetch failed:', err.message);
    }
  }

  // 2. CoinGecko fallback for any coins not returned by Upbit
  const missing = upperCoins.filter((c) => prices[c] == null);
  if (missing.length > 0) {
    try {
      const geckoFallback = await fetchCryptoPricesCoinGecko(missing);
      Object.assign(prices, geckoFallback);
    } catch (err) {
      console.warn('CoinGecko fallback failed:', err.message);
    }
  }

  return prices;
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
  const prices = coins.length ? await fetchCryptoPrices(coins, currentRate) : {};

  let totalCryptoValueUsd = 0;
  let totalCryptoCostUsd = 0;
  const cryptoPositions = coins.map((coin) => {
    const h = holdings[coin];
    const currentPrice = prices[coin] || null;
    const currentValue = currentPrice != null ? h.amount * currentPrice : null;
    if (currentValue != null) totalCryptoValueUsd += currentValue;
    totalCryptoCostUsd += h.usdCost;
    const avgPriceUsd = h.amount > 0 ? h.usdCost / h.amount : null;
    return {
      coin,
      amount: h.amount,
      costUsd: h.usdCost,
      avgPrice: avgPriceUsd,
      avgPriceUsd,
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
