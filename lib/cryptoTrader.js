/**
 * Crypto trading engine — profit-focused upgrades:
 *
 *  1. Fear & Greed gate   — skip DCA on extreme greed (>75), 2× on extreme fear (<25)
 *  2. Macro score gate    — skip DCA if macro score < min_signal_score (default 0)
 *  3. Bear market pause   — halve DCA budget if BTC is >30% below its 90-day high
 *  4. Trailing stop       — sell 40% if price drops 30% from 14-day high while profitable
 *  5. Smarter profit-take — tiered sells: 15% at +50%, 25% at +100%, 35% at +200%, 40% at +300%
 *  6. Signal boost        — 50% extra spend when macro score ≥ 5
 */

const upbit = require('./upbit');
const axios = require('axios');

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL'];
const DEFAULT_SPLIT = { BTC: 50, ETH: 30, SOL: 20 };
const DEFAULT_WEEKLY_BUDGET = 100000;
const MIN_ORDER_KRW = 5000;

// Profit-take levels: { multiplier for gain, DB label, % of holdings to sell }
const PROFIT_LEVELS = [
  { mult: 1.5,  label: '50pct',  sellPct: 15 },
  { mult: 2.0,  label: '100pct', sellPct: 25 },
  { mult: 3.0,  label: '200pct', sellPct: 35 },
  { mult: 4.0,  label: '300pct', sellPct: 40 },
];

// Trailing stop: sell 40% when price drops this far from 14-day high (while profitable)
const TRAILING_STOP_DEFAULT_PCT = 30;
const TRAILING_STOP_SELL_PCT    = 40;
const TRAILING_WINDOW_DAYS      = 14;

// ─── External data ────────────────────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 });
    const d = res.data?.data?.[0];
    if (!d) return null;
    return { value: Number(d.value), label: d.value_classification };
  } catch (_) {
    return null;
  }
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getConfig(supabase) {
  const { data } = await supabase
    .from('crypto_trader_config')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return {
    dca_enabled:            data?.dca_enabled ?? true,
    weekly_budget_krw:      Number(data?.weekly_budget_krw ?? DEFAULT_WEEKLY_BUDGET),
    coins:                  data?.coins ?? DEFAULT_COINS,
    split:                  data?.split ?? DEFAULT_SPLIT,
    profit_take_enabled:    data?.profit_take_enabled ?? true,
    signal_boost_enabled:   data?.signal_boost_enabled ?? true,
    fear_greed_gate_enabled:data?.fear_greed_gate_enabled ?? true,
    trailing_stop_enabled:  data?.trailing_stop_enabled ?? true,
    trailing_stop_pct:      Number(data?.trailing_stop_pct ?? TRAILING_STOP_DEFAULT_PCT),
    bear_market_pause_enabled: data?.bear_market_pause_enabled ?? true,
    min_signal_score:       Number(data?.min_signal_score ?? 0),
    last_dca_run:           data?.last_dca_run ?? null,
    id:                     data?.id ?? null,
  };
}

async function saveConfig(supabase, updates) {
  const current = await getConfig(supabase);
  if (current.id) {
    await supabase.from('crypto_trader_config')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', current.id);
  } else {
    await supabase.from('crypto_trader_config').insert({ ...updates });
  }
}

async function logTrade(supabase, trade) {
  await supabase.from('crypto_trade_log').insert({
    coin:          trade.coin,
    side:          trade.side,
    krw_amount:    trade.krwAmount ?? null,
    coin_amount:   trade.coinAmount ?? null,
    price_krw:     trade.priceKrw ?? null,
    reason:        trade.reason,
    upbit_order_id:trade.upbitOrderId ?? null,
    signal_score:  trade.signalScore ?? null,
    executed_at:   new Date().toISOString(),
  });
}

async function logProfitTake(supabase, entry) {
  await supabase.from('crypto_profit_take_log').insert({
    coin:             entry.coin,
    level:            entry.level,
    avg_buy_price_krw:entry.avgBuyPrice,
    trigger_price_krw:entry.triggerPrice,
    sold_amount:      entry.soldAmount,
    upbit_order_id:   entry.upbitOrderId ?? null,
    triggered_at:     new Date().toISOString(),
  });
}

async function isProfitTakeTriggered(supabase, coin, level, cooldownDays = 60) {
  const since = new Date();
  since.setDate(since.getDate() - cooldownDays);
  const { data } = await supabase
    .from('crypto_profit_take_log')
    .select('id')
    .eq('coin', coin)
    .eq('level', level)
    .gte('triggered_at', since.toISOString())
    .limit(1);
  return (data || []).length > 0;
}

async function getLatestSignalScore(supabase) {
  const { data } = await supabase
    .from('fx_signal_runs')
    .select('score, decision')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return { score: data?.score ?? null, decision: data?.decision ?? null };
}

