/**
 * Signal Engine — 4-factor entry and ATR-based exit evaluation.
 *
 * Entry uses ONLY: Trend (EMA/MACD slope) + Stretch (BB %B) + Momentum (RSI) + Execution (OB imbalance)
 * Exit uses: ATR-based trims + time stop + regime break
 *
 * All other indicators (StochRSI, Williams %R, CCI, ROC, OBV, Kimchi) are still
 * computed in cryptoTrader.js but are NOT used for live decisions here.
 * They are written to bot_events for research only.
 */

const { bollinger, rsi, macd, atr, relativeVolume } = require('./indicators');
const upbit = require('./upbit');

// Minimum required edge to sell: buy_fee + sell_fee + spread + safety_buffer
// Fees are fetched at runtime per pair; this is the fallback if fetch fails.
const FALLBACK_FEE_RATE   = 0.0025; // 0.25% per side
const SAFETY_BUFFER_PCT   = 0.10;   // 0.10% net above round-trip fees (lowered for small-profit rotation)

// ─── Candle helpers ───────────────────────────────────────────────────────────

/**
 * Fetch and shape 4h candles for a given asset.
 * Returns arrays: closes, highs, lows, volumes (oldest first).
 */
async function getCandles4h(asset, count = 100) {
  // getMinuteCandles(market, unit, count) returns a flat array (oldest→newest)
  // with fields: trade_price (close), high_price, low_price, candle_acc_trade_volume
  const candles = await upbit.getMinuteCandles(`KRW-${asset}`, 240, count);
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error(`No candle data returned for ${asset}`);
  }
  return {
    closes:  candles.map((c) => c.trade_price),
    highs:   candles.map((c) => c.high_price),
    lows:    candles.map((c) => c.low_price),
    volumes: candles.map((c) => c.candle_acc_trade_volume ?? 0),
    raw:     candles,
  };
}

// ─── Compute live indicators ──────────────────────────────────────────────────

/**
 * Compute the 4 live signal buckets for one asset.
 * Returns indicators used for entry and exit evaluation.
 */
async function computeIndicators(asset, orderBooks = []) {
  const { closes, highs, lows, volumes } = await getCandles4h(asset, 120);

  const rsi14    = rsi(closes, 14);
  const bb       = bollinger(closes, 20, 2);
  const macdData = macd(closes, 12, 26, 9);
  const atrVal   = atr(highs, lows, closes, 14);
  const relVol   = relativeVolume(volumes, 20);

  // EMA slope: compare last two EMA20 values for direction
  const { emaArray } = require('./indicators');
  const ema20arr = emaArray(closes, 20);
  const ema50arr = emaArray(closes, 50);
  const ema20    = ema20arr[ema20arr.length - 1];
  const ema20prev= ema20arr[ema20arr.length - 2];
  const ema50    = ema50arr[ema50arr.length - 1];
  const emaSlope = ema20 != null && ema20prev != null ? ((ema20 - ema20prev) / ema20prev) * 100 : null;

  // MACD slope
  const macdSlope = macdData?.histogram != null && macdData?.prevHistogram != null
    ? macdData.histogram - macdData.prevHistogram
    : null;

  // Order book imbalance for this asset
  const obEntry = Array.isArray(orderBooks)
    ? orderBooks.find((ob) => ob?.market === `KRW-${asset}`)
    : null;
  let obImbalance = null;
  if (obEntry?.orderbook_units?.length) {
    const bids = obEntry.orderbook_units.reduce((s, u) => s + (u.bid_size ?? 0), 0);
    const asks = obEntry.orderbook_units.reduce((s, u) => s + (u.ask_size ?? 0), 0);
    obImbalance = (bids + asks) > 0 ? (bids - asks) / (bids + asks) : null;
  }

  const currentPrice = closes[closes.length - 1];

  return {
    asset,
    currentPrice,
    rsi14,
    bbPctB:     bb?.pctB   ?? null,
    bbUpper:    bb?.upper  ?? null,
    bbLower:    bb?.lower  ?? null,
    bbMid:      bb?.middle ?? null,
    macdHist:   macdData?.histogram     ?? null,
    macdBull:   macdData?.bullishCross  ?? false,
    macdBear:   macdData?.bearishCross  ?? false,
    emaSlope,
    ema20,
    ema50,
    atrVal,
    atrPct:     atrVal && currentPrice ? (atrVal / currentPrice) * 100 : null,
    relVol,
    obImbalance,
    closes,
    highs,
    lows,
  };
}

