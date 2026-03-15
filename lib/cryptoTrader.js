/**
 * Crypto trading engine v4 — buy low sell high, maximum signal coverage.
 *
 * SELL triggers (every 5 min):
 *   1. Fixed profit-take   : +5/10/20/40% → sell 10/15/20/25% (cooldown 4/8/24/48h)
 *   2. RSI overbought      : >70 sell 12%, >80 sell 20%        (cooldown 2/2h)
 *   3. Bollinger breakout  : pctB > 1                          (cooldown 2h)
 *   4. MACD bear cross     : sell 10%                          (cooldown 4h)
 *   5. StochRSI overbought : >85 sell 10%                      (cooldown 2h)
 *   6. VWAP deep above     : >3% over VWAP, at profit          (cooldown 2h)
 *   7. Williams %R OB      : >-15 sell 10%                     (cooldown 2h)
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
const CASH_RESERVE_PCT = 0.15;

/**
 * Scale buy order size by signal conviction.
 * High score → buy more; neutral → standard; don't reduce below 0.8×.
 */
function convictionMult(score) {
  if (score >= 8) return 2.0;
  if (score >= 6) return 1.6;
  if (score >= 4) return 1.3;
  if (score >= 2) return 1.1;
  return 1.0;
}

/**
 * How many days to wait between DCA runs.
 * When the market is strongly bullish, buy more frequently.
 */
function dcaCooldownDays(avgScore) {
  if (avgScore >= 6) return 3;
  if (avgScore >= 3) return 5;
  return 7;
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

// Profit-take tiers — tighter cooldowns so the bot re-takes profits frequently
const PROFIT_LEVELS = [
  { gainThreshold:  5, label: '5pct',  sellPct: 10, cooldownHours:  4 },
  { gainThreshold: 10, label: '10pct', sellPct: 15, cooldownHours:  8 },
  { gainThreshold: 20, label: '20pct', sellPct: 20, cooldownHours: 24 },
  { gainThreshold: 40, label: '40pct', sellPct: 25, cooldownHours: 48 },
];

// Binance symbols for kimchi premium calculation
const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

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
    trailing_stop_pct:        Number(data?.trailing_stop_pct ?? 30),
    bear_market_pause_enabled:data?.bear_market_pause_enabled ?? true,
    min_signal_score:         Number(data?.min_signal_score ?? 0),
    // Capital % mode — budget scales automatically with KRW balance (always on by default)
    capital_pct_mode:         data?.capital_pct_mode ?? true,
    dca_pct_of_krw:           Number(data?.dca_pct_of_krw ?? 20),   // % of KRW to DCA each week
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
  const sellAmount = Math.floor(balance * (sellPct / 100) * 1e8) / 1e8;
  if (sellAmount * currentPrice < MIN_ORDER_KRW) {
    return { skipped: true, reason: `Value below minimum (₩${(sellAmount * currentPrice).toFixed(0)})` };
  }
  try {
    const order = await upbit.marketSell(`KRW-${coin}`, sellAmount);
    await logTrade(supabase, { coin, side: 'sell', coinAmount: sellAmount, priceKrw: currentPrice, reason, upbitOrderId: order.uuid });
    if (label) {
      await logProfitTake(supabase, { coin, level: label, avgBuyPrice: extra.avgBuyPrice ?? 0, triggerPrice: currentPrice, soldAmount: sellAmount, upbitOrderId: order.uuid });
    }
    return { ok: true, coin, reason, sellPct, soldAmount: sellAmount, orderId: order.uuid, ...extra };
  } catch (err) {
    return { ok: false, coin, reason, error: err.response?.data?.error?.message || err.message };
  }
}

// ─── Sell cycle ───────────────────────────────────────────────────────────────

