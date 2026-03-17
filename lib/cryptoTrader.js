/**
 * Crypto trading engine v4 — buy low sell high, maximum signal coverage.
 *
 * SELL triggers (every 5 min):
 *   1. Fixed profit-take   : +10/20/40/80% → sell 10/15/20/25% (cooldown 12/24/48/96h)
 *   2. RSI overbought      : >75 sell 12%, >85 sell 20%        (cooldown 4/4h)
 *   3. Bollinger breakout  : pctB > 1                          (cooldown 2h)
 *   4. MACD bear cross     : sell 10%                          (cooldown 4h)
 *   5. StochRSI overbought : >85 sell 10%                      (cooldown 2h)
 *   6. VWAP deep above     : >3% over VWAP, at profit          (cooldown 2h)
 *   7. Williams %R OB      : >-5 sell 10%                      (cooldown 4h)
 *   8. CCI overbought      : >150 sell 10%                     (cooldown 2h)
 *   9. Kimchi premium high : >4% → Korean market overheated    (cooldown 4h)
 *  10. Trailing stop       : -30% from 14d high while +profit  (cooldown 30d)
 *
 * BUY triggers (every cycle — 5 min for sells, hourly for dip buys):
 *   1. VWAP deep below     : >3% under VWAP                    (cooldown 3h)
 *   2. RSI < 30            : oversold                          (cooldown 4h)
 *   3. BB below lower band : extreme dip                       (cooldown 4h)
 *   4. MACD bull cross     : trend reversal                    (cooldown 6h)
 *   5. Williams %R OS      : <-85 oversold                     (cooldown 3h)
 *   6. CCI oversold        : <-150                             (cooldown 4h)
 *   7. StochRSI <15        : extreme oversold                  (cooldown 3h)
 *   8. ROC sharp dip       : -6%+ drop in 9 bars              (cooldown 4h)
 *   9. 24h drop > 8%       : emergency dip buy                 (cooldown 8h)
 *  10. Weekly DCA          : scheduled buy (F&G + macro gates)
 */

const upbit   = require('./upbit');
const axios   = require('axios');
const {
  compositeSignal, rsi, bollinger, macd, stochRsi,
} = require('./indicators');

const DEFAULT_COINS         = ['BTC', 'ETH', 'SOL'];
const DEFAULT_SPLIT         = { BTC: 50, ETH: 30, SOL: 20 };
const DEFAULT_WEEKLY_BUDGET = 100000;
const DEFAULT_DIP_BUDGET    = 100000;
const MIN_ORDER_KRW         = 5000;
const TRAILING_STOP_SELL_PCT = 40;
const TRAILING_WINDOW_DAYS   = 14;

// Always keep at least this fraction of total portfolio value as KRW cash
const CASH_RESERVE_PCT   = 0.15;

// Upbit charges 0.25% on every buy AND every sell.
// Round-trip cost = 0.50%. We require at least this much gain before signal-selling
// so we never exit a position at a net loss due to fees alone.
const UPBIT_FEE_PCT      = 0.0025; // 0.25% per side
const ROUND_TRIP_FEE_PCT = UPBIT_FEE_PCT * 2 * 100; // 0.50% — expressed as gain%
// We add a small buffer (0.2%) above break-even so sells are always net-profitable
const MIN_PROFIT_TO_SELL = ROUND_TRIP_FEE_PCT + 0.2; // 0.70%

/**
 * Scale buy order size by signal conviction.
 * Higher risk mode: multipliers scaled up across all tiers.
 */
function convictionMult(score) {
  if (score >= 8) return 2.5;
  if (score >= 6) return 2.0;
  if (score >= 4) return 1.5;
  if (score >= 2) return 1.2;
  return 1.0;
}

/**
 * How many days to wait between DCA runs.
 * configDays = user's setting (default 1). F&G and signal score can only SHORTEN it,
 * never make it longer than the user's setting.
 */
function dcaCooldownDays(avgScore, fng = null, configDays = 1) {
  let days = configDays;
  // Extreme Fear — always buy at least daily (often the best entry)
  if (fng != null && fng < 20) days = Math.min(days, 1);
  // Fear — shorten to at most 3 days
  if (fng != null && fng < 30) days = Math.min(days, 3);
  // Strong signals shorten cadence
  if (avgScore >= 4) days = Math.min(days, 3);
  if (avgScore >= 1) days = Math.min(days, Math.max(configDays - 1, 1));
  return Math.max(days, 1);
}

/**
 * Tilt the coin split toward higher-scored coins (up to ±25% vs base).
 * Ensures the bot deploys capital into the coins with the best buy signals.
 */
function tiltedSplit(baseSplit, analysis, coins) {
  const out  = {};
  let   sum  = 0;
  for (const c of coins) {
    const base  = baseSplit[c] ?? 0;
    const score = analysis[c]?.scoreCombined ?? 0;
    const tilt  = Math.max(-0.25, Math.min(0.25, score / 40)); // score ±10 → ±25%
    out[c] = Math.max(0, base * (1 + tilt));
    sum += out[c];
  }
  // Renormalize so totals match original 100% sum
  const baseSum = coins.reduce((s, c) => s + (baseSplit[c] ?? 0), 0);
  if (sum > 0) for (const c of coins) out[c] = Math.round(out[c] / sum * baseSum);
  return out;
}

// Profit-take tiers — let gains breathe before trimming
// Removed the 5% tier: it fired too frequently and cut positions before meaningful moves
const PROFIT_LEVELS = [
  { gainThreshold: 10, label: '10pct', sellPct: 10, cooldownHours: 12 },
  { gainThreshold: 20, label: '20pct', sellPct: 15, cooldownHours: 24 },
  { gainThreshold: 40, label: '40pct', sellPct: 20, cooldownHours: 48 },
  { gainThreshold: 80, label: '80pct', sellPct: 25, cooldownHours: 96 },
];

// Binance symbols for kimchi premium calculation
const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

// ─── Logging helpers ──────────────────────────────────────────────────────────
const fmtKrw = (n) => n != null ? `₩${Math.round(n).toLocaleString()}` : '—';
const fmtPct = (n, d = 1) => n != null ? `${n >= 0 ? '+' : ''}${Number(n).toFixed(d)}%` : '—';
const pad    = (s, n, right = false) => { const str = String(s ?? '—'); return right ? str.padStart(n) : str.padEnd(n); };
const div    = (c = '─', n = 72) => c.repeat(n);

/**
 * Returns a structured evaluation of all dip signals for a coin — threshold
 * met or not, indicator values, and thresholds — used for diagnostic logging.
 */