// ─── Entry evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluate a tactical entry for one asset given the current regime and indicators.
 * Returns a TradeIntent object or null.
 *
 * @param {string} asset
 * @param {object} regime      — from regimeEngine.getRegime()
 * @param {object} ind         — from computeIndicators()
 * @param {object} cfg         — bot_config row
 * @param {number} navKrw      — total portfolio NAV in KRW
 * @returns {{ asset, side, krwAmount, reason, strategy_tag, sizeMult, indicators } | null}
 */
function evaluateEntry(asset, regime, ind, cfg, navKrw) {
  const { regime: r } = regime;

  // SOL is disabled in downtrend
  if (r === 'DOWNTREND' && asset === 'SOL') {
    return null;
  }

  const bbPct  = ind.bbPctB;
  const rsi14  = ind.rsi14;
  const imbal  = ind.obImbalance;
  const relVol = ind.relVol;
  const slope  = ind.emaSlope;

  // Execution quality gate — applies to all regimes.
  // Relaxed from -0.30 to -0.45: allow normal pullbacks where bid side is weaker.
  const obMin = cfg.ob_imbalance_min ?? -0.45;
  if (imbal != null && imbal < obMin) {
    return null; // order book too sell-heavy — fill quality too poor
  }

  let met    = false;
  let reason = null;
  let sizePct = 0;    // % of signal budget for first entry

  if (r === 'UPTREND') {
    // Loosened for small-profit rotation: catch normal pullbacks, not only deep dips.
    // BB %B: 0.25 → 0.45 (mid-band pullbacks qualify)
    // RSI:   35–45 → 42–55 (momentum dip, not extreme oversold required)
    const bbThresh  = cfg.entry_bb_pct_uptrend   ?? 0.45;
    const rsiMin    = cfg.entry_rsi_min_uptrend   ?? 42;
    const rsiMax    = cfg.entry_rsi_max_uptrend   ?? 55;
    // No fresh 4h breakdown: EMA slope not sharply negative
    const noBreakdown = slope == null || slope > -0.15;

    met = bbPct != null && bbPct < bbThresh
       && rsi14 != null && rsi14 >= rsiMin && rsi14 <= rsiMax
       && noBreakdown;

    if (met) {
      reason  = `uptrend_pullback_v2 (RSI=${rsi14?.toFixed(1)} %B=${bbPct?.toFixed(3)})`;
      sizePct = 50; // 50% of budget on first entry; add-on allowed if price dips further
    }

  } else if (r === 'RANGE') {
    // Loosened: BB %B 0.10 → 0.30, RSI max 35 → 45
    const bbThresh = cfg.entry_bb_pct_range   ?? 0.30;
    const rsiMax   = cfg.entry_rsi_max_range  ?? 45;

    met = bbPct != null && bbPct < bbThresh
       && rsi14 != null && rsi14 < rsiMax;

    if (met) {
      reason  = `range_reversion_v2 (RSI=${rsi14?.toFixed(1)} %B=${bbPct?.toFixed(3)})`;
      sizePct = 40; // smaller — edge is lower in range
    }

  } else if (r === 'DOWNTREND') {
    // BTC/ETH only (SOL blocked above), requires extreme oversold + volume spike
    const bbThresh = cfg.entry_bb_pct_downtrend  ?? 0.05;
    const rsiMax   = cfg.entry_rsi_max_downtrend ?? 28;
    const volSpike = relVol != null && relVol > 2.0;

    met = bbPct != null && bbPct < bbThresh
       && rsi14 != null && rsi14 < rsiMax
       && volSpike;

    if (met) {
      reason  = `downtrend_extreme_oversold_v2 (RSI=${rsi14?.toFixed(1)} %B=${bbPct?.toFixed(3)} vol=${relVol?.toFixed(1)}x)`;
      sizePct = 30; // half of uptrend — smaller, no averaging
    }
  }

  if (!met || !reason) return null;

  // Signal budget: 2% NAV max risk per signal (risk engine will also check this)
  const maxRiskPct = cfg.max_risk_per_signal_pct ?? 2;
  const budgetKrw  = Math.max(0, navKrw * (maxRiskPct / 100) * (sizePct / 100));

  if (budgetKrw < 5000) return null; // below Upbit minimum

  return {
    asset,
    side:         'buy',
    krwAmount:    budgetKrw,
    reason,
    strategy_tag: 'tactical',
    sizePct,
    indicators: {
      rsi14:  rsi14?.toFixed(1),
      bbPctB: bbPct?.toFixed(3),
      emaSlope: ind.emaSlope?.toFixed(3),
      obImbalance: imbal?.toFixed(3),
      relVol: relVol?.toFixed(2),
      regime: r,
    },
  };
}