// ─── Rolling 14-day price highs (stored in app_settings) ─────────────────────

async function getPriceHighs(supabase) {
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'crypto_price_highs')
    .single();
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
    const expiredOrMissing = !existing || new Date(existing.recordedAt).getTime() < cutoff;

    if (expiredOrMissing || price > (existing?.high ?? 0)) {
      updated[coin] = { high: price, recordedAt: new Date().toISOString() };
    }
  }

  await supabase.from('app_settings').upsert(
    { key: 'crypto_price_highs', value: updated, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  return updated;
}

// ─── Bear market check: BTC 90-day high ──────────────────────────────────────

async function isBearMarket(supabase, btcPriceKrw) {
  if (!btcPriceKrw) return false;
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'btc_90d_high')
    .single();

  const stored = data?.value;
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

  let high90d = stored?.high ?? 0;
  const storedAt = stored?.recordedAt ? new Date(stored.recordedAt).getTime() : 0;

  // Update 90d high if current price exceeds it
  if (btcPriceKrw > high90d || storedAt < cutoff) {
    if (btcPriceKrw > high90d) {
      high90d = btcPriceKrw;
      await supabase.from('app_settings').upsert(
        { key: 'btc_90d_high', value: { high: high90d, recordedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    }
  }

  if (high90d === 0) return false;
  const drawdown = (high90d - btcPriceKrw) / high90d * 100;
  return drawdown >= 30; // BTC down 30%+ from 90d high = bear market
}

// ─── DCA intelligence gate ────────────────────────────────────────────────────

async function evaluateDcaConditions(supabase, config, signalScore, fearGreed, priceMap) {
  const reasons = [];
  let budgetMultiplier = 1;

  // Macro score gate
  if (signalScore !== null && signalScore < config.min_signal_score) {
    return { allow: false, reason: `Macro score ${signalScore} below minimum ${config.min_signal_score} — DCA paused`, budgetMultiplier: 0 };
  }

  // Fear & Greed gate
  if (config.fear_greed_gate_enabled && fearGreed !== null) {
    if (fearGreed.value > 75) {
      return { allow: false, reason: `Extreme Greed (F&G ${fearGreed.value}) — waiting for better entry`, budgetMultiplier: 0 };
    }
    if (fearGreed.value < 25) {
      budgetMultiplier *= 2;
      reasons.push(`Extreme Fear (F&G ${fearGreed.value}) — doubling DCA`);
    }
  }

  // Signal boost: macro score >= 5 → +50%
  if (config.signal_boost_enabled && signalScore !== null && signalScore >= 5) {
    budgetMultiplier *= 1.5;
    reasons.push(`Signal boost (score ${signalScore})`);
  }

  // Bear market pause: halve budget if BTC down 30%+ from 90d high
  if (config.bear_market_pause_enabled && priceMap.BTC) {
    const bear = await isBearMarket(supabase, priceMap.BTC);
    if (bear) {
      budgetMultiplier *= 0.5;
      reasons.push('Bear market detected — halving DCA budget');
    }
  }

  return { allow: true, budgetMultiplier, reason: reasons.join('; ') || 'Normal conditions' };
}

// ─── DCA execution ────────────────────────────────────────────────────────────

async function runDca(supabase, config, signalScore, fearGreed, priceMap) {
  const results = [];
  const { allow, budgetMultiplier, reason } = await evaluateDcaConditions(supabase, config, signalScore, fearGreed, priceMap);

  if (!allow) {
    results.push({ skipped: true, reason });
    return results;
  }

  const budget = Math.round(config.weekly_budget_krw * budgetMultiplier);
  const coins = config.coins || DEFAULT_COINS;
  const split = config.split || DEFAULT_SPLIT;

  // Check available KRW balance before buying anything
  const accounts = await upbit.getAccounts();
  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  let availableKrw = Number(krwAccount?.balance ?? 0);

  if (availableKrw < MIN_ORDER_KRW) {
    results.push({ skipped: true, reason: `Insufficient KRW balance (₩${Math.floor(availableKrw).toLocaleString()})` });
    return results;
  }

  for (const coin of coins) {
    const pct = split[coin] ?? 0;
    if (pct <= 0) continue;

    const krwAmount = Math.min(Math.round(budget * pct / 100), Math.floor(availableKrw * 0.99));
    if (krwAmount < MIN_ORDER_KRW) {
      results.push({ coin, krwAmount, skipped: true, reason: `Below minimum or insufficient KRW (available ₩${Math.floor(availableKrw).toLocaleString()})` });
      continue;
    }

    const market = `KRW-${coin}`;
    try {
      const order = await upbit.marketBuy(market, krwAmount);
      const tradeReason = budgetMultiplier !== 1
        ? `DCA_ADJUSTED_${budgetMultiplier.toFixed(1)}x`
        : 'DCA';
      await logTrade(supabase, {
        coin, side: 'buy', krwAmount,
        priceKrw: priceMap[coin] ?? null,
        reason: tradeReason,
        upbitOrderId: order.uuid,
        signalScore,
      });
      availableKrw -= krwAmount; // track remaining balance
      results.push({ coin, krwAmount, budget, budgetMultiplier, reason, orderId: order.uuid, ok: true });
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      results.push({ coin, krwAmount, ok: false, error: errMsg });
    }
  }

  await saveConfig(supabase, { last_dca_run: new Date().toISOString() });
  return results;
}

// ─── Trailing stop ────────────────────────────────────────────────────────────

async function runTrailingStop(supabase, config, accounts, priceMap, priceHighs) {
  const results = [];
  if (!config.trailing_stop_enabled) return results;

  const coins = config.coins || DEFAULT_COINS;
  const stopPct = config.trailing_stop_pct ?? TRAILING_STOP_DEFAULT_PCT;

  for (const coin of coins) {
    const account = accounts.find((a) => a.currency === coin);
    if (!account) continue;

    const balance = Number(account.balance);
    const avgBuyKrw = Number(account.avg_buy_price);
    const currentPrice = priceMap[coin];
    const highData = priceHighs[coin];

    if (balance <= 0 || avgBuyKrw <= 0 || !currentPrice || !highData) continue;

    // Only trigger trailing stop if position is profitable
    if (currentPrice <= avgBuyKrw) continue;

    const high14d = highData.high;
    const dropFromHigh = (high14d - currentPrice) / high14d * 100;

    if (dropFromHigh < stopPct) continue;

    // Check cooldown: don't fire trailing stop more than once per 30 days per coin
    const { data: recentStop } = await supabase
      .from('crypto_profit_take_log')
      .select('id')
      .eq('coin', coin)
      .eq('level', 'trailing_stop')
      .gte('triggered_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if ((recentStop || []).length > 0) continue;

    const sellAmount = Math.floor(balance * (TRAILING_STOP_SELL_PCT / 100) * 1e8) / 1e8;
    if (sellAmount * currentPrice < MIN_ORDER_KRW) continue;

    try {
      const order = await upbit.marketSell(`KRW-${coin}`, sellAmount);
      await logTrade(supabase, {
        coin, side: 'sell',
        coinAmount: sellAmount,
        priceKrw: currentPrice,
        reason: 'TRAILING_STOP',
        upbitOrderId: order.uuid,
      });
      // Log as profit_take_log with special level so cooldown works
      await supabase.from('crypto_profit_take_log').insert({
        coin, level: 'trailing_stop',
        avg_buy_price_krw: avgBuyKrw,
        trigger_price_krw: currentPrice,
        sold_amount: sellAmount,
        upbit_order_id: order.uuid,
        triggered_at: new Date().toISOString(),
      });
      results.push({
        coin, ok: true, type: 'trailing_stop',
        dropFromHigh: dropFromHigh.toFixed(1),
        sellAmount, orderId: order.uuid,
      });
    } catch (err) {
      results.push({ coin, ok: false, type: 'trailing_stop', error: err.response?.data?.error?.message || err.message });
    }
  }
  return results;
}

// ─── Profit-take ──────────────────────────────────────────────────────────────

async function runProfitTake(supabase, config, accounts, priceMap) {
  const results = [];
  const coins = config.coins || DEFAULT_COINS;

  for (const coin of coins) {
    const account = accounts.find((a) => a.currency === coin);
    if (!account) continue;

    const balance = Number(account.balance);
    const avgBuyPrice = Number(account.avg_buy_price);
    const currentPrice = priceMap[coin];

    if (balance <= 0 || avgBuyPrice <= 0 || currentPrice == null) continue;

    const gainPct = (currentPrice - avgBuyPrice) / avgBuyPrice * 100;

    for (const level of PROFIT_LEVELS) {
      if (gainPct < (level.mult - 1) * 100) continue;

      const alreadyTriggered = await isProfitTakeTriggered(supabase, coin, level.label);
      if (alreadyTriggered) continue;

      const sellAmount = Math.floor(balance * (level.sellPct / 100) * 1e8) / 1e8;
      if (sellAmount * currentPrice < MIN_ORDER_KRW) {
        results.push({ coin, level: level.label, skipped: true, reason: 'Sell value below minimum' });
        continue;
      }

      try {
        const order = await upbit.marketSell(`KRW-${coin}`, sellAmount);
        await logTrade(supabase, {
          coin, side: 'sell',
          coinAmount: sellAmount,
          priceKrw: currentPrice,
          reason: `PROFIT_TAKE_${level.label.toUpperCase()}`,
          upbitOrderId: order.uuid,
        });
        await logProfitTake(supabase, {
          coin, level: level.label,
          avgBuyPrice, triggerPrice: currentPrice,
          soldAmount: sellAmount,
          upbitOrderId: order.uuid,
        });
        results.push({
          coin, level: level.label, ok: true,
          gainPct: gainPct.toFixed(1),
          soldPct: level.sellPct,
          soldAmount: sellAmount,
          orderId: order.uuid,
        });
      } catch (err) {
        results.push({ coin, level: level.label, ok: false, error: err.response?.data?.error?.message || err.message });
      }
    }
  }
  return results;
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function executeCycle(supabase, { forceDca = false } = {}) {
  const summary = { dca: [], profitTake: [], trailingStop: [], skipped: [], errors: [] };

  // Kill switch
  const { data: ks } = await supabase.from('app_settings').select('value').eq('key', 'kill_switch').single();
  if (ks?.value?.enabled) {
    summary.skipped.push('Kill switch is active');
    return summary;
  }

  const config = await getConfig(supabase);
  const { score: signalScore } = await getLatestSignalScore(supabase);
  const fearGreed = await fetchFearGreed();

  // Get current prices for all coins
  const coins = config.coins || DEFAULT_COINS;
  const markets = coins.map((c) => `KRW-${c}`);
  const tickers = markets.length ? await upbit.getTicker(markets).catch(() => []) : [];
  const priceMap = {};
  for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

  // Update rolling 14d highs
  const priceHighs = await updatePriceHighs(supabase, priceMap, coins).catch(() => ({}));

  // Get account balances
  const accounts = await upbit.getAccounts().catch(() => []);

  // 1. Profit-take (always runs)
  if (config.profit_take_enabled) {
    try {
      summary.profitTake = await runProfitTake(supabase, config, accounts, priceMap);
    } catch (err) { summary.errors.push(`Profit-take error: ${err.message}`); }
  }

  // 2. Trailing stop (always runs)
  if (config.trailing_stop_enabled) {
    try {
      summary.trailingStop = await runTrailingStop(supabase, config, accounts, priceMap, priceHighs);
    } catch (err) { summary.errors.push(`Trailing stop error: ${err.message}`); }
  }

  // 3. DCA (weekly timing or forced)
  if (config.dca_enabled) {
    const lastRun = config.last_dca_run ? new Date(config.last_dca_run) : null;
    const daysSinceLast = lastRun ? (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24) : 999;

    if (forceDca || daysSinceLast >= 6) {
      try {
        summary.dca = await runDca(supabase, config, signalScore, fearGreed, priceMap);
      } catch (err) { summary.errors.push(`DCA error: ${err.message}`); }
    } else {
      summary.skipped.push(`DCA ran ${daysSinceLast.toFixed(1)}d ago (next in ${(6 - daysSinceLast).toFixed(1)}d)`);
    }
  }

  // Store F&G for dashboard
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
  const markets = coins.map((c) => `KRW-${c}`);
  const tickers = markets.length ? await upbit.getTicker(markets).catch(() => []) : [];
  const priceMap = {};
  for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

  const priceHighs = await getPriceHighs(supabase);
  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  const krwBalance = Number(krwAccount?.balance ?? 0);

  const positions = coins.map((coin) => {
    const acc = accounts.find((a) => a.currency === coin);
    const balance = Number(acc?.balance ?? 0);
    const avgBuyKrw = Number(acc?.avg_buy_price ?? 0);
    const currentPrice = priceMap[coin] ?? null;
    const currentValueKrw = currentPrice != null ? balance * currentPrice : null;
    const gainPct = avgBuyKrw > 0 && currentPrice != null
      ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100 : null;

    const high14d = priceHighs[coin]?.high ?? null;
    const dropFromHigh = high14d && currentPrice ? (high14d - currentPrice) / high14d * 100 : null;

    const nextProfitTake = gainPct != null
      ? PROFIT_LEVELS.find((l) => gainPct < (l.mult - 1) * 100) ?? null : null;

    return {
      coin, balance, avgBuyKrw, currentPrice, currentValueKrw,
      gainPct, high14d, dropFromHigh,
      nextProfitTakeLevel: nextProfitTake
        ? `+${((nextProfitTake.mult - 1) * 100).toFixed(0)}% (sell ${nextProfitTake.sellPct}%)`
        : gainPct != null ? 'All levels passed' : null,
    };
  });

  const { data: recentTrades } = await supabase
    .from('crypto_trade_log').select('*').order('executed_at', { ascending: false }).limit(20);

  const { data: fgData } = await supabase
    .from('app_settings').select('value').eq('key', 'fear_greed').single();

  return {
    config, krwBalance, positions, signalScore, signalDecision: decision,
    recentTrades: recentTrades || [],
    fearGreed: fgData?.value ?? null,
  };
}

module.exports = { executeCycle, getStatus, getConfig, saveConfig };