function evaluateDipSignals(sig, score) {
  return [
    { reason: 'DIP_EMERGENCY_24H',    cooldown: 6, met: sig.mom24 != null && sig.mom24 < -6,          val: sig.mom24 != null ? `${sig.mom24.toFixed(1)}%` : null,  thresh: 'mom24 < -6%'    },
    { reason: 'DIP_RSI_EXTREME_OS',   cooldown: 4, met: sig.rsi != null && sig.rsi < 25,               val: sig.rsi?.toFixed(1),                                    thresh: 'RSI < 25'       },
    { reason: 'DIP_RSI7_EXTREME_OS',  cooldown: 3, met: sig.rsi7 != null && sig.rsi7 < 25,             val: sig.rsi7?.toFixed(1),                                   thresh: 'RSI7 < 25'      },
    { reason: 'DIP_BB_BELOW_LOWER',   cooldown: 4, met: sig.bb?.pctB != null && sig.bb.pctB < 0,       val: sig.bb?.pctB?.toFixed(3),                               thresh: 'pctB < 0'       },
    { reason: 'DIP_VWAP_DEEP_BELOW',  cooldown: 3, met: sig.vwapDev != null && sig.vwapDev < -2,       val: sig.vwapDev != null ? `${sig.vwapDev.toFixed(1)}%` : null, thresh: 'VWAP < -2%'  },
    { reason: 'DIP_WILLIAMS_DEEP_OS', cooldown: 3, met: sig.williamsR != null && sig.williamsR < -85,  val: sig.williamsR?.toFixed(1),                              thresh: 'WR < -85'       },
    { reason: 'DIP_CCI_DEEP_OS',      cooldown: 3, met: sig.cci != null && sig.cci < -120,             val: sig.cci?.toFixed(0),                                    thresh: 'CCI < -120'     },
    { reason: 'DIP_RSI_OVERSOLD',     cooldown: 3, met: sig.rsi != null && sig.rsi < 32,               val: sig.rsi?.toFixed(1),                                    thresh: 'RSI < 32'       },
    { reason: 'DIP_STOCHRSI_OS',      cooldown: 3, met: sig.stochRsi != null && sig.stochRsi < 20,     val: sig.stochRsi?.toFixed(1),                               thresh: 'StochRSI < 20'  },
    { reason: 'DIP_MACD_BULL_CROSS',  cooldown: 5, met: !!sig.macd?.bullishCross,                      val: sig.macd?.bullishCross ? 'YES' : 'no',                  thresh: 'bull cross'     },
    { reason: 'DIP_ROC_SHARP_DIP',    cooldown: 3, met: sig.roc != null && sig.roc < -5,               val: sig.roc != null ? `${sig.roc.toFixed(1)}%` : null,      thresh: 'ROC < -5%'      },
    { reason: 'DIP_HIGH_SCORE',        cooldown: 2, met: score >= 3,                                    val: String(score),                                          thresh: 'score ≥ 3'      },
    { reason: 'DIP_SCORE_MODERATE',   cooldown: 4, met: score >= 2,                                    val: String(score),                                          thresh: 'score ≥ 2'      },
    { reason: 'DIP_BB_NEAR_LOWER',    cooldown: 5, met: sig.bb?.pctB != null && sig.bb.pctB < 0.05,    val: sig.bb?.pctB?.toFixed(3),                               thresh: 'pctB < 0.05'    },
  ];
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getConfig(supabase) {
  const { data } = await supabase
    .from('crypto_trader_config').select('*')
    .order('created_at', { ascending: false }).limit(1).single();
  return {
    dca_enabled:              data?.dca_enabled ?? true,
    weekly_budget_krw:        Number(data?.weekly_budget_krw ?? DEFAULT_WEEKLY_BUDGET),
    dip_buy_enabled:          data?.dip_buy_enabled ?? true,
    dip_budget_krw:           Number(data?.dip_budget_krw ?? DEFAULT_DIP_BUDGET),
    coins:                    data?.coins ?? DEFAULT_COINS,
    split:                    data?.split ?? DEFAULT_SPLIT,
    profit_take_enabled:      data?.profit_take_enabled ?? true,
    signal_sell_enabled:      data?.signal_sell_enabled ?? true,
    signal_buy_enabled:       data?.signal_buy_enabled ?? true,
    signal_boost_enabled:     data?.signal_boost_enabled ?? true,
    fear_greed_gate_enabled:  data?.fear_greed_gate_enabled ?? true,
    trailing_stop_enabled:    data?.trailing_stop_enabled ?? true,
    trailing_stop_pct:        Number(data?.trailing_stop_pct ?? 20),
    bear_market_pause_enabled:data?.bear_market_pause_enabled ?? true,
    min_signal_score:         Number(data?.min_signal_score ?? 0),
    // Capital % mode — budget scales automatically with KRW balance (always on by default)
    capital_pct_mode:         data?.capital_pct_mode ?? true,
    dca_cooldown_days:        Number(data?.dca_cooldown_days ?? 1),  // days between DCA runs (1 = daily)
    dca_pct_of_krw:           Number(data?.dca_pct_of_krw ?? 20),   // % of KRW to spend per DCA
    dip_pct_of_krw:           Number(data?.dip_pct_of_krw ?? 10),   // % of KRW per dip signal
    max_dca_krw:              Number(data?.max_dca_krw ?? 0),        // 0 = no cap
    max_dip_krw:              Number(data?.max_dip_krw ?? 0),        // 0 = no cap
    last_dca_run:             data?.last_dca_run ?? null,
    last_dip_run:             data?.last_dip_run ?? null,
    id:                       data?.id ?? null,
  };
}

async function saveConfig(supabase, updates) {
  const current = await getConfig(supabase);
  if (current.id) {
    await supabase.from('crypto_trader_config')
      .update({ ...updates, updated_at: new Date().toISOString() }).eq('id', current.id);
  } else {
    await supabase.from('crypto_trader_config').insert(updates);
  }
}

async function logTrade(supabase, trade) {
  await supabase.from('crypto_trade_log').insert({
    coin: trade.coin, side: trade.side,
    krw_amount:     trade.krwAmount   ?? null,
    coin_amount:    trade.coinAmount  ?? null,
    price_krw:      trade.priceKrw   ?? null,
    reason:         trade.reason,
    upbit_order_id: trade.upbitOrderId ?? null,
    signal_score:   trade.signalScore  ?? null,
    executed_at:    new Date().toISOString(),
  });
}

async function logProfitTake(supabase, entry) {
  await supabase.from('crypto_profit_take_log').insert({
    coin:              entry.coin,
    level:             entry.level,
    avg_buy_price_krw: entry.avgBuyPrice,
    trigger_price_krw: entry.triggerPrice,
    sold_amount:       entry.soldAmount,
    upbit_order_id:    entry.upbitOrderId ?? null,
    triggered_at:      new Date().toISOString(),
  });
}

async function isRecentlySold(supabase, coin, level, cooldownHours) {
  const since = new Date(Date.now() - cooldownHours * 3600000).toISOString();
  const { data } = await supabase.from('crypto_profit_take_log')
    .select('id').eq('coin', coin).eq('level', level).gte('triggered_at', since).limit(1);
  return (data || []).length > 0;
}

async function isRecentlyBought(supabase, coin, reason, cooldownHours) {
  const since = new Date(Date.now() - cooldownHours * 3600000).toISOString();
  const { data } = await supabase.from('crypto_trade_log')
    .select('id').eq('coin', coin).eq('side', 'buy').eq('reason', reason)
    .gte('executed_at', since).limit(1);
  return (data || []).length > 0;
}

/**
 * Returns true if this coin had ANY sell in the last `cooldownHours`.
 * Used to prevent buying back immediately after selling (fee churn).
 */
async function isRecentlySoldAny(supabase, coin, cooldownHours) {
  const since = new Date(Date.now() - cooldownHours * 3600000).toISOString();
  const { data } = await supabase.from('crypto_trade_log')
    .select('id').eq('coin', coin).eq('side', 'sell')
    .gte('executed_at', since).limit(1);
  return (data || []).length > 0;
}

async function getLatestSignalScore(supabase) {
  const { data } = await supabase.from('fx_signal_runs')
    .select('score, decision').order('created_at', { ascending: false }).limit(1).single();
  return { score: data?.score ?? null, decision: data?.decision ?? null };
}

// ─── External market data ─────────────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 });
    const d = res.data?.data?.[0];
    return d ? { value: Number(d.value), label: d.value_classification } : null;
  } catch (_) { return null; }
}

/**
 * Fetch USD/KRW rate. Used to compute kimchi premium.
 * Falls back to a conservative estimate so nothing breaks.
 */
async function fetchUsdKrw() {
  try {
    const res = await axios.get('https://api.frankfurter.app/latest?from=USD&to=KRW', { timeout: 6000 });
    return res.data?.rates?.KRW ?? null;
  } catch (_) { return null; }
}

/**
 * Fetch Binance USD prices for all active coins.
 * Returns { BTC: 95000, ETH: 3400, SOL: 160 } etc.
 */
async function fetchBinancePrices(coins) {
  const prices = {};
  try {
    const symbols = coins.map((c) => BINANCE_SYMBOL[c]).filter(Boolean);
    if (symbols.length === 0) return prices;
    const res = await axios.get('https://api.binance.com/api/v3/ticker/price', {
      params: { symbols: JSON.stringify(symbols) },
      timeout: 8000,
    });
    for (const item of res.data) {
      const coin = Object.entries(BINANCE_SYMBOL).find(([, s]) => s === item.symbol)?.[0];
      if (coin) prices[coin] = Number(item.price);
    }
  } catch (_) {}
  return prices;
}

/**
 * Calculate Kimchi premium per coin.
 * Positive = Korean market premium over global price (potential overheating → sell).
 * Negative = Korean market discount (cheap → buy).
 */
function calcKimchiPremiums(priceMapKrw, binancePricesUsd, usdKrw) {
  const premiums = {};
  if (!usdKrw || usdKrw <= 0) return premiums;
  for (const [coin, krwPrice] of Object.entries(priceMapKrw)) {
    const usdPrice = binancePricesUsd[coin];
    if (!usdPrice) continue;
    const globalKrwEquivalent = usdPrice * usdKrw;
    if (globalKrwEquivalent > 0) {
      premiums[coin] = (krwPrice / globalKrwEquivalent - 1) * 100;
    }
  }
  return premiums;
}