// ─── Exit evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate ATR-based exit for an open tactical position.
 *
 * Returns an array of exit actions (could be multiple trims) or empty array.
 *
 * @param {object} position    — from positions table
 * @param {object} ind         — from computeIndicators()
 * @param {object} regime      — from regimeEngine
 * @param {number} feeRate     — runtime fee (e.g. 0.0025)
 * @param {object} cfg         — bot_config row
 * @param {number} peakPrice   — highest price seen since entry (for trailing stop)
 * @returns {Array<{ asset, side, sellPct, reason, trim }>}
 */
/**
 * Returns true when a position must be completely excluded from all exit logic.
 *
 * A position qualifies for full exit protection when it was imported from the
 * live account at startup (origin = adopted_at_startup) AND has not yet been
 * explicitly classified into a strategy sleeve (strategy_tag = unassigned).
 *
 * Protected positions are visible in the dashboard and in position queries,
 * but no exit — time stop, trailing stop, regime break, or profit take —
 * may fire on them. They must be explicitly classified by the operator (core
 * or tactical) before the strategy applies any exit logic to them.
 *
 * This is the single authoritative guard. Every exit path in evaluateExit()
 * checks this before doing anything else.
 */
function isFullyProtected(position) {
  return (
    position.origin        === 'adopted_at_startup' &&
    position.strategy_tag  === 'unassigned'
  );
}

