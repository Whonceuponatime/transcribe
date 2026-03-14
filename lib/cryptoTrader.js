/**
 * Crypto trading engine v3 — signal-driven, trades frequently.
 *
 * SELL triggers (every 5 min):
 *   1. Fixed profit-take  : +5/10/20/40% → sell 10/15/20/25%
 *   2. RSI overbought     : RSI > 70 → sell 12%, RSI > 80 → sell 20%
 *   3. Bollinger breakout : price > upper band → sell 12%
 *   4. MACD bear cross    : sell 10% (trend reversal)
 *   5. StochRSI overbought: > 85 → sell 10%
 *   6. Trailing stop      : -30% from 14d high while profitable → sell 40%
 *
 * BUY triggers (hourly dip check + weekly DCA):
 *   1. RSI < 30           : dip buy (from dip budget)
 *   2. BB below lower band: dip buy
 *   3. MACD bull cross    : dip buy
 *   4. 24h drop > 8%      : emergency dip buy
 *   5. Weekly DCA         : scheduled Monday buy (with F&G + macro gates)
 *
 * Gates:
 *   - Kill switch checked before every cycle
 *   - Fear & Greed > 75: skip all buys
 *   - Macro score < min_signal_score: skip DCA
 *   - Bear market (BTC -30% from 90d high): halve budgets
 *   - KRW balance check before any buy
 */

const upbit = require('./upbit');
const axios = require('axios');
const { compositeSignal, rsi, bollinger, macd, stochRsi } = require('./indicators');

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL'];
const DEFAULT_SPLIT = { BTC: 50, ETH: 30, SOL: 20 };
const DEFAULT_WEEKLY_BUDGET = 100000;
const DEFAULT_DIP_BUDGET = 100000; // separate weekly dip-buy reserve
const MIN_ORDER_KRW = 5000;
const TRAILING_STOP_SELL_PCT = 40;
const TRAILING_WINDOW_DAYS = 14;

// Fixed profit-take tiers
const PROFIT_LEVELS = [
  { gainThreshold: 5,  label: '5pct',  sellPct: 10 },
  { gainThreshold: 10, label: '10pct', sellPct: 15 },
  { gainThreshold: 20, label: '20pct', sellPct: 20 },
  { gainThreshold: 40, label: '40pct', sellPct: 25 },
];

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getConfig(supabase) {
  const { data } = await supabase
    .from('crypto_trader_config').select('*')
    .order('created_at', { ascending: false }).limit(1).single();
  return {
    dca_enabled:             data?.dca_enabled ?? true,
    weekly_budget_krw:       Number(data?.weekly_budget_krw ?? DEFAULT_WEEKLY_BUDGET),
    dip_buy_enabled:         data?.dip_buy_enabled ?? true,
    dip_budget_krw:          Number(data?.dip_budget_krw ?? DEFAULT_DIP_BUDGET),
    coins:                   data?.coins ?? DEFAULT_COINS,
    split:                   data?.split ?? DEFAULT_SPLIT,
    profit_take_enabled:     data?.profit_take_enabled ?? true,
    signal_sell_enabled:     data?.signal_sell_enabled ?? true,
    signal_buy_enabled:      data?.signal_buy_enabled ?? true,
    signal_boost_enabled:    data?.signal_boost_enabled ?? true,
    fear_greed_gate_enabled: data?.fear_greed_gate_enabled ?? true,
    trailing_stop_enabled:   data?.trailing_stop_enabled ?? true,
    trailing_stop_pct:       Number(data?.trailing_stop_pct ?? 30),
    bear_market_pause_enabled: data?.bear_market_pause_enabled ?? true,
    min_signal_score:        Number(data?.min_signal_score ?? 0),
    last_dca_run:            data?.last_dca_run ?? null,
    last_dip_run:            data?.last_dip_run ?? null,
    id:                      data?.id ?? null,
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
    krw_amount: trade.krwAmount ?? null,
    coin_amount: trade.coinAmount ?? null,
    price_krw: trade.priceKrw ?? null,
    reason: trade.reason,
    upbit_order_id: trade.upbitOrderId ?? null,
    signal_score: trade.signalScore ?? null,
    executed_at: new Date().toISOString(),
  });
}

