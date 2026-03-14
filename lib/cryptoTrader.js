/**
 * Crypto trading engine for Upbit KRW markets.
 *
 * Strategy:
 *   1. DCA  — spend weekly_budget_krw each Monday, split BTC/ETH/SOL by configured ratio
 *   2. Signal boost — if latest macro signal score >= 5, add 50% extra to the DCA amount
 *   3. Profit-take — if a position is up 50/100/200% vs avg_buy_price, sell 20% of holdings
 *
 * All executed trades are logged to `crypto_trade_log`.
 * Profit-take triggers are logged to `crypto_profit_take_log` to prevent re-firing.
 */

const upbit = require('./upbit');

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL'];
const DEFAULT_SPLIT = { BTC: 50, ETH: 30, SOL: 20 };
const DEFAULT_WEEKLY_BUDGET = 100000; // ₩100,000

// Profit-take levels: { multiplier, label, cooldownDays }
const PROFIT_LEVELS = [
  { mult: 1.5,  label: '50pct',  pct: 20 },
  { mult: 2.0,  label: '100pct', pct: 20 },
  { mult: 3.0,  label: '200pct', pct: 20 },
];

// Minimum KRW order size on Upbit (enforced by exchange)
const MIN_ORDER_KRW = 5000;

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function getConfig(supabase) {
  const { data } = await supabase
    .from('crypto_trader_config')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return {
    dca_enabled: data?.dca_enabled ?? true,
    weekly_budget_krw: Number(data?.weekly_budget_krw ?? DEFAULT_WEEKLY_BUDGET),
    coins: data?.coins ?? DEFAULT_COINS,
    split: data?.split ?? DEFAULT_SPLIT,
    profit_take_enabled: data?.profit_take_enabled ?? true,
    signal_boost_enabled: data?.signal_boost_enabled ?? true,
    last_dca_run: data?.last_dca_run ?? null,
    id: data?.id ?? null,
  };
}

async function saveConfig(supabase, updates) {
  const current = await getConfig(supabase);
  if (current.id) {
    await supabase.from('crypto_trader_config').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', current.id);
  } else {
    await supabase.from('crypto_trader_config').insert({ ...updates });
  }
}

async function logTrade(supabase, trade) {
  await supabase.from('crypto_trade_log').insert({
    coin: trade.coin,
    side: trade.side,
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
    coin: entry.coin,
    level: entry.level,
    avg_buy_price_krw: entry.avgBuyPrice,
    trigger_price_krw: entry.triggerPrice,
    sold_amount: entry.soldAmount,
    upbit_order_id: entry.upbitOrderId ?? null,
    triggered_at: new Date().toISOString(),
  });
}

/** Check if a profit-take level was already triggered for this coin within cooldownDays */
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

/** Get latest signal score from Supabase */
async function getLatestSignalScore(supabase) {
  const { data } = await supabase
    .from('fx_signal_runs')
    .select('score, decision')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return { score: data?.score ?? null, decision: data?.decision ?? null };
}

// ─── DCA execution ────────────────────────────────────────────────────────────

/**
 * Run DCA buys.
 * Returns array of { coin, krwAmount, result, error } for each attempted buy.
 */