function evaluateExit(position, ind, regime, feeRate, cfg, peakPrice) {
  const exits = [];
  if (!position || position.qty_open <= 0) return exits;

  // ── Full protection gate ──────────────────────────────────────────────────
  // Positions that were imported from the live account (origin = adopted_at_startup)
  // and have not been classified into a strategy sleeve (strategy_tag = unassigned)
  // are completely excluded from ALL exit logic:
  //   - no time stop
  //   - no trailing stop
  //   - no regime-break exit
  //   - no profit-taking exit (trim1, trim2, runner)
  //
  // The operator must classify the position (core or tactical) via the dashboard
  // before any automated exit can fire. This prevents the bot from selling
  // pre-existing holdings that the user did not explicitly hand over to strategy control.
  if (isFullyProtected(position)) {
    console.log(`    [protected] ${position.asset} origin=adopted_at_startup tag=unassigned — all exits suppressed until classified`);
    return exits;
  }

  const { asset, avg_cost_krw: avgCost, opened_at } = position;
  const currentPrice = ind.currentPrice;
  if (!currentPrice || !avgCost || avgCost <= 0) return exits;

  const gainPct    = ((currentPrice - avgCost) / avgCost) * 100;
  const roundTrip  = (feeRate * 2) * 100;
  const netGainPct = gainPct - roundTrip; // estimated net after fees

  // ── Minimum net gate ──────────────────────────────────────────────────────
  // Required: net gain (gross minus fees) must clear the safety buffer.
  // Previously compared net against (roundTrip + buffer) which double-counted fees
  // and required gross >= 1.20% before ANY exit could fire. New: gross >= fees + buffer.
  const minNet    = cfg.exit_safety_buffer_pct ?? SAFETY_BUFFER_PCT; // default 0.10%
  const atrPct    = ind.atrPct ?? 1.0;
  const trailMult = cfg.exit_atr_trailing   ?? 1.50;
  const timeStopH = cfg.exit_time_stop_hours ?? 30;
  const trailDropPct = trailMult * atrPct;

  // Quick-take profit targets (gross %). Fixed-percentage for predictable small-profit rotation.
  // trim1: 25% at default +0.65% gross → net ≈ +0.15% after 0.25%/side Upbit fees
  // trim2: 25% at default +1.00% gross → net ≈ +0.50%
  // runner: trailing stop on remaining 50%
  const trim1Target = cfg.exit_quick_trim1_gross_pct ?? 0.85;
  const trim2Target = cfg.exit_quick_trim2_gross_pct ?? 1.25;

  const heldHours = (Date.now() - new Date(opened_at).getTime()) / 3600000;

  // ── Regime break — cut tactical SOL immediately if BTC turns DOWNTREND ────
  if (regime.regime === 'DOWNTREND' && asset === 'SOL') {
    exits.push({ asset, side: 'sell', sellPct: 100, reason: 'regime_break_sol', trim: 'regime_break' });
    return exits;
  }

  // ── Regime break — halve BTC/ETH on downtrend flip ────────────────────────
  if (regime.regime === 'DOWNTREND' && (asset === 'BTC' || asset === 'ETH')) {
    if (position.entry_regime !== 'DOWNTREND') {
      exits.push({ asset, side: 'sell', sellPct: 50, reason: 'regime_break_reduce', trim: 'regime_break' });
      return exits;
    }
  }

  // ── Time stop — flat trade tying up capital ───────────────────────────────
  if (heldHours >= timeStopH && Math.abs(netGainPct) < 0.5) {
    exits.push({ asset, side: 'sell', sellPct: 50, reason: `time_stop_${Math.round(heldHours)}h`, trim: 'time_stop' });
    return exits;
  }

  // Gate: net gain must clear safety buffer before any profit exit fires
  if (netGainPct < minNet) return exits;

  const firedTrims = position.fired_trims ?? [];

  // ── Quick Trim 1 — 25% at first profit target ─────────────────────────────
  if (!firedTrims.includes('trim1') && gainPct >= trim1Target) {
    exits.push({ asset, side: 'sell', sellPct: 25, reason: `trim1_${gainPct.toFixed(2)}pct_gross`, trim: 'trim1' });
  }

  // ── Quick Trim 2 — 25% at second profit target ────────────────────────────
  if (!firedTrims.includes('trim2') && firedTrims.includes('trim1') && gainPct >= trim2Target) {
    exits.push({ asset, side: 'sell', sellPct: 25, reason: `trim2_${gainPct.toFixed(2)}pct_gross`, trim: 'trim2' });
  }

  // ── Runner trailing stop — remaining ~50% after both trims ────────────────
  if (firedTrims.includes('trim2') && !firedTrims.includes('runner')) {
    if (peakPrice && peakPrice > 0) {
      const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (dropFromPeak >= trailDropPct) {
        exits.push({ asset, side: 'sell', sellPct: 100, reason: `runner_trail_${dropFromPeak.toFixed(1)}pct_from_peak`, trim: 'runner' });
      }
    }
  }

  return exits;
}

/**
 * Compute the required minimum edge to make a sell worthwhile.
 * Uses runtime fee data when available.
 */
function requiredEdge(buyFeeRate, sellFeeRate, spreadEst = 0) {
  const fees = (buyFeeRate + sellFeeRate) * 100;
  return fees + spreadEst + SAFETY_BUFFER_PCT;
}

module.exports = {
  computeIndicators,
  evaluateEntry,
  evaluateExit,
  isFullyProtected,
  requiredEdge,
};