async function logProfitTake(supabase, entry) {
  await supabase.from('crypto_profit_take_log').insert({
    coin: entry.coin, level: entry.level,
    avg_buy_price_krw: entry.avgBuyPrice,
    trigger_price_krw: entry.triggerPrice,
    sold_amount: entry.soldAmount,
    upbit_order_id: entry.upbitOrderId ?? null,
    triggered_at: new Date().toISOString(),
  });
}

async function isRecentlySold(supabase, coin, level, cooldownHours = 72) {
  const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabase.from('crypto_profit_take_log')
    .select('id').eq('coin', coin).eq('level', level).gte('triggered_at', since).limit(1);
  return (data || []).length > 0;
}

async function isRecentlyBought(supabase, coin, reason, cooldownHours = 12) {
  const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
  const { data } = await supabase.from('crypto_trade_log')
    .select('id').eq('coin', coin).eq('side', 'buy').eq('reason', reason)
    .gte('executed_at', since).limit(1);
  return (data || []).length > 0;
}

async function getLatestSignalScore(supabase) {
  const { data } = await supabase.from('fx_signal_runs')
    .select('score, decision').order('created_at', { ascending: false }).limit(1).single();
  return { score: data?.score ?? null, decision: data?.decision ?? null };
}

// ─── External data ────────────────────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 });
    const d = res.data?.data?.[0];
    return d ? { value: Number(d.value), label: d.value_classification } : null;
  } catch (_) { return null; }
}

// ─── Price highs tracking ─────────────────────────────────────────────────────

async function getPriceHighs(supabase) {
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'crypto_price_highs').single();
  return data?.value ?? {};
}