async function runSells(supabase, config, accounts, priceMap, analysis) {
  const results = [];
  const soldThisCycle = new Set(); // track coins sold this cycle to prevent immediate re-buy
  const coins = config.coins || DEFAULT_COINS;

  for (const coin of coins) {
    const account = accounts.find((a) => a.currency === coin);
    if (!account) continue;
    const balance     = Number(account.balance);
    const avgBuyKrw   = Number(account.avg_buy_price);
    const currentPrice = priceMap[coin];
    if (balance <= 0 || !currentPrice) continue;

    const gainPct = avgBuyKrw > 0 ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;
    const sig     = analysis[coin];

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
      const atProfit = gainPct != null && gainPct > 0;

      // ── Signal stacking: count simultaneous sell conditions ───────────────────
      // When multiple indicators agree the asset is overbought, sell a larger slice.
      const sellConditions = [
        sig.rsi != null && sig.rsi > 70,
        sig.bb?.pctB > 1.0,
        sig.macd?.bearishCross,
        sig.stochRsi != null && sig.stochRsi > 85,
        sig.vwapDev != null && sig.vwapDev > 3,
        sig.williamsR != null && sig.williamsR > -15,
        sig.cci != null && sig.cci > 150,
        sig.kimchiPremium != null && sig.kimchiPremium > 4,
      ].filter(Boolean).length;

      // Scale factor: ≥5 signals → 1.8×, ≥3 → 1.35×, else 1×
      const stackFactor = sellConditions >= 5 ? 1.8 : sellConditions >= 3 ? 1.35 : 1;
      const scaleSell   = (base) => Math.min(Math.round(base * stackFactor), 40);

      // 2. RSI overbought
      if (sig.rsi != null && sig.rsi > 80 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'rsi_ob_strong', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(20), 'SIGNAL_RSI_OB_STRONG', 'rsi_ob_strong', { rsi: sig.rsi.toFixed(1) }));
      } else if (sig.rsi != null && sig.rsi > 70 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'rsi_ob', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(12), 'SIGNAL_RSI_OVERBOUGHT', 'rsi_ob', { rsi: sig.rsi.toFixed(1) }));
      }

      // 3. Bollinger upper breakout
      if (sig.bb?.pctB > 1.0 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'bb_upper', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(12), 'SIGNAL_BB_UPPER', 'bb_upper', { pctB: sig.bb.pctB.toFixed(2) }));
      }

      // 4. MACD bearish cross
      if (sig.macd?.bearishCross) {
        const done = await isRecentlySold(supabase, coin, 'macd_bear', 4);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(10), 'SIGNAL_MACD_BEAR', 'macd_bear'));
      }

      // 5. StochRSI overbought
      if (sig.stochRsi != null && sig.stochRsi > 85 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'stochrsi_ob', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(10), 'SIGNAL_STOCHRSI_OB', 'stochrsi_ob', { stochRsi: sig.stochRsi.toFixed(1) }));
      }

      // 6. VWAP deep above (price overextended above fair value)
      if (sig.vwapDev != null && sig.vwapDev > 3 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'vwap_above', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(12), 'SIGNAL_VWAP_ABOVE', 'vwap_above', { vwapDev: sig.vwapDev.toFixed(1) }));
      }

      // 7. Williams %R overbought
      if (sig.williamsR != null && sig.williamsR > -15 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'williams_ob', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(10), 'SIGNAL_WILLIAMS_OB', 'williams_ob', { wR: sig.williamsR.toFixed(1) }));
      }

      // 8. CCI overbought
      if (sig.cci != null && sig.cci > 150 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'cci_ob', 2);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(10), 'SIGNAL_CCI_OB', 'cci_ob', { cci: sig.cci.toFixed(0) }));
      }

      // 9. Kimchi premium extreme — Korean market overheated vs global price
      if (sig.kimchiPremium != null && sig.kimchiPremium > 4 && atProfit) {
        const done = await isRecentlySold(supabase, coin, 'kimchi_high', 4);
        if (!done) results.push(await sell(coin, balance, currentPrice, scaleSell(15), 'SIGNAL_KIMCHI_HIGH', 'kimchi_high', { kimchi: sig.kimchiPremium.toFixed(1) }));
      }

      if (sellConditions >= 3) {
        console.log(`[sell] ${coin} — ${sellConditions} simultaneous sell signals → stack factor ${stackFactor}×`);
      }
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
  totalPortfolioKrw = 0, portfolioWeights = {}, soldThisCycle = new Set(),
} = {}) {
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

  if (remaining < MIN_ORDER_KRW) {
    console.log(`[dip-buy] Deployable KRW too low (₩${Math.floor(remaining).toLocaleString()}) — cash reserve floor protecting ₩${Math.floor(cashReserveFloor).toLocaleString()}`);
    return results;
  }

  for (const coin of coins) {
    const sig = analysis[coin];
    if (!sig || sig.error) continue;

    // ── Anti-churn: never buy a coin we just sold this cycle or in last 2h ────
    if (soldThisCycle.has(coin)) {
      console.log(`[dip-buy] ${coin} sold this cycle — skipping to avoid churn`);
      continue;
    }
    const recentlySold = await isRecentlySoldAny(supabase, coin, 2);
    if (recentlySold) {
      console.log(`[dip-buy] ${coin} sold in last 2h — skipping to avoid fee churn`);
      continue;
    }

    // ── Score gate: require at least 2 confirmed buy signals ──────────────────
    const score = sig.scoreCombined ?? sig.score ?? 0;
    if (score < 2) continue;

    const pct = split[coin] ?? 0;
    if (pct <= 0) continue;

    // ── Portfolio weight awareness: don't pile into an already overweight coin ─
    const targetWeight   = pct; // e.g. 50 for BTC
    const currentWeight  = portfolioWeights[coin] ?? 0; // % of total portfolio
    const isOverweight   = totalPortfolioKrw > 0 && currentWeight > targetWeight * 1.3; // 30% over target
    if (isOverweight && score < 5) {
      console.log(`[dip-buy] ${coin} overweight (${currentWeight.toFixed(1)}% vs target ${targetWeight}%) — skipping unless strong signal`);
      continue;
    }

    // Base order amount from budget split; apply conviction multiplier
    const baseAmount  = Math.round(budget * pct / 100);
    const mult        = convictionMult(score) * (isOverweight ? 0.5 : 1); // halve if overweight
    const orderAmount = Math.min(Math.round(baseAmount * mult), remaining);

    if (orderAmount < MIN_ORDER_KRW || remaining < MIN_ORDER_KRW) continue;

    // ── Evaluate dip signals, highest conviction first ─────────────────────────
    const dipSignals = [
      sig.mom24 != null && sig.mom24 < -8        ? { reason: 'DIP_EMERGENCY_24H',  cooldown:  8 } : null,
      sig.rsi != null && sig.rsi < 25             ? { reason: 'DIP_RSI_EXTREME_OS', cooldown:  4 } : null,
      sig.bb?.pctB < 0                            ? { reason: 'DIP_BB_BELOW_LOWER', cooldown:  4 } : null,
      sig.vwapDev != null && sig.vwapDev < -3     ? { reason: 'DIP_VWAP_DEEP_BELOW',cooldown:  3 } : null,
      sig.williamsR != null && sig.williamsR < -90? { reason: 'DIP_WILLIAMS_DEEP_OS',cooldown: 3 } : null,
      sig.cci != null && sig.cci < -150           ? { reason: 'DIP_CCI_DEEP_OS',    cooldown:  4 } : null,
      sig.rsi != null && sig.rsi < 30             ? { reason: 'DIP_RSI_OVERSOLD',   cooldown:  4 } : null,
      sig.stochRsi != null && sig.stochRsi < 15   ? { reason: 'DIP_STOCHRSI_OS',    cooldown:  3 } : null,
      sig.macd?.bullishCross                      ? { reason: 'DIP_MACD_BULL_CROSS',cooldown:  6 } : null,
      sig.roc != null && sig.roc < -6             ? { reason: 'DIP_ROC_SHARP_DIP',  cooldown:  4 } : null,
    ].filter(Boolean);

    let executed = false;
    for (const { reason, cooldown } of dipSignals) {
      if (executed) break;
      const recent = await isRecentlyBought(supabase, coin, reason, cooldown);
      if (recent) continue;

      try {
        const order = await upbit.marketBuy(`KRW-${coin}`, orderAmount);
        await logTrade(supabase, {
          coin, side: 'buy', krwAmount: orderAmount,
          priceKrw: priceMap[coin] ?? null,
          reason, upbitOrderId: order.uuid,
          signalScore: score,
        });
        remaining -= orderAmount;
        results.push({ coin, ok: true, reason, krwAmount: orderAmount, rsi: sig.rsi?.toFixed(1), score, mult: mult.toFixed(2), orderId: order.uuid });
        executed = true;
      } catch (err) {
        results.push({ coin, ok: false, reason, error: err.response?.data?.error?.message || err.message });
        executed = true;
      }
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
      const order = await upbit.marketBuy(`KRW-${coin}`, krwAmount);
      await logTrade(supabase, {
        coin, side: 'buy', krwAmount,
        priceKrw: priceMap[coin] ?? null,
        reason:   budgetMultiplier !== 1 ? `DCA_${budgetMultiplier.toFixed(1)}x` : 'DCA',
        upbitOrderId: order.uuid, signalScore,
      });
      availableKrw -= krwAmount;
      results.push({ coin, ok: true, krwAmount, budgetMultiplier, allocPct: pct, orderId: order.uuid });
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

  // SELLS
  let soldThisCycle = new Set();
  if (!dipBuyOnly) {
    try {
      const sellResult = await runSells(supabase, config, accounts, priceMap, analysis);
      summary.sells  = sellResult.results;
      soldThisCycle  = sellResult.soldThisCycle;
    } catch (err) { summary.errors.push(`Sells error: ${err.message}`); }
  }

  // ── Dynamic DCA cadence — shorten interval when signals are bullish ───────────
  const avgCombinedScore = coins.reduce((s, c) => s + (analysis[c]?.scoreCombined ?? 0), 0) / Math.max(coins.length, 1);
  const cooldown         = dcaCooldownDays(avgCombinedScore);

  // DIP BUYS — skip coins sold this cycle or in the last 2h (anti-churn)
  if (config.dip_buy_enabled && (fearGreed?.value ?? 50) <= 75) {
    try {
      summary.dipBuys = await runDipBuys(supabase, config, priceMap, analysis, krwBalance, bear, {
        totalPortfolioKrw, portfolioWeights, soldThisCycle,
      });
    } catch (err) { summary.errors.push(`Dip buy error: ${err.message}`); }
  }

  // WEEKLY DCA (cadence shortens from 7→5→3 days based on signal strength)
  // Also skip coins sold this cycle to avoid immediate re-buy
  if (config.dca_enabled && !dipBuyOnly) {
    const lastRun       = config.last_dca_run ? new Date(config.last_dca_run) : null;
    const daysSinceLast = lastRun ? (Date.now() - lastRun.getTime()) / 86400000 : 999;
    if (forceDca || daysSinceLast >= cooldown) {
      console.log(`[DCA] Score avg ${avgCombinedScore.toFixed(1)} → cooldown ${cooldown}d (last run ${daysSinceLast.toFixed(1)}d ago)`);
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
      summary.skipped.push(`DCA in ${(cooldown - daysSinceLast).toFixed(1)}d (score avg ${avgCombinedScore.toFixed(1)})`);
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