async function runDca(supabase, config, signalScore) {
  const results = [];
  let budget = config.weekly_budget_krw;

  // Signal boost: if score >= 5, spend 50% more
  let boosted = false;
  if (config.signal_boost_enabled && signalScore != null && signalScore >= 5) {
    budget = Math.round(budget * 1.5);
    boosted = true;
  }

  const coins = config.coins || DEFAULT_COINS;
  const split = config.split || DEFAULT_SPLIT;

  for (const coin of coins) {
    const pct = split[coin] ?? 0;
    if (pct <= 0) continue;

    const krwAmount = Math.round(budget * pct / 100);
    if (krwAmount < MIN_ORDER_KRW) {
      results.push({ coin, krwAmount, skipped: true, reason: 'Below minimum order size' });
      continue;
    }

    const market = `KRW-${coin}`;
    try {
      const order = await upbit.marketBuy(market, krwAmount);
      const reason = boosted ? 'DCA_SIGNAL_BOOST' : 'DCA';
      await logTrade(supabase, {
        coin, side: 'buy', krwAmount,
        priceKrw: order.price ? Number(order.price) : null,
        reason,
        upbitOrderId: order.uuid,
        signalScore,
      });
      results.push({ coin, krwAmount, reason, orderId: order.uuid, ok: true });
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message;
      results.push({ coin, krwAmount, ok: false, error: errMsg });
    }
  }

  // Update last_dca_run timestamp
  await saveConfig(supabase, { last_dca_run: new Date().toISOString() });

  return results;
}

// ─── Profit-take execution ────────────────────────────────────────────────────

/**
 * Check all coin positions and sell 20% at each profit-take level if triggered.
 * Uses Upbit's own avg_buy_price (in KRW) for accuracy.
 */
async function runProfitTake(supabase, config) {
  const results = [];
  const accounts = await upbit.getAccounts();
  const coins = config.coins || DEFAULT_COINS;

  // Get current prices for all coins in one call
  const markets = coins.map((c) => `KRW-${c}`);
  const tickers = await upbit.getTicker(markets);
  const priceMap = {};
  for (const t of tickers) {
    const coin = t.market.split('-')[1];
    priceMap[coin] = t.trade_price;
  }

  for (const coin of coins) {
    const account = accounts.find((a) => a.currency === coin);
    if (!account) continue;

    const balance = Number(account.balance);
    const avgBuyPrice = Number(account.avg_buy_price); // KRW per coin
    const currentPrice = priceMap[coin];

    if (balance <= 0 || avgBuyPrice <= 0 || currentPrice == null) continue;

    const gainPct = (currentPrice - avgBuyPrice) / avgBuyPrice * 100;

    for (const level of PROFIT_LEVELS) {
      if (gainPct < (level.mult - 1) * 100) continue; // not reached this level

      // Check cooldown
      const alreadyTriggered = await isProfitTakeTriggered(supabase, coin, level.label);
      if (alreadyTriggered) continue;

      // Sell 20% of current holdings
      const sellAmount = balance * (level.pct / 100);
      const market = `KRW-${coin}`;

      // Upbit minimum sell: check if value > MIN_ORDER_KRW
      if (sellAmount * currentPrice < MIN_ORDER_KRW) {
        results.push({ coin, level: level.label, skipped: true, reason: 'Sell value below minimum' });
        continue;
      }

      // Round down to 8 decimal places (Upbit precision)
      const roundedAmount = Math.floor(sellAmount * 1e8) / 1e8;

      try {
        const order = await upbit.marketSell(market, roundedAmount);
        await logTrade(supabase, {
          coin, side: 'sell',
          coinAmount: roundedAmount,
          priceKrw: currentPrice,
          reason: `PROFIT_TAKE_${level.label.toUpperCase()}`,
          upbitOrderId: order.uuid,
        });
        await logProfitTake(supabase, {
          coin, level: level.label,
          avgBuyPrice, triggerPrice: currentPrice,
          soldAmount: roundedAmount,
          upbitOrderId: order.uuid,
        });
        results.push({
          coin, level: level.label, ok: true,
          gainPct: gainPct.toFixed(1),
          soldAmount: roundedAmount,
          orderId: order.uuid,
        });
      } catch (err) {
        const errMsg = err.response?.data?.error?.message || err.message;
        results.push({ coin, level: level.label, ok: false, error: errMsg });
      }
    }
  }

  return results;
}

// ─── Main execute cycle ───────────────────────────────────────────────────────