async function updatePriceHighs(supabase, priceMap, coins) {
  const highs = await getPriceHighs(supabase);
  const cutoff = Date.now() - TRAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
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

// ─── Technical analysis per coin ─────────────────────────────────────────────

async function analyzeCoins(coins) {
  const results = {};
  await Promise.all(coins.map(async (coin) => {
    try {
      const data = await upbit.getCandleData(`KRW-${coin}`);
      const sig = compositeSignal(data.closes4h, data.volumes4h, data.candles4h);
      // Also run on daily for longer-term context
      const dailySig = compositeSignal(data.closes1d, data.volumes1d, data.candles1d);
      results[coin] = {
        ...sig,
        dailyScore: dailySig.score,
        dailyRsi: dailySig.rsi,
        closes4h: data.closes4h,
        closes1d: data.closes1d,
      };
    } catch (err) {
      results[coin] = { error: err.message, score: 0, signals: [] };
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

// ─── Sell cycle (profit-take + signal sells + trailing stop) ─────────────────

async function runSells(supabase, config, accounts, priceMap, analysis) {
  const results = [];
  const coins = config.coins || DEFAULT_COINS;

  for (const coin of coins) {
    const account = accounts.find((a) => a.currency === coin);
    if (!account) continue;
    const balance = Number(account.balance);
    const avgBuyKrw = Number(account.avg_buy_price);
    const currentPrice = priceMap[coin];
    if (balance <= 0 || !currentPrice) continue;

    const gainPct = avgBuyKrw > 0 ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;
    const sig = analysis[coin];

    // 1. Fixed profit-take tiers
    if (config.profit_take_enabled && gainPct != null) {
      for (const level of PROFIT_LEVELS) {
        if (gainPct >= level.gainThreshold) {
          const done = await isRecentlySold(supabase, coin, level.label, 72);
          if (!done) {
            const r = await sellCoin(supabase, coin, balance, currentPrice, level.sellPct,
              `PROFIT_TAKE_${level.label.toUpperCase()}`, level.label, { gainPct: gainPct.toFixed(1), avgBuyPrice: avgBuyKrw });
            results.push(r);
          }
        }
      }
    }

    // 2. RSI overbought sell
    if (config.signal_sell_enabled && sig && gainPct != null && gainPct > 0) {
      if (sig.rsi != null && sig.rsi > 80) {
        const done = await isRecentlySold(supabase, coin, 'rsi_ob_strong', 6);
        if (!done) {
          const r = await sellCoin(supabase, coin, balance, currentPrice, 20, 'SIGNAL_RSI_OB_STRONG', 'rsi_ob_strong', { rsi: sig.rsi.toFixed(1) });
          results.push(r);
        }
      } else if (sig.rsi != null && sig.rsi > 70) {
        const done = await isRecentlySold(supabase, coin, 'rsi_ob', 4);
        if (!done) {
          const r = await sellCoin(supabase, coin, balance, currentPrice, 12, 'SIGNAL_RSI_OVERBOUGHT', 'rsi_ob', { rsi: sig.rsi.toFixed(1) });
          results.push(r);
        }
      }

      // 3. Bollinger upper band breakout
      if (sig.bb && sig.bb.pctB > 1.0) {
        const done = await isRecentlySold(supabase, coin, 'bb_upper', 4);
        if (!done) {
          const r = await sellCoin(supabase, coin, balance, currentPrice, 12, 'SIGNAL_BB_UPPER', 'bb_upper', { pctB: sig.bb.pctB.toFixed(2) });
          results.push(r);
        }
      }

      // 4. MACD bearish cross
      if (sig.macd?.bearishCross) {
        const done = await isRecentlySold(supabase, coin, 'macd_bear', 8);
        if (!done) {
          const r = await sellCoin(supabase, coin, balance, currentPrice, 10, 'SIGNAL_MACD_BEAR', 'macd_bear');
          results.push(r);
        }
      }

      // 5. Stochastic RSI overbought
      if (sig.stochRsi != null && sig.stochRsi > 85) {
        const done = await isRecentlySold(supabase, coin, 'stochrsi_ob', 4);
        if (!done) {
          const r = await sellCoin(supabase, coin, balance, currentPrice, 10, 'SIGNAL_STOCHRSI_OB', 'stochrsi_ob', { stochRsi: sig.stochRsi.toFixed(1) });
          results.push(r);
        }
      }
    }

    // 6. Trailing stop
    if (config.trailing_stop_enabled && gainPct != null && gainPct > 0) {
      const { data: hsData } = await supabase.from('app_settings').select('value').eq('key', 'crypto_price_highs').single();
      const highData = hsData?.value?.[coin];
      if (highData) {
        const dropFromHigh = (highData.high - currentPrice) / highData.high * 100;
        if (dropFromHigh >= config.trailing_stop_pct) {
          const done = await isRecentlySold(supabase, coin, 'trailing_stop', 30 * 24);
          if (!done) {
            const r = await sellCoin(supabase, coin, balance, currentPrice, TRAILING_STOP_SELL_PCT, 'TRAILING_STOP', 'trailing_stop',
              { dropFromHigh: dropFromHigh.toFixed(1), avgBuyPrice: avgBuyKrw });
            results.push(r);
          }
        }
      }
    }
  }
  return results;
}

// ─── Dip buy cycle ────────────────────────────────────────────────────────────

async function runDipBuys(supabase, config, priceMap, analysis, availableKrw, bear) {
  const results = [];
  if (!config.dip_buy_enabled) return results;

  const coins = config.coins || DEFAULT_COINS;
  const split = config.split || DEFAULT_SPLIT;
  let budget = Math.round(config.dip_budget_krw * (bear ? 0.5 : 1));
  let remaining = Math.min(availableKrw * 0.95, budget);

  for (const coin of coins) {
    const sig = analysis[coin];
    if (!sig || sig.error) continue;

    const pct = split[coin] ?? 0;
    if (pct <= 0) continue;
    const dipAmount = Math.round(budget * pct / 100);
    if (dipAmount < MIN_ORDER_KRW || remaining < MIN_ORDER_KRW) continue;
    const orderAmount = Math.min(dipAmount, remaining);

    let dipReason = null;

    // Strongest signal first
    if (sig.rsi != null && sig.rsi < 25) {
      dipReason = 'DIP_RSI_STRONG_OS'; // strong oversold
    } else if (sig.bb?.pctB < 0) {
      dipReason = 'DIP_BB_BELOW_LOWER'; // below lower Bollinger
    } else if (sig.rsi != null && sig.rsi < 30) {
      dipReason = 'DIP_RSI_OVERSOLD';
    } else if (sig.macd?.bullishCross) {
      dipReason = 'DIP_MACD_BULL_CROSS';
    } else if (sig.stochRsi != null && sig.stochRsi < 15) {
      dipReason = 'DIP_STOCHRSI_OS';
    }

    if (!dipReason) continue;

    // Cooldown: don't dip-buy the same coin/reason twice within 12h
    const recentBuy = await isRecentlyBought(supabase, coin, dipReason, 12);
    if (recentBuy) continue;

    try {
      const order = await upbit.marketBuy(`KRW-${coin}`, orderAmount);
      await logTrade(supabase, {
        coin, side: 'buy', krwAmount: orderAmount,
        priceKrw: priceMap[coin] ?? null,
        reason: dipReason,
        upbitOrderId: order.uuid,
        signalScore: sig.score,
      });
      remaining -= orderAmount;
      results.push({ coin, ok: true, reason: dipReason, krwAmount: orderAmount, rsi: sig.rsi?.toFixed(1), orderId: order.uuid });
    } catch (err) {
      results.push({ coin, ok: false, reason: dipReason, error: err.response?.data?.error?.message || err.message });
    }
  }

  if (results.some((r) => r.ok)) {
    await saveConfig(supabase, { last_dip_run: new Date().toISOString() });
  }
  return results;
}

// ─── Weekly DCA ───────────────────────────────────────────────────────────────

async function runDca(supabase, config, signalScore, fearGreed, priceMap, bear, accounts) {
  const results = [];

  // Gates
  if (fearGreed?.value > 75) return [{ skipped: true, reason: `Extreme Greed (F&G ${fearGreed.value}) — skipping DCA` }];
  if (signalScore !== null && signalScore < config.min_signal_score) return [{ skipped: true, reason: `Macro score ${signalScore} below minimum` }];

  let budgetMultiplier = 1;
  if (fearGreed?.value < 25) budgetMultiplier *= 2;
  if (config.signal_boost_enabled && signalScore >= 5) budgetMultiplier *= 1.5;
  if (bear) budgetMultiplier *= 0.5;

  const budget = Math.round(config.weekly_budget_krw * budgetMultiplier);
  const coins = config.coins || DEFAULT_COINS;
  const split = config.split || DEFAULT_SPLIT;

  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  let availableKrw = Number(krwAccount?.balance ?? 0);

  if (availableKrw < MIN_ORDER_KRW) return [{ skipped: true, reason: `Insufficient KRW (₩${Math.floor(availableKrw).toLocaleString()})` }];

  for (const coin of coins) {
    const pct = split[coin] ?? 0;
    if (pct <= 0) continue;
    const krwAmount = Math.min(Math.round(budget * pct / 100), Math.floor(availableKrw * 0.99));
    if (krwAmount < MIN_ORDER_KRW) {
      results.push({ coin, skipped: true, reason: 'Below minimum or insufficient KRW' }); continue;
    }
    try {
      const order = await upbit.marketBuy(`KRW-${coin}`, krwAmount);
      await logTrade(supabase, {
        coin, side: 'buy', krwAmount,
        priceKrw: priceMap[coin] ?? null,
        reason: budgetMultiplier !== 1 ? `DCA_${budgetMultiplier.toFixed(1)}x` : 'DCA',
        upbitOrderId: order.uuid, signalScore,
      });
      availableKrw -= krwAmount;
      results.push({ coin, ok: true, krwAmount, budgetMultiplier, orderId: order.uuid });
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
  const coins = config.coins || DEFAULT_COINS;

  // Get prices + indicators in parallel
  const [accounts, tickers, fearGreed, { score: signalScore }] = await Promise.all([
    upbit.getAccounts().catch(() => []),
    upbit.getTicker(coins.map((c) => `KRW-${c}`)).catch(() => []),
    fetchFearGreed(),
    getLatestSignalScore(supabase),
  ]);

  const priceMap = {};
  for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

  // Technical analysis for all coins
  const analysis = await analyzeCoins(coins).catch(() => ({}));

  // Update rolling price highs
  const priceHighs = await updatePriceHighs(supabase, priceMap, coins).catch(() => ({}));

  // Bear market check
  const bear = config.bear_market_pause_enabled
    ? await isBearMarket(supabase, priceMap.BTC).catch(() => false)
    : false;

  // SELLS (runs every cycle — profit-take, signals, trailing stop)
  if (!dipBuyOnly) {
    try { summary.sells = await runSells(supabase, config, accounts, priceMap, analysis); }
    catch (err) { summary.errors.push(`Sells error: ${err.message}`); }
  }

  // DIP BUYS (hourly)
  if (config.dip_buy_enabled && fearGreed?.value <= 75) {
    try {
      const krwAccount = accounts.find((a) => a.currency === 'KRW');
      const availableKrw = Number(krwAccount?.balance ?? 0);
      summary.dipBuys = await runDipBuys(supabase, config, priceMap, analysis, availableKrw, bear);
    } catch (err) { summary.errors.push(`Dip buy error: ${err.message}`); }
  }

  // WEEKLY DCA
  if (config.dca_enabled && !dipBuyOnly) {
    const lastRun = config.last_dca_run ? new Date(config.last_dca_run) : null;
    const daysSinceLast = lastRun ? (Date.now() - lastRun.getTime()) / 86400000 : 999;
    if (forceDca || daysSinceLast >= 6) {
      try {
        const freshAccounts = await upbit.getAccounts().catch(() => accounts);
        summary.dca = await runDca(supabase, config, signalScore, fearGreed, priceMap, bear, freshAccounts);
      } catch (err) { summary.errors.push(`DCA error: ${err.message}`); }
    } else {
      summary.skipped.push(`DCA in ${(6 - daysSinceLast).toFixed(1)}d`);
    }
  }

  // Store indicators + F&G for dashboard
  await supabase.from('app_settings').upsert(
    { key: 'coin_indicators', value: Object.fromEntries(Object.entries(analysis).map(([coin, sig]) => [coin, {
      rsi: sig.rsi?.toFixed(1), stochRsi: sig.stochRsi?.toFixed(1),
      bb_pctB: sig.bb?.pctB?.toFixed(2), macdBull: sig.macd?.bullishCross, macdBear: sig.macd?.bearishCross,
      score: sig.score, signals: sig.signals?.map((s) => s.name),
    }])), updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  ).catch(() => {});

  if (fearGreed) {
    await supabase.from('app_settings').upsert(
      { key: 'fear_greed', value: { ...fearGreed, fetchedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    ).catch(() => {});
  }

  return summary;
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function getStatus(supabase) {
  const [config, accounts, { score: signalScore, decision }] = await Promise.all([
    getConfig(supabase),
    upbit.getAccounts().catch(() => []),
    getLatestSignalScore(supabase),
  ]);

  const coins = config.coins || DEFAULT_COINS;
  const tickers = await upbit.getTicker(coins.map((c) => `KRW-${c}`)).catch(() => []);
  const priceMap = {};
  for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

  const priceHighs = await getPriceHighs(supabase);
  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  const krwBalance = Number(krwAccount?.balance ?? 0);

  const { data: indData } = await supabase.from('app_settings').select('value').eq('key', 'coin_indicators').single();
  const indicators = indData?.value ?? {};

  const positions = coins.map((coin) => {
    const acc = accounts.find((a) => a.currency === coin);
    const balance = Number(acc?.balance ?? 0);
    const avgBuyKrw = Number(acc?.avg_buy_price ?? 0);
    const currentPrice = priceMap[coin] ?? null;
    const currentValueKrw = currentPrice ? balance * currentPrice : null;
    const gainPct = avgBuyKrw > 0 && currentPrice ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;
    const high14d = priceHighs[coin]?.high ?? null;
    const dropFromHigh = high14d && currentPrice ? (high14d - currentPrice) / high14d * 100 : null;
    const ind = indicators[coin] ?? {};
    const nextProfitTake = gainPct != null ? PROFIT_LEVELS.find((l) => gainPct < l.gainThreshold) ?? null : null;
    return {
      coin, balance, avgBuyKrw, currentPrice, currentValueKrw, gainPct, high14d, dropFromHigh,
      indicators: ind,
      nextProfitTakeLevel: nextProfitTake ? `+${nextProfitTake.gainThreshold}% (sell ${nextProfitTake.sellPct}%)` : gainPct != null ? 'All levels passed' : null,
    };
  });

  const { data: recentTrades } = await supabase.from('crypto_trade_log')
    .select('*').order('executed_at', { ascending: false }).limit(30);
  const { data: fgData } = await supabase.from('app_settings').select('value').eq('key', 'fear_greed').single();

  return { config, krwBalance, positions, signalScore, signalDecision: decision, recentTrades: recentTrades || [], fearGreed: fgData?.value ?? null, indicators };
}

module.exports = { executeCycle, getStatus, getConfig, saveConfig };