// ─── Price highs tracking ─────────────────────────────────────────────────────

async function getPriceHighs(supabase) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'crypto_price_highs').single();
  return data?.value ?? {};
}

async function updatePriceHighs(supabase, priceMap, coins) {
  const highs = await getPriceHighs(supabase);
  const cutoff = Date.now() - TRAILING_WINDOW_DAYS * 86400000;
  const updated = { ...highs };
  for (const coin of coins) {
    const price = priceMap[coin];
    if (!price) continue;
    const existing = updated[coin];
    const expired = !existing || new Date(existing.recordedAt).getTime() < cutoff;
    if (expired || price > (existing?.high ?? 0)) {
      updated[coin] = { high: price, recordedAt: new Date().toISOString() };
    }
  }
  await supabase.from('app_settings').upsert(
    { key: 'crypto_price_highs', value: updated, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  return updated;
}

async function isBearMarket(supabase, btcPriceKrw) {
  if (!btcPriceKrw) return false;
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'btc_90d_high').single();
  let high90d = data?.value?.high ?? 0;
  if (btcPriceKrw > high90d) {
    high90d = btcPriceKrw;
    await supabase.from('app_settings').upsert(
      { key: 'btc_90d_high', value: { high: high90d, recordedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  }
  if (high90d === 0) return false;
  return (high90d - btcPriceKrw) / high90d * 100 >= 30;
}

// ─── Portfolio snapshot (saved by Pi, read by Vercel) ────────────────────────

/**
 * Builds a full portfolio snapshot from raw Upbit account data + prices.
 * The Pi calls this and writes to Supabase; Vercel reads it for the dashboard.
 */
async function savePortfolioSnapshot(supabase, { accounts, priceMap, usdKrw, coins, config }) {
  try {
    const priceHighs = await getPriceHighs(supabase);
    const { data: indData } = await supabase.from('app_settings').select('value').eq('key', 'coin_indicators').single();
    const indicators = indData?.value ?? {};

    const krwAccount  = accounts.find((a) => a.currency === 'KRW');
    const krwBalance  = Number(krwAccount?.balance ?? 0);

    const positions = (coins || DEFAULT_COINS).map((coin) => {
      const acc           = accounts.find((a) => a.currency === coin);
      const balance       = Number(acc?.balance ?? 0);
      const avgBuyKrw     = Number(acc?.avg_buy_price ?? 0);
      const currentPrice  = priceMap[coin] ?? null;
      const currentValueKrw = currentPrice ? balance * currentPrice : null;
      const currentValueUsd = currentValueKrw && usdKrw ? currentValueKrw / usdKrw : null;
      const avgBuyUsd     = avgBuyKrw && usdKrw ? avgBuyKrw / usdKrw : null;
      const gainPct       = avgBuyKrw > 0 && currentPrice ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;
      const high14d       = priceHighs[coin]?.high ?? null;
      const dropFromHigh  = high14d && currentPrice ? (high14d - currentPrice) / high14d * 100 : null;
      const ind           = indicators[coin] ?? {};
      const nextProfitTake = gainPct != null ? PROFIT_LEVELS.find((l) => gainPct < l.gainThreshold) ?? null : null;
      return {
        coin, balance, avgBuyKrw, avgBuyUsd,
        currentPrice, currentValueKrw, currentValueUsd,
        gainPct, high14d, dropFromHigh,
        indicators: ind,
        nextProfitTakeLevel: nextProfitTake
          ? `+${nextProfitTake.gainThreshold}% (sell ${nextProfitTake.sellPct}%)`
          : gainPct != null ? 'All levels passed' : null,
      };
    });

    const totalValueKrw = positions.reduce((s, p) => s + (p.currentValueKrw ?? 0), krwBalance);
    const totalValueUsd = usdKrw ? totalValueKrw / usdKrw : null;

    // Effective budgets for dashboard preview
    const effectiveDcaBudget = config?.capital_pct_mode
      ? Math.min(Math.round(krwBalance * (config.dca_pct_of_krw ?? 20) / 100), (config.max_dca_krw ?? 0) > 0 ? config.max_dca_krw : Infinity)
      : (config?.weekly_budget_krw ?? DEFAULT_WEEKLY_BUDGET);
    const effectiveDipBudget = config?.capital_pct_mode
      ? Math.min(Math.round(krwBalance * (config.dip_pct_of_krw ?? 10) / 100), (config.max_dip_krw ?? 0) > 0 ? config.max_dip_krw : Infinity)
      : (config?.dip_budget_krw ?? DEFAULT_DIP_BUDGET);

    await supabase.from('app_settings').upsert(
      {
        key: 'crypto_portfolio_snapshot',
        value: {
          krwBalance,
          krwBalanceUsd: usdKrw ? krwBalance / usdKrw : null,
          usdKrw,
          positions,
          totalValueKrw,
          totalValueUsd,
          effectiveDcaBudget,
          effectiveDipBudget,
          updatedAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );
  } catch (err) {
    console.error('[snapshot] Failed to save portfolio snapshot:', err.message);
  }
}

// ─── Technical analysis per coin ─────────────────────────────────────────────

async function analyzeCoins(coins, orderBooks, kimchiPremiums) {
  const results = {};

  // Parse order book imbalance per coin
  const obImbalance = {};
  for (const ob of orderBooks) {
    const coin = ob.market?.split('-')[1];
    if (!coin) continue;
    const totalBid = ob.total_bid_size || 0;
    const totalAsk = ob.total_ask_size || 0;
    const total = totalBid + totalAsk;
    obImbalance[coin] = total > 0 ? totalBid / total : null;
  }

  await Promise.all(coins.map(async (coin) => {
    try {
      const data = await upbit.getCandleData(`KRW-${coin}`);
      const extras = {
        highs:              data.highs4h,
        lows:               data.lows4h,
        orderBookImbalance: obImbalance[coin] ?? null,
        kimchiPremium:      kimchiPremiums[coin] ?? null,
      };

      // Primary analysis on 4h candles (swing trades)
      const sig4h  = compositeSignal(data.closes4h, data.volumes4h, data.candles4h, extras);

      // Fast analysis on 1h candles (scalp entries)
      const sig1h  = compositeSignal(data.closes1h, data.volumes1h, data.candles1h, {
        highs: data.highs1h, lows: data.lows1h,
        orderBookImbalance: obImbalance[coin] ?? null,
        kimchiPremium: kimchiPremiums[coin] ?? null,
      });

      // Daily for trend context
      const sigDay = compositeSignal(data.closes1d, data.volumes1d, data.candles1d);

      results[coin] = {
        ...sig4h,
        score1h:    sig1h.score,
        scoreTrend: sigDay.score,
        dailyRsi:   sigDay.rsi,
        // Combined score: 4h dominates, 1h adds urgency, daily provides context
        scoreCombined: Math.round(sig4h.score * 0.6 + sig1h.score * 0.3 + sigDay.score * 0.1),
        closes4h:   data.closes4h,
        closes1h:   data.closes1h,
        closes1d:   data.closes1d,
        obImbalance: obImbalance[coin] ?? null,
        kimchiPremium: kimchiPremiums[coin] ?? null,
      };
    } catch (err) {
      results[coin] = { error: err.message, score: 0, scoreCombined: 0, signals: [] };
    }
  }));
  return results;
}

// ─── Sell execution helper ────────────────────────────────────────────────────

async function sellCoin(supabase, coin, balance, currentPrice, sellPct, reason, label, extra = {}) {
  const sellAmount   = Math.floor(balance * (sellPct / 100) * 1e8) / 1e8;
  const grossKrw     = sellAmount * currentPrice;
  const feeKrw       = Math.round(grossKrw * UPBIT_FEE_PCT);
  const netKrw       = grossKrw - feeKrw;

  if (grossKrw < MIN_ORDER_KRW) {
    return { skipped: true, reason: `Value below minimum (₩${grossKrw.toFixed(0)})` };
  }
  try {
    const order = await upbit.marketSell(`KRW-${coin}`, sellAmount);
    await logTrade(supabase, { coin, side: 'sell', coinAmount: sellAmount, priceKrw: currentPrice, reason, upbitOrderId: order.uuid });
    if (label) {
      await logProfitTake(supabase, { coin, level: label, avgBuyPrice: extra.avgBuyPrice ?? 0, triggerPrice: currentPrice, soldAmount: sellAmount, upbitOrderId: order.uuid });
    }
    console.log(`[sell] ${coin} ${reason}: gross ₩${Math.round(grossKrw).toLocaleString()} − fee ₩${feeKrw.toLocaleString()} = net ₩${Math.round(netKrw).toLocaleString()}`);
    return { ok: true, coin, reason, sellPct, soldAmount: sellAmount, grossKrw: Math.round(grossKrw), feeKrw, netKrw: Math.round(netKrw), orderId: order.uuid, ...extra };
  } catch (err) {
    return { ok: false, coin, reason, error: err.response?.data?.error?.message || err.message };
  }
}

// ─── Sell cycle ───────────────────────────────────────────────────────────────

async function runSells(supabase, config, accounts, priceMap, analysis, { krwRatio = 0 } = {}) {
  const results = [];
  const soldThisCycle = new Set();
  const coins = config.coins || DEFAULT_COINS;

  // ── Over-cashed guard ─────────────────────────────────────────────────────
  // If KRW already > 40% of portfolio, signal sells are paused.
  // Profit-take and trailing stop still run (they need actual % gain anyway).
  // This prevents the bot from liquidating positions while sitting on excess cash.
  const overCashed = krwRatio > 40;
  if (overCashed) {
    console.log(`[sell] KRW ratio ${krwRatio.toFixed(0)}% > 40% — signal sells PAUSED until cash is redeployed`);
  }

  for (const coin of coins) {
    const account = accounts.find((a) => a.currency === coin);
    if (!account) continue;
    const balance     = Number(account.balance);
    const avgBuyKrw   = Number(account.avg_buy_price);
    const currentPrice = priceMap[coin];
    if (balance <= 0 || !currentPrice) continue;

    const gainPct = avgBuyKrw > 0 ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;
    const sig     = analysis[coin];

    // Net gain after round-trip fees (0.25% buy + 0.25% sell = 0.50%).
    // Only signal-sell when we're net-profitable after fees.
    const netGainPct = gainPct != null ? gainPct - ROUND_TRIP_FEE_PCT : null;

    // Helper: sell and mark coin as sold this cycle
    const sell = async (...args) => {
      const r = await sellCoin(supabase, ...args);
      if (r.ok) soldThisCycle.add(coin);
      return r;
    };

    // 1. Fixed profit-take tiers (tighter cooldowns for frequent re-triggering)
    if (config.profit_take_enabled && gainPct != null) {
      for (const level of PROFIT_LEVELS) {
        if (gainPct >= level.gainThreshold) {
          const done = await isRecentlySold(supabase, coin, level.label, level.cooldownHours);
          if (!done) {
            results.push(await sell(coin, balance, currentPrice, level.sellPct,
              `PROFIT_TAKE_${level.label.toUpperCase()}`, level.label,
              { gainPct: gainPct.toFixed(1), avgBuyPrice: avgBuyKrw }));
          }
        }
      }
    }

    if (config.signal_sell_enabled && sig && !sig.error) {
      // Only sell via signals when net gain exceeds round-trip fee (0.70% threshold)
      // This ensures every signal sell is profitable after Upbit's 0.25%+0.25% fees
      const atProfit = netGainPct != null && netGainPct >= MIN_PROFIT_TO_SELL;

      // ── Skip signal sells when over-cashed or in global cooldown ────────────
      const recentSignalSell = await isRecentlySoldAny(supabase, coin, 6);
      if (overCashed) {
        // already logged above — just skip
      } else if (recentSignalSell) {
        console.log(`[sell] ${coin} — signal sell cooldown active (sold in last 6h) — skipping`);
      } else {

      // ── Signal stacking: count simultaneous sell conditions ───────────────────
      // When multiple indicators agree the asset is overbought, sell a larger slice.
      const sellConditions = [
        sig.rsi != null && sig.rsi > 75,
        sig.bb?.pctB > 1.0,
        sig.macd?.bearishCross,
        sig.stochRsi != null && sig.stochRsi > 85,
        sig.vwapDev != null && sig.vwapDev > 3,
        sig.williamsR != null && sig.williamsR > -5,
        sig.cci != null && sig.cci > 150,
        sig.kimchiPremium != null && sig.kimchiPremium > 4,
      ].filter(Boolean).length;

      // Scale factor: ≥5 signals → 1.8×, ≥3 → 1.35×, else 1×
      // Cap at 15% max — prevents wiping out too much of a position in one sell
      const stackFactor = sellConditions >= 5 ? 1.8 : sellConditions >= 3 ? 1.35 : 1;
      const scaleSell   = (base) => Math.min(Math.round(base * stackFactor), 15);

      if (sellConditions >= 3 && !atProfit) {
        console.log(`[sell] ${coin} — ${sellConditions} sell signals BUT not yet profitable (${netGainPct != null ? netGainPct.toFixed(2) : '?'}% < ${MIN_PROFIT_TO_SELL}% min) — holding`);
      } else if (sellConditions >= 3) {
        console.log(`[sell] ${coin} — ${sellConditions} simultaneous sell signals (factor ${stackFactor}×) — picking strongest`);
      }

      // ── Collect valid signal candidates, then execute ONLY THE STRONGEST ────────
      // Multiple signals firing the same cycle used to sell 4×16% = 64% in 5 min.
      // Now: evaluate all, pick the one with the highest sell%, execute once per cycle.
      // Remaining signals will fire in future cycles once cooldowns allow.
      const signalCandidates = [];

      const addCandidate = async (condition, levelKey, sellPct, reason, cooldownH, extra = {}) => {
        if (!condition || !atProfit) return;
        const done = await isRecentlySold(supabase, coin, levelKey, cooldownH);
        if (!done) signalCandidates.push({ sellPct: scaleSell(sellPct), reason, level: levelKey, extra });
      };

      // 2. RSI overbought
      if (sig.rsi != null && sig.rsi > 85) {
        await addCandidate(true, 'rsi_ob_strong', 20, 'SIGNAL_RSI_OB_STRONG', 4, { rsi: sig.rsi.toFixed(1) });
      } else if (sig.rsi != null && sig.rsi > 75) {
        await addCandidate(true, 'rsi_ob', 12, 'SIGNAL_RSI_OVERBOUGHT', 4, { rsi: sig.rsi.toFixed(1) });
      }
      // 3. Bollinger upper breakout
      await addCandidate(sig.bb?.pctB > 1.0, 'bb_upper', 12, 'SIGNAL_BB_UPPER', 2, { pctB: sig.bb?.pctB?.toFixed(2) });
      // 4. MACD bearish cross
      await addCandidate(sig.macd?.bearishCross, 'macd_bear', 10, 'SIGNAL_MACD_BEAR', 4);
      // 5. StochRSI overbought
      await addCandidate(sig.stochRsi != null && sig.stochRsi > 85, 'stochrsi_ob', 10, 'SIGNAL_STOCHRSI_OB', 2, { stochRsi: sig.stochRsi?.toFixed(1) });
      // 6. VWAP deep above
      await addCandidate(sig.vwapDev != null && sig.vwapDev > 3, 'vwap_above', 12, 'SIGNAL_VWAP_ABOVE', 2, { vwapDev: sig.vwapDev?.toFixed(1) });
      // 7. Williams %R overbought
      await addCandidate(sig.williamsR != null && sig.williamsR > -5, 'williams_ob', 10, 'SIGNAL_WILLIAMS_OB', 4, { wR: sig.williamsR?.toFixed(1) });
      // 8. CCI overbought
      await addCandidate(sig.cci != null && sig.cci > 150, 'cci_ob', 10, 'SIGNAL_CCI_OB', 2, { cci: sig.cci?.toFixed(0) });
      // 9. Kimchi premium
      await addCandidate(sig.kimchiPremium != null && sig.kimchiPremium > 4, 'kimchi_high', 15, 'SIGNAL_KIMCHI_HIGH', 4, { kimchi: sig.kimchiPremium?.toFixed(1) });

      if (signalCandidates.length > 0) {
        // Sort by sell% descending and take only the strongest this cycle
        signalCandidates.sort((a, b) => b.sellPct - a.sellPct);
        const best = signalCandidates[0];
        if (signalCandidates.length > 1) {
          console.log(`[sell] ${coin} — ${signalCandidates.length} valid signals; executing strongest (${best.reason} ${best.sellPct}%), 3h global cooldown starts now`);
        }
        results.push(await sell(coin, balance, currentPrice, best.sellPct, best.reason, best.level, best.extra));
      }

      } // end else (global cooldown check)
    }

    // 10. Trailing stop (never sell at a loss)
    if (config.trailing_stop_enabled && gainPct != null && gainPct > 0) {
      const { data: hsData } = await supabase.from('app_settings').select('value').eq('key', 'crypto_price_highs').single();
      const highData = hsData?.value?.[coin];
      if (highData) {
        const dropFromHigh = (highData.high - currentPrice) / highData.high * 100;
        if (dropFromHigh >= config.trailing_stop_pct) {
          const done = await isRecentlySold(supabase, coin, 'trailing_stop', 30 * 24);
          if (!done) {
            results.push(await sell(coin, balance, currentPrice, TRAILING_STOP_SELL_PCT, 'TRAILING_STOP', 'trailing_stop',
              { dropFromHigh: dropFromHigh.toFixed(1), avgBuyPrice: avgBuyKrw }));
          }
        }
      }
    }
  }
  return { results, soldThisCycle };
}

// ─── Dip buy cycle ────────────────────────────────────────────────────────────

async function runDipBuys(supabase, config, priceMap, analysis, availableKrw, bear, {
  totalPortfolioKrw = 0, portfolioWeights = {}, soldThisCycle = new Set(), krwRatio = 0,
} = {}) {
  const overCashed = krwRatio > 40; // sitting on too much cash — be more aggressive buying
  const results = [];
  if (!config.dip_buy_enabled) return results;

  const coins  = config.coins || DEFAULT_COINS;
  const split  = config.split || DEFAULT_SPLIT;

  // ── Cash reserve floor: never spend KRW below 15% of total portfolio ─────────
  const cashReserveFloor = totalPortfolioKrw > 0 ? totalPortfolioKrw * CASH_RESERVE_PCT : 0;
  const deployableKrw    = Math.max(0, availableKrw - cashReserveFloor);

  // Capital % mode: dip budget = X% of current KRW balance (scales as you deposit more)
  let baseBudget;
  if (config.capital_pct_mode) {
    baseBudget = Math.round(availableKrw * config.dip_pct_of_krw / 100);
    if (config.max_dip_krw > 0) baseBudget = Math.min(baseBudget, config.max_dip_krw);
  } else {
    baseBudget = config.dip_budget_krw;
  }

  const budget  = Math.round(baseBudget * (bear ? 0.5 : 1));
  let remaining = Math.min(deployableKrw, budget);

  console.log(div());
  console.log(`  DIP BUY SCAN`);
  console.log(`  KRW balance    : ${fmtKrw(availableKrw)}  |  Cash reserve floor : ${fmtKrw(cashReserveFloor)} (15% of ${fmtKrw(totalPortfolioKrw)})`);
  console.log(`  Budget         : ${fmtKrw(budget)}  |  Deployable         : ${fmtKrw(remaining)}${bear ? '  |  ⚠ BEAR MARKET — budget halved' : ''}`);

  if (remaining < MIN_ORDER_KRW) {
    console.log(`  ✗ Deployable KRW too low — all dip buys skipped`);
    return results;
  }

  for (const coin of coins) {
    const sig = analysis[coin];
    console.log(div('·'));
    console.log(`  ${coin}`);

    if (!sig || sig.error) {
      console.log(`    ✗ No analysis data${sig?.error ? `: ${sig.error}` : ''}`);
      continue;
    }

    // ── Indicator snapshot ────────────────────────────────────────────────────
    console.log(`    Indicators (4h) :`);
    console.log(`      RSI14=${pad(sig.rsi?.toFixed(1),6)}  RSI7=${pad(sig.rsi7?.toFixed(1),6)}  StochRSI=${pad(sig.stochRsi?.toFixed(1),6)}  BB pctB=${pad(sig.bb?.pctB?.toFixed(3),7)}`);
    console.log(`      VWAP dev=${pad(sig.vwapDev != null ? sig.vwapDev.toFixed(1)+'%' : null,7)}  WilliamsR=${pad(sig.williamsR?.toFixed(1),7)}  CCI=${pad(sig.cci?.toFixed(0),7)}  ROC=${pad(sig.roc != null ? sig.roc.toFixed(1)+'%' : null,7)}`);
    console.log(`      mom24=${pad(sig.mom24 != null ? sig.mom24.toFixed(1)+'%' : null,7)}  MACD bull=${sig.macd?.bullishCross ? 'YES' : 'no '}  OBV=${sig.obvSlope > 0 ? 'accum' : 'distr'}  OB imbal=${sig.obImbalance != null ? (sig.obImbalance*100).toFixed(0)+'%' : '—'}`);
    console.log(`      Score  4h=${pad(sig.score,4)}  1h=${pad(sig.score1h,4)}  daily=${pad(sig.scoreTrend,4)}  combined=${sig.scoreCombined}`);
    console.log(`      Active signals: ${sig.signals?.map((s) => s.name).join(', ') || 'none'}`);

    // ── Anti-churn: never buy a coin we just sold this cycle or in last 1h ────
    if (soldThisCycle.has(coin)) {
      console.log(`    ✗ SKIP — sold this cycle (anti-churn)`);
      continue;
    }
    const recentlySold = await isRecentlySoldAny(supabase, coin, 0.5); // 30 min
    if (recentlySold) {
      console.log(`    ✗ SKIP — sold in last 30min (anti-churn)`);
      continue;
    }

    // ── Score gate ─────────────────────────────────────────────────────────────
    // In bear markets the composite score is negative even when individual indicators
    // show genuine oversold conditions (RSI < 35, BB below lower, etc.).
    // Allow dip buys when: score >= 2 (net bullish) OR a strong individual oversold
    // signal fires. Block only if score is deeply negative AND no oversold signal.
    const score = sig.scoreCombined ?? sig.score ?? 0;
    // Standard oversold: RSI < 35, BB below lower, etc.
    const hasOversoldSignal =
      (sig.rsi     != null && sig.rsi     < 35)  ||
      (sig.bb?.pctB < 0)                         ||
      (sig.williamsR != null && sig.williamsR < -90) ||
      (sig.cci     != null && sig.cci     < -150) ||
      (sig.mom24   != null && sig.mom24   < -8);
    // RSI pullback: RSI cooled from overbought back to neutral — swing re-entry
    const hasPullbackSignal = sig.rsi != null && sig.rsi < 50 && sig.rsi >= 30;
    // Relaxed RSI gate scales aggressively with how over-cashed we are.
    // KRW>80% → accept RSI<72 (all but extreme peaks), KRW>70% → RSI<68, KRW>55% → RSI<63, else RSI<58
    const relaxedRsiThresh = overCashed
      ? (krwRatio > 80 ? 72 : krwRatio > 70 ? 68 : krwRatio > 55 ? 63 : 58)
      : 0;
    const hasRelaxedSignal = overCashed && sig.rsi != null && sig.rsi < relaxedRsiThresh;
    // High composite score always allows buying regardless of RSI
    const hasHighScore = score >= 3;

    if (score < 2 && !hasOversoldSignal && !hasPullbackSignal && !hasRelaxedSignal && !hasHighScore) {
      console.log(`    ✗ SKIP — score ${score} < 2, RSI ${sig.rsi?.toFixed(1)} (thresh ${relaxedRsiThresh}), no oversold/pullback/high-score`);
      continue;
    }
    if (hasHighScore)       console.log(`    ✓ High score ${score} ≥ 3 — buying`);
    else if (hasPullbackSignal)          console.log(`    ✓ RSI pullback ${sig.rsi?.toFixed(1)} < 50 — swing re-entry`);
    else if (hasRelaxedSignal)           console.log(`    ✓ Over-cashed ${krwRatio?.toFixed(0)}% KRW — re-entry RSI ${sig.rsi?.toFixed(1)} < ${relaxedRsiThresh}`);

    const pct = split[coin] ?? 0;
    if (pct <= 0) { console.log(`    ✗ SKIP — no allocation for ${coin}`); continue; }

    // ── Portfolio weight awareness: don't pile into an already overweight coin ─
    const targetWeight  = pct;
    const currentWeight = portfolioWeights[coin] ?? 0;
    const isOverweight  = totalPortfolioKrw > 0 && currentWeight > targetWeight * 1.3;
    if (isOverweight && score < 5) {
      console.log(`    ✗ SKIP — overweight ${currentWeight.toFixed(1)}% vs target ${targetWeight}% (need score ≥5, have ${score})`);
      continue;
    }

    // Base order amount from budget split; apply conviction multiplier
    const baseAmount  = Math.round(budget * pct / 100);
    const mult        = convictionMult(score) * (isOverweight ? 0.5 : 1);
    const orderAmount = Math.min(Math.round(baseAmount * mult), remaining);

    if (orderAmount < MIN_ORDER_KRW || remaining < MIN_ORDER_KRW) {
      console.log(`    ✗ SKIP — order amount too low (${fmtKrw(orderAmount)}, min ${fmtKrw(MIN_ORDER_KRW)})`);
      continue;
    }

    console.log(`    Score ✓ ${score} | Order ${fmtKrw(orderAmount)} (${pct}% × ${mult.toFixed(2)}× mult${isOverweight ? ', OW½' : ''})`);

    // ── Full signal evaluation — log every signal, then execute first eligible ─
    // Includes pullback re-entry (DIP_RSI_PULLBACK) which buys at half size
    const allSignals = [
      ...evaluateDipSignals(sig, score),
      { reason: 'DIP_RSI_PULLBACK', cooldown: 4, sizeMult: 0.5,
        met: sig.rsi != null && sig.rsi < 50 && sig.rsi >= 30,
        val: sig.rsi?.toFixed(1), thresh: 'RSI 30–50' },
    ];
    const metSignals = allSignals.filter((s) => s.met);

    console.log(`    Signal evaluation (${allSignals.length} total, ${metSignals.length} threshold met):`);
    for (const s of allSignals) {
      console.log(`      ${s.met ? '✓' : '✗'} ${pad(s.reason, 24)} val=${pad(s.val, 8)} thresh=${s.thresh}${s.sizeMult ? `  [size ${s.sizeMult}×]` : ''}`);
    }

    if (metSignals.length === 0) {
      console.log(`    → No signal thresholds met — not buying`);
      continue;
    }

    let executed = false;
    console.log(`    Cooldown checks for ${metSignals.length} met signal(s):`);
    for (const { reason, cooldown, sizeMult = 1 } of metSignals) {
      if (executed) break;
      const recent = await isRecentlyBought(supabase, coin, reason, cooldown);
      if (recent) {
        console.log(`      ⏱ ${reason} — on cooldown (${cooldown}h)`);
        continue;
      }

      const thisAmount = Math.min(Math.round(orderAmount * sizeMult), remaining);
      if (thisAmount < MIN_ORDER_KRW) { console.log(`      ✗ ${reason} — order too small after sizeMult (${fmtKrw(thisAmount)})`); continue; }

      console.log(`      ✓ ${reason} — cooldown clear → EXECUTING${sizeMult < 1 ? ` (${sizeMult}× size = ${fmtKrw(thisAmount)})` : ''}`);
      try {
        const order    = await upbit.marketBuy(`KRW-${coin}`, thisAmount);
        const feeKrw   = Math.round(thisAmount * UPBIT_FEE_PCT);
        const coinKrw  = thisAmount - feeKrw;
        await logTrade(supabase, {
          coin, side: 'buy', krwAmount: thisAmount,
          priceKrw: priceMap[coin] ?? null,
          reason, upbitOrderId: order.uuid,
          signalScore: score,
        });
        console.log(`    ✅ BUY ${coin} ${reason} — ${fmtKrw(thisAmount)} − fee ${fmtKrw(feeKrw)} = ${fmtKrw(coinKrw)} in coin (score ${score}, ${(mult * sizeMult).toFixed(2)}×)`);
        remaining -= thisAmount;
        results.push({ coin, ok: true, reason, krwAmount: thisAmount, feeKrw, score, mult: (mult * sizeMult).toFixed(2), orderId: order.uuid });
        executed = true;
      } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        console.error(`    ✗ BUY FAILED ${coin} ${reason}: ${errMsg}`);
        results.push({ coin, ok: false, reason, error: errMsg });
        executed = true;
      }
    }

    if (!executed && metSignals.length > 0) {
      console.log(`    → All met signals on cooldown — not buying`);
    }
  }

  if (results.some((r) => r.ok)) {
    await saveConfig(supabase, { last_dip_run: new Date().toISOString() });
  }
  return results;
}

// ─── Weekly DCA ───────────────────────────────────────────────────────────────

async function runDca(supabase, config, signalScore, fearGreed, priceMap, bear, accounts, analysis = {}) {
  const results = [];

  if (fearGreed?.value > 75) return [{ skipped: true, reason: `Extreme Greed (F&G ${fearGreed.value}) — skipping DCA` }];
  if (signalScore !== null && signalScore < config.min_signal_score) return [{ skipped: true, reason: `Macro score ${signalScore} below minimum` }];

  let budgetMultiplier = 1;
  if (fearGreed?.value < 25) budgetMultiplier *= 2;         // Extreme Fear = double down
  if (config.signal_boost_enabled && signalScore >= 5) budgetMultiplier *= 1.5;
  if (bear) budgetMultiplier *= 0.5;

  const coins = config.coins || DEFAULT_COINS;
  const split = config.split || DEFAULT_SPLIT;

  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  let availableKrw = Number(krwAccount?.balance ?? 0);
  if (availableKrw < MIN_ORDER_KRW) return [{ skipped: true, reason: `Insufficient KRW (₩${Math.floor(availableKrw).toLocaleString()})` }];

  // Capital % mode: DCA budget = X% of current KRW balance (auto-scales when you deposit more)
  let baseBudget;
  if (config.capital_pct_mode) {
    baseBudget = Math.round(availableKrw * config.dca_pct_of_krw / 100);
    if (config.max_dca_krw > 0) baseBudget = Math.min(baseBudget, config.max_dca_krw);
    console.log(`[DCA] Capital % mode: ${config.dca_pct_of_krw}% of ₩${Math.floor(availableKrw).toLocaleString()} = ₩${baseBudget.toLocaleString()}`);
  } else {
    baseBudget = config.weekly_budget_krw;
  }

  const budget = Math.round(baseBudget * budgetMultiplier);

  // Signal-tilted allocation: shift budget toward coins with strongest buy signals
  const activeSplit = Object.keys(analysis).length > 0
    ? tiltedSplit(split, analysis, coins)
    : split;

  console.log(`[DCA] Tilted split: ${coins.map((c) => `${c}=${activeSplit[c] ?? split[c]}%`).join(', ')}`);

  for (const coin of coins) {
    const pct = activeSplit[coin] ?? split[coin] ?? 0;
    if (pct <= 0) continue;
    const krwAmount = Math.min(Math.round(budget * pct / 100), Math.floor(availableKrw * 0.99));
    if (krwAmount < MIN_ORDER_KRW) { results.push({ coin, skipped: true, reason: 'Below minimum or insufficient KRW' }); continue; }
    try {
      const order  = await upbit.marketBuy(`KRW-${coin}`, krwAmount);
      const feeKrw = Math.round(krwAmount * UPBIT_FEE_PCT);
      await logTrade(supabase, {
        coin, side: 'buy', krwAmount,
        priceKrw: priceMap[coin] ?? null,
        reason:   budgetMultiplier !== 1 ? `DCA_${budgetMultiplier.toFixed(1)}x` : 'DCA',
        upbitOrderId: order.uuid, signalScore,
      });
      console.log(`[DCA] ${coin}: ₩${krwAmount.toLocaleString()} − fee ₩${feeKrw.toLocaleString()} = ₩${(krwAmount - feeKrw).toLocaleString()} in coin`);
      availableKrw -= krwAmount;
      const dcaReason = budgetMultiplier !== 1 ? `DCA_${budgetMultiplier.toFixed(1)}x` : 'DCA';
      results.push({ coin, ok: true, krwAmount, feeKrw, budgetMultiplier, allocPct: pct, orderId: order.uuid, reason: dcaReason });
    } catch (err) {
      results.push({ coin, ok: false, error: err.response?.data?.error?.message || err.message });
    }
  }

  await saveConfig(supabase, { last_dca_run: new Date().toISOString() });
  return results;
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function executeCycle(supabase, { forceDca = false, dipBuyOnly = false } = {}) {
  const summary = { sells: [], dca: [], dipBuys: [], skipped: [], errors: [] };

  const { data: ks } = await supabase.from('app_settings').select('value').eq('key', 'kill_switch').single();
  if (ks?.value?.enabled) { summary.skipped.push('Kill switch active'); return summary; }

  const config = await getConfig(supabase);
  const coins  = config.coins || DEFAULT_COINS;

  // Fetch all market data in parallel
  const [accounts, tickers, fearGreed, { score: signalScore }, orderBooks, usdKrw, binancePrices] = await Promise.all([
    upbit.getAccounts().catch(() => []),
    upbit.getTicker(coins.map((c) => `KRW-${c}`)).catch(() => []),
    fetchFearGreed(),
    getLatestSignalScore(supabase),
    upbit.getOrderBook(coins.map((c) => `KRW-${c}`)).catch(() => []),
    fetchUsdKrw(),
    fetchBinancePrices(coins),
  ]);

  const priceMap = {};
  for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

  // ── Portfolio context (for cash reserve + weight awareness) ───────────────────
  const krwAccount       = accounts.find((a) => a.currency === 'KRW');
  const krwBalance       = Number(krwAccount?.balance ?? 0);
  const holdingsKrw      = coins.reduce((s, coin) => {
    const acc = accounts.find((a) => a.currency === coin);
    return s + Number(acc?.balance ?? 0) * (priceMap[coin] ?? 0);
  }, 0);
  const totalPortfolioKrw = krwBalance + holdingsKrw;
  const portfolioWeights  = {};
  for (const coin of coins) {
    const acc = accounts.find((a) => a.currency === coin);
    const val = Number(acc?.balance ?? 0) * (priceMap[coin] ?? 0);
    portfolioWeights[coin] = totalPortfolioKrw > 0 ? val / totalPortfolioKrw * 100 : 0;
  }

  // Kimchi premium per coin
  const kimchiPremiums = usdKrw ? calcKimchiPremiums(priceMap, binancePrices, usdKrw) : {};

  // Technical analysis per coin (with order book + kimchi)
  const analysis = await analyzeCoins(coins, orderBooks, kimchiPremiums).catch(() => ({}));

  // Update rolling price highs for trailing stop
  const priceHighs = await updatePriceHighs(supabase, priceMap, coins).catch(() => ({}));

  // Bear market check
  const bear = config.bear_market_pause_enabled
    ? await isBearMarket(supabase, priceMap.BTC).catch(() => false)
    : false;

  const krwRatio = totalPortfolioKrw > 0 ? (krwBalance / totalPortfolioKrw) * 100 : 0;

  // ── Market conditions + portfolio snapshot log ────────────────────────────────
  const cycleTs = new Date().toISOString();
  console.log(div('═'));
  console.log(`  CYCLE  ${cycleTs}  [${dipBuyOnly ? 'dip-only' : 'full'}]`);
  console.log(div());
  console.log(`  MARKET CONDITIONS`);
  console.log(`    Fear & Greed : ${fearGreed ? `${fearGreed.value} (${fearGreed.label})` : '— (unavailable)'}${fearGreed?.value > 75 ? '  ⚠ EXTREME GREED — dip buys & DCA blocked' : ''}`);
  console.log(`    Bear market  : ${bear ? 'YES ⚠  (BTC ≥30% below 90d high — budgets halved)' : 'no'}`);
  console.log(`    USD/KRW      : ${usdKrw ? usdKrw.toLocaleString() : '—'}`);
  console.log(`    FX signal    : ${signalScore ?? '—'}  |  KRW ratio: ${krwRatio.toFixed(1)}%${krwRatio > 40 ? '  (over-cashed — relaxed re-entry active)' : ''}`);
  console.log(div());
  console.log(`  PORTFOLIO`);
  console.log(`    KRW cash     : ${fmtKrw(krwBalance)}  (${krwRatio.toFixed(1)}% of portfolio)`);
  for (const coin of coins) {
    const acc      = accounts.find((a) => a.currency === coin);
    const bal      = Number(acc?.balance ?? 0);
    const avgBuy   = Number(acc?.avg_buy_price ?? 0);
    const price    = priceMap[coin];
    const val      = bal * (price ?? 0);
    const gainPct  = avgBuy > 0 && price ? (price - avgBuy) / avgBuy * 100 : null;
    const wt       = portfolioWeights[coin] ?? 0;
    const tgt      = (config.split || DEFAULT_SPLIT)[coin] ?? 0;
    const high14d  = priceHighs[coin]?.high;
    const dropFromHigh = high14d && price ? (high14d - price) / high14d * 100 : null;
    console.log(`    ${pad(coin,4)} : ${pad(bal.toFixed(6),12)} @ ${fmtKrw(price)}  = ${fmtKrw(val)}  gain=${fmtPct(gainPct)}  weight=${wt.toFixed(1)}%/tgt ${tgt}%${dropFromHigh != null ? `  14d high drop=${fmtPct(-dropFromHigh)}` : ''}`);
  }
  console.log(`    Total        : ${fmtKrw(totalPortfolioKrw)}${usdKrw ? ` (≈$${Math.round(totalPortfolioKrw / usdKrw).toLocaleString()})` : ''}`);

  // SELLS
  let soldThisCycle = new Set();
  if (!dipBuyOnly) {
    try {
      const sellResult = await runSells(supabase, config, accounts, priceMap, analysis, { krwRatio });
      summary.sells  = sellResult.results;
      soldThisCycle  = sellResult.soldThisCycle;
    } catch (err) { summary.errors.push(`Sells error: ${err.message}`); }
  }

  // ── Dynamic DCA cadence — shorten interval when signals are bullish ───────────
  const avgCombinedScore = coins.reduce((s, c) => s + (analysis[c]?.scoreCombined ?? 0), 0) / Math.max(coins.length, 1);
  const cooldown         = dcaCooldownDays(avgCombinedScore, fearGreed?.value ?? null, config.dca_cooldown_days ?? 1);

  // DIP BUYS — skip coins sold this cycle or in the last 1h (anti-churn)
  if (config.dip_buy_enabled && (fearGreed?.value ?? 50) <= 75) {
    try {
      summary.dipBuys = await runDipBuys(supabase, config, priceMap, analysis, krwBalance, bear, {
        totalPortfolioKrw, portfolioWeights, soldThisCycle, krwRatio,
      });
    } catch (err) { summary.errors.push(`Dip buy error: ${err.message}`); }
  }

  // WEEKLY DCA (cadence shortens from 7→5→3 days based on signal strength)
  // Also skip coins sold this cycle to avoid immediate re-buy
  if (config.dca_enabled && !dipBuyOnly) {
    const lastRun       = config.last_dca_run ? new Date(config.last_dca_run) : null;
    const daysSinceLast = lastRun ? (Date.now() - lastRun.getTime()) / 86400000 : 999;
    if (forceDca || daysSinceLast >= cooldown) {
      console.log(`[DCA] F&G ${fearGreed?.value ?? '?'} | score avg ${avgCombinedScore.toFixed(1)} → cooldown ${cooldown}d | last run ${daysSinceLast.toFixed(1)}d ago — RUNNING`);
      try {
        const freshAccounts = await upbit.getAccounts().catch(() => accounts);
        // Filter out coins sold this cycle from the DCA split
        const dcaConfig = soldThisCycle.size > 0
          ? { ...config, coins: config.coins.filter((c) => !soldThisCycle.has(c)) }
          : config;
        if (dcaConfig.coins.length > 0) {
          summary.dca = await runDca(supabase, dcaConfig, signalScore, fearGreed, priceMap, bear, freshAccounts, analysis);
        }
        if (soldThisCycle.size > 0) {
          summary.skipped.push(`DCA skipped for recently sold: ${[...soldThisCycle].join(', ')}`);
        }
      } catch (err) { summary.errors.push(`DCA error: ${err.message}`); }
    } else {
      summary.skipped.push(`DCA in ${(cooldown - daysSinceLast).toFixed(1)}d (F&G ${fearGreed?.value ?? '?'}, score avg ${avgCombinedScore.toFixed(1)}, cooldown ${cooldown}d)`);
    }
  }

  // Persist indicators + market data for dashboard
  const indicatorPayload = Object.fromEntries(Object.entries(analysis).map(([coin, sig]) => [coin, {
    rsi:          sig.rsi?.toFixed(1),
    rsi7:         sig.rsi7?.toFixed(1),
    stochRsi:     sig.stochRsi?.toFixed(1),
    bb_pctB:      sig.bb?.pctB?.toFixed(2),
    macdBull:     sig.macd?.bullishCross,
    macdBear:     sig.macd?.bearishCross,
    williamsR:    sig.williamsR?.toFixed(1),
    cci:          sig.cci?.toFixed(0),
    vwapDev:      sig.vwapDev?.toFixed(1),
    obImbalance:  sig.obImbalance != null ? (sig.obImbalance * 100).toFixed(0) : null,
    kimchiPremium:sig.kimchiPremium?.toFixed(1),
    roc:          sig.roc?.toFixed(1),
    score:        sig.score,
    score1h:      sig.score1h,
    scoreCombined: sig.scoreCombined,
    signals:      sig.signals?.map((s) => s.name),
  }]));

  try {
    await supabase.from('app_settings').upsert(
      { key: 'coin_indicators', value: indicatorPayload, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  } catch (_) {}

  if (fearGreed) {
    try {
      await supabase.from('app_settings').upsert(
        { key: 'fear_greed', value: { ...fearGreed, fetchedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch (_) {}
  }

  if (usdKrw) {
    try {
      await supabase.from('app_settings').upsert(
        { key: 'usd_krw_rate', value: { rate: usdKrw, fetchedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    } catch (_) {}
  }

  // Save full portfolio snapshot so Vercel dashboard can display live balances
  // without needing Upbit API keys (they live only on the Pi)
  const freshAccounts = await upbit.getAccounts().catch(() => accounts);
  await savePortfolioSnapshot(supabase, { accounts: freshAccounts, priceMap, usdKrw, coins, config });

  // ── Cycle summary log ─────────────────────────────────────────────────────────
  const buys  = [...(summary.dca || []), ...(summary.dipBuys || [])].filter((t) => t.ok);
  const sells = (summary.sells || []).filter((t) => t.ok);
  const avgCombinedScoreLog = coins.reduce((s, c) => s + (analysis[c]?.scoreCombined ?? 0), 0) / Math.max(coins.length, 1);

  console.log(div());
  console.log(`  SUMMARY`);
  console.log(`    Sells  : ${sells.length}  ${sells.map((t) => `${t.coin} ${t.reason} ${fmtKrw(t.grossKrw)}`).join(' | ') || '—'}`);
  console.log(`    Buys   : ${buys.length}   ${buys.map((t) => `${t.coin} ${t.reason} ${fmtKrw(t.krwAmount)}`).join(' | ') || '—'}`);
  console.log(`    Scores : ${coins.map((c) => `${c}=${analysis[c]?.scoreCombined ?? '—'}`).join('  ')}  avg=${avgCombinedScoreLog.toFixed(1)}`);
  if (summary.skipped?.length) console.log(`    Skipped: ${summary.skipped.join(' | ')}`);
  if (summary.errors?.length)  console.log(`    Errors : ${summary.errors.join(' | ')}`);
  console.log(div('═'));

  // ── Persist full cycle detail to Supabase (paste to AI for analysis) ──────────
  try {
    const cycleDetail = {
      ts: cycleTs,
      fearGreed:   fearGreed ?? null,
      bear,
      usdKrw:      usdKrw ?? null,
      signalScore: signalScore ?? null,
      portfolio: {
        krwBalance,
        totalKrw: totalPortfolioKrw,
        positions: coins.map((c) => {
          const acc    = accounts.find((a) => a.currency === c);
          const bal    = Number(acc?.balance ?? 0);
          const avgBuy = Number(acc?.avg_buy_price ?? 0);
          const price  = priceMap[c] ?? null;
          return {
            coin: c, balance: bal, avgBuyKrw: avgBuy, price,
            valueKrw: bal * (price ?? 0),
            gainPct: avgBuy > 0 && price ? +((price - avgBuy) / avgBuy * 100).toFixed(2) : null,
            weight:  +(portfolioWeights[c] ?? 0).toFixed(2),
            target:  (config.split || DEFAULT_SPLIT)[c] ?? 0,
          };
        }),
      },
      indicators: Object.fromEntries(coins.map((c) => {
        const s = analysis[c] ?? {};
        return [c, {
          rsi: s.rsi, rsi7: s.rsi7, stochRsi: s.stochRsi, bb_pctB: s.bb?.pctB,
          vwapDev: s.vwapDev, williamsR: s.williamsR, cci: s.cci, roc: s.roc,
          mom24: s.mom24, macdBull: s.macd?.bullishCross, obvSlope: s.obvSlope,
          score: s.score, score1h: s.score1h, scoreTrend: s.scoreTrend, scoreCombined: s.scoreCombined,
          signals: s.signals?.map((sig) => `${sig.name}(${sig.score > 0 ? '+' : ''}${sig.score})`),
          dipEval: evaluateDipSignals(s, s.scoreCombined ?? 0).map((e) => ({
            reason: e.reason, val: e.val, thresh: e.thresh, met: e.met,
          })),
        }];
      })),
      sells:   summary.sells,
      buys:    [...(summary.dca || []), ...(summary.dipBuys || [])],
      skipped: summary.skipped,
      errors:  summary.errors,
    };
    await supabase.from('app_settings').upsert(
      { key: 'last_cycle_detail', value: cycleDetail, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  } catch (_) {}

  return summary;
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function getStatus(supabase) {
  const [config, accounts, { score: signalScore, decision }] = await Promise.all([
    getConfig(supabase),
    upbit.getAccounts().catch(() => []),
    getLatestSignalScore(supabase),
  ]);

  const coins   = config.coins || DEFAULT_COINS;
  const tickers = await upbit.getTicker(coins.map((c) => `KRW-${c}`)).catch(() => []);
  const priceMap = {};
  for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

  const priceHighs = await getPriceHighs(supabase);
  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  const krwBalance = Number(krwAccount?.balance ?? 0);

  const { data: indData }  = await supabase.from('app_settings').select('value').eq('key', 'coin_indicators').single();
  const { data: fxData }   = await supabase.from('app_settings').select('value').eq('key', 'usd_krw_rate').single();
  const { data: fgData }   = await supabase.from('app_settings').select('value').eq('key', 'fear_greed').single();
  const indicators = indData?.value ?? {};
  const usdKrw     = fxData?.value?.rate ?? null;

  const positions = coins.map((coin) => {
    const acc           = accounts.find((a) => a.currency === coin);
    const balance       = Number(acc?.balance ?? 0);
    const avgBuyKrw     = Number(acc?.avg_buy_price ?? 0);
    const currentPrice  = priceMap[coin] ?? null;
    const currentValueKrw = currentPrice ? balance * currentPrice : null;
    const currentValueUsd = currentValueKrw && usdKrw ? currentValueKrw / usdKrw : null;
    const avgBuyUsd     = avgBuyKrw && usdKrw ? avgBuyKrw / usdKrw : null;
    const gainPct       = avgBuyKrw > 0 && currentPrice ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;
    const high14d       = priceHighs[coin]?.high ?? null;
    const dropFromHigh  = high14d && currentPrice ? (high14d - currentPrice) / high14d * 100 : null;
    const ind           = indicators[coin] ?? {};
    const nextProfitTake = gainPct != null ? PROFIT_LEVELS.find((l) => gainPct < l.gainThreshold) ?? null : null;
    return {
      coin, balance, avgBuyKrw, avgBuyUsd,
      currentPrice, currentValueKrw, currentValueUsd,
      gainPct, high14d, dropFromHigh,
      indicators: ind,
      nextProfitTakeLevel: nextProfitTake
        ? `+${nextProfitTake.gainThreshold}% (sell ${nextProfitTake.sellPct}%)`
        : gainPct != null ? 'All levels passed' : null,
    };
  });

  const { data: recentTrades } = await supabase.from('crypto_trade_log')
    .select('*').order('executed_at', { ascending: false }).limit(30);

  const totalValueKrw = positions.reduce((s, p) => s + (p.currentValueKrw ?? 0), krwBalance);
  const totalValueUsd = usdKrw ? totalValueKrw / usdKrw : null;

  // Compute effective budgets so the dashboard can show "will spend X next cycle"
  const effectiveDcaBudget = config.capital_pct_mode
    ? Math.min(Math.round(krwBalance * config.dca_pct_of_krw / 100), config.max_dca_krw > 0 ? config.max_dca_krw : Infinity)
    : config.weekly_budget_krw;
  const effectiveDipBudget = config.capital_pct_mode
    ? Math.min(Math.round(krwBalance * config.dip_pct_of_krw / 100), config.max_dip_krw > 0 ? config.max_dip_krw : Infinity)
    : config.dip_budget_krw;

  return {
    config, krwBalance,
    krwBalanceUsd: usdKrw ? krwBalance / usdKrw : null,
    usdKrw,
    positions,
    totalValueKrw,
    totalValueUsd,
    effectiveDcaBudget,
    effectiveDipBudget,
    signalScore, signalDecision: decision,
    recentTrades: recentTrades || [],
    fearGreed: fgData?.value ?? null,
    indicators,
  };
}

module.exports = { executeCycle, getStatus, getConfig, saveConfig, savePortfolioSnapshot };