/**
 * Full trade cycle:
 *   1. Kill switch check
 *   2. Profit-take check (always runs if enabled)
 *   3. DCA buy (only if it hasn't run this week)
 *
 * forceDca: bypass the weekly timing check (for manual "Run Now" button)
 */
async function executeCycle(supabase, { forceDca = false } = {}) {
  const summary = { dca: [], profitTake: [], skipped: [], errors: [] };

  // Kill switch
  const { data: ks } = await supabase.from('app_settings').select('value').eq('key', 'kill_switch').single();
  if (ks?.value?.enabled) {
    summary.skipped.push('Kill switch is active — no trades executed');
    return summary;
  }

  const config = await getConfig(supabase);
  const { score: signalScore } = await getLatestSignalScore(supabase);

  // Profit-take (runs every cycle regardless of DCA timing)
  if (config.profit_take_enabled) {
    try {
      summary.profitTake = await runProfitTake(supabase, config);
    } catch (err) {
      summary.errors.push(`Profit-take failed: ${err.message}`);
    }
  }

  // DCA timing check: only run if it hasn't run in the last 6 days (or forced)
  if (config.dca_enabled) {
    const lastRun = config.last_dca_run ? new Date(config.last_dca_run) : null;
    const daysSinceLast = lastRun ? (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24) : 999;

    if (forceDca || daysSinceLast >= 6) {
      try {
        summary.dca = await runDca(supabase, config, signalScore);
      } catch (err) {
        summary.errors.push(`DCA failed: ${err.message}`);
      }
    } else {
      summary.skipped.push(`DCA already ran ${daysSinceLast.toFixed(1)} days ago (next run in ${(6 - daysSinceLast).toFixed(1)} days)`);
    }
  }

  return summary;
}

// ─── Status / portfolio ───────────────────────────────────────────────────────

async function getStatus(supabase) {
  const [config, accounts, { score: signalScore, decision }] = await Promise.all([
    getConfig(supabase),
    upbit.getAccounts().catch(() => []),
    getLatestSignalScore(supabase),
  ]);

  const coins = config.coins || DEFAULT_COINS;
  const markets = coins.map((c) => `KRW-${c}`);

  const tickers = markets.length
    ? await upbit.getTicker(markets).catch(() => [])
    : [];

  const priceMap = {};
  for (const t of tickers) {
    priceMap[t.market.split('-')[1]] = t.trade_price;
  }

  const krwAccount = accounts.find((a) => a.currency === 'KRW');
  const krwBalance = Number(krwAccount?.balance ?? 0);

  const positions = coins.map((coin) => {
    const acc = accounts.find((a) => a.currency === coin);
    const balance = Number(acc?.balance ?? 0);
    const avgBuyKrw = Number(acc?.avg_buy_price ?? 0);
    const currentPrice = priceMap[coin] ?? null;
    const currentValueKrw = currentPrice != null ? balance * currentPrice : null;
    const costKrw = balance * avgBuyKrw;
    const gainPct = avgBuyKrw > 0 && currentPrice != null
      ? (currentPrice - avgBuyKrw) / avgBuyKrw * 100
      : null;

    const nextProfitTake = gainPct != null
      ? PROFIT_LEVELS.find((l) => gainPct < (l.mult - 1) * 100) ?? null
      : null;

    return {
      coin, balance, avgBuyKrw, currentPrice, currentValueKrw,
      costKrw, gainPct,
      nextProfitTakeLevel: nextProfitTake ? `${nextProfitTake.label} (${((nextProfitTake.mult - 1) * 100).toFixed(0)}%)` : 'All levels passed',
    };
  });

  const { data: recentTrades } = await supabase
    .from('crypto_trade_log')
    .select('*')
    .order('executed_at', { ascending: false })
    .limit(20);

  return {
    config,
    krwBalance,
    positions,
    signalScore,
    signalDecision: decision,
    recentTrades: recentTrades || [],
  };
}

module.exports = { executeCycle, getStatus, getConfig, saveConfig };
