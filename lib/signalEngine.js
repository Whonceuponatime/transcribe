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
const MS_PER_HOUR         = 1000 * 60 * 60;

/**
 * Parse a DB/API timestamp to epoch milliseconds. Returns null if unusable.
 */
function parsePositionTimestampMs(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // Heuristic: Unix seconds (~1e9) vs milliseconds (~1e12)
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const normalized = /\dT\d/.test(s) ? s : s.replace(' ', 'T');
    const t = Date.parse(normalized);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof raw === 'object' && raw !== null && typeof raw.value === 'string') {
    return parsePositionTimestampMs(raw.value);
  }
  return null;
}

/** Hours elapsed since raw timestamp; null if unparseable. */
function hoursSinceTimestamp(raw) {
  const ms = parsePositionTimestampMs(raw);
  if (ms == null) return null;
  return (Date.now() - ms) / MS_PER_HOUR;
}

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
/**
 * @param {object|null} effectiveThresholds - output from adaptiveThresholds.computeAdaptiveThresholds().
 *   When provided, overrides config BB %B and OB thresholds with bounded adaptive values.
 *   RSI thresholds always come from cfg (never adapted).
 */
function evaluateEntry(asset, regime, ind, cfg, navKrw, effectiveThresholds = null) {
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
  // Use adaptive effective threshold when provided, otherwise fall back to config.
  const obMin = effectiveThresholds?.effectiveObMin ?? cfg.ob_imbalance_min ?? -0.45;
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
    const bbThresh  = effectiveThresholds?.effectiveBbUptrend ?? cfg.entry_bb_pct_uptrend ?? 0.45;
    const rsiMin    = cfg.entry_rsi_min_uptrend   ?? 42;
    const rsiMax    = effectiveThresholds?.effectiveRsiMaxUptrend ?? cfg.entry_rsi_max_uptrend ?? 55;
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
    const bbThresh = effectiveThresholds?.effectiveBbRange ?? cfg.entry_bb_pct_range ?? 0.30;
    const rsiMax   = cfg.entry_rsi_max_range  ?? 45;

    met = bbPct != null && bbPct < bbThresh
       && rsi14 != null && rsi14 < rsiMax;

    if (met) {
      reason  = `range_reversion_v2 (RSI=${rsi14?.toFixed(1)} %B=${bbPct?.toFixed(3)})`;
      sizePct = 40; // smaller — edge is lower in range
    }

  } else if (r === 'DOWNTREND') {
    // BTC/ETH only (SOL blocked above), requires extreme oversold + volume spike
    const bbThresh = effectiveThresholds?.effectiveBbDowntrend ?? cfg.entry_bb_pct_downtrend ?? 0.05;
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

/** True when the position was opened via evaluateDowntrendReclaimStarter (reason prefix match). */
function isDowntrendReclaimStarterPosition(position) {
  const r = position?.entry_reason;
  return typeof r === 'string' && r.startsWith('dt_reclaim_starter');
}

/**
 * Diagnostics for reclaim-aware partial harvest (DECISION_CYCLE / EXIT_EVALUATION).
 * Must stay aligned with evaluateExit reclaim_harvest branch.
 */
function getReclaimHarvestDiagnostics(position, cfg, { netGainPct, gainPct, heldHours, trim1Target, firedTrims, exits }) {
  const minNet = cfg.exit_safety_buffer_pct ?? SAFETY_BUFFER_PCT;
  const reclaimOrigin = isDowntrendReclaimStarterPosition(position);
  const reclaimInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'reclaim_harvest');

  if (!reclaimOrigin) {
    return {
      reclaim_origin:               false,
      reclaim_harvest_considered:   false,
      reclaim_harvest_blocker:      null,
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     false,
    };
  }

  if (netGainPct == null || gainPct == null) {
    return {
      reclaim_origin:               true,
      reclaim_harvest_considered:   true,
      reclaim_harvest_blocker:      'pnl_unavailable',
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     false,
    };
  }

  if (netGainPct < minNet) {
    return {
      reclaim_origin:               true,
      reclaim_harvest_considered:   true,
      reclaim_harvest_blocker:      'below_net_gate',
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     reclaimInExits,
    };
  }
  if (firedTrims.includes('reclaim_harvest')) {
    return {
      reclaim_origin:               true,
      reclaim_harvest_considered:   true,
      reclaim_harvest_blocker:      'reclaim_harvest_already_fired',
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     reclaimInExits,
    };
  }
  if (firedTrims.includes('trim1')) {
    return {
      reclaim_origin:               true,
      reclaim_harvest_considered:   true,
      reclaim_harvest_blocker:      'trim1_already_fired',
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     false,
    };
  }
  if (gainPct >= trim1Target) {
    return {
      reclaim_origin:               true,
      reclaim_harvest_considered:   true,
      reclaim_harvest_blocker:      'trim1_gross_threshold_reached',
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     false,
    };
  }

  const reclaimHours = cfg.exit_reclaim_harvest_hours ?? 0.75;
  if (heldHours < reclaimHours) {
    return {
      reclaim_origin:               true,
      reclaim_harvest_considered:   true,
      reclaim_harvest_blocker:      `held_lt_${reclaimHours}h`,
      reclaim_harvest_would_fire:   false,
      reclaim_harvest_in_exits:     false,
    };
  }

  return {
    reclaim_origin:               true,
    reclaim_harvest_considered:   true,
    reclaim_harvest_blocker:      null,
    reclaim_harvest_would_fire:   true,
    reclaim_harvest_in_exits:     reclaimInExits,
  };
}

/**
 * Diagnostics for tactical profit-floor partial exit (non-reclaim tactical only).
 * Must stay aligned with evaluateExit tactical_floor branch.
 */
function getTacticalProfitFloorDiagnostics(position, cfg, { netGainPct, gainPct, heldHours, trim1Target, firedTrims, exits }) {
  const minNet = cfg.exit_safety_buffer_pct ?? SAFETY_BUFFER_PCT;
  const tactical = position.strategy_tag === 'tactical';
  const reclaimOrigin = isDowntrendReclaimStarterPosition(position);
  const floorInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'tactical_floor');

  if (!tactical) {
    return {
      tactical_profit_floor_considered: false,
      tactical_profit_floor_blocker:    null,
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   false,
    };
  }

  if (reclaimOrigin) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    'reclaim_origin_uses_reclaim_harvest',
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   floorInExits,
    };
  }

  if (netGainPct == null || gainPct == null) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    'pnl_unavailable',
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   false,
    };
  }

  if (netGainPct < minNet) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    'below_net_gate',
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   floorInExits,
    };
  }
  if (firedTrims.includes('tactical_floor')) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    'tactical_floor_already_fired',
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   floorInExits,
    };
  }
  if (firedTrims.includes('trim1')) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    'trim1_already_fired',
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   false,
    };
  }
  if (gainPct >= trim1Target) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    'trim1_gross_threshold_reached',
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   false,
    };
  }

  const floorHours = cfg.exit_tactical_profit_floor_hours ?? 2.5;
  if (heldHours < floorHours) {
    return {
      tactical_profit_floor_considered: true,
      tactical_profit_floor_blocker:    `held_lt_${floorHours}h`,
      tactical_profit_floor_would_fire: false,
      tactical_profit_floor_in_exits:   false,
    };
  }

  return {
    tactical_profit_floor_considered: true,
    tactical_profit_floor_blocker:    null,
    tactical_profit_floor_would_fire: true,
    tactical_profit_floor_in_exits:   floorInExits,
  };
}

/**
 * Diagnostics for post-trim runner partial exit (fires once after trim1+trim2, before runner trailing stop).
 * Must stay aligned with evaluateExit post_trim_runner branch.
 */
function getPostTrimRunnerDiagnostics(position, cfg, { netGainPct, heldHours, firedTrims, exits }) {
  const postTrimRunnerInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'post_trim_runner');

  const hasTrim1  = firedTrims.includes('trim1');
  const hasTrim2  = firedTrims.includes('trim2');
  const hasRunner = firedTrims.includes('runner');
  const hasFired  = firedTrims.includes('post_trim_runner');

  if (!hasTrim1) {
    return {
      post_trim_runner_considered:  false,
      post_trim_runner_blocker:     'trim1_not_yet_fired',
      post_trim_runner_would_fire:  false,
      post_trim_runner_in_exits:    false,
    };
  }
  if (!hasTrim2) {
    return {
      post_trim_runner_considered:  false,
      post_trim_runner_blocker:     'trim2_not_yet_fired',
      post_trim_runner_would_fire:  false,
      post_trim_runner_in_exits:    false,
    };
  }
  if (hasRunner) {
    return {
      post_trim_runner_considered:  true,
      post_trim_runner_blocker:     'runner_already_fired',
      post_trim_runner_would_fire:  false,
      post_trim_runner_in_exits:    postTrimRunnerInExits,
    };
  }
  if (hasFired) {
    return {
      post_trim_runner_considered:  true,
      post_trim_runner_blocker:     'post_trim_runner_already_fired',
      post_trim_runner_would_fire:  false,
      post_trim_runner_in_exits:    postTrimRunnerInExits,
    };
  }
  if (netGainPct == null) {
    return {
      post_trim_runner_considered:  true,
      post_trim_runner_blocker:     'pnl_unavailable',
      post_trim_runner_would_fire:  false,
      post_trim_runner_in_exits:    false,
    };
  }

  const postTrimRunnerHours = cfg.exit_post_trim_runner_hours ?? 6;
  if (heldHours < postTrimRunnerHours) {
    return {
      post_trim_runner_considered:  true,
      post_trim_runner_blocker:     `held_lt_${postTrimRunnerHours}h`,
      post_trim_runner_would_fire:  false,
      post_trim_runner_in_exits:    postTrimRunnerInExits,
    };
  }

  return {
    post_trim_runner_considered:  true,
    post_trim_runner_blocker:     null,
    post_trim_runner_would_fire:  true,
    post_trim_runner_in_exits:    postTrimRunnerInExits,
  };
}

/**
 * Diagnostics for runner protection partial exit.
 * Fires once after trim1 + post_trim_runner have both fired (tactical), or after
 * trim1 + trim2 + post_trim_runner have all fired (core / non-tactical exhausted),
 * when the net P&L has either fallen below a configured floor OR retraced from
 * the position's peak price by a configured threshold.
 * Must stay aligned with evaluateExit runner_protect branch.
 *
 * @param {object} position
 * @param {object} cfg
 * @param {{ netGainPct, firedTrims, exits, peakPrice, currentPrice, avgCost, feeRate }} ctx
 */
function getRunnerProtectDiagnostics(position, cfg, { netGainPct, firedTrims, exits, peakPrice, currentPrice, avgCost, feeRate }) {
  const runnerProtectInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'runner_protect');

  const hasTrim1          = firedTrims.includes('trim1');
  const hasTrim2          = firedTrims.includes('trim2');
  const hasPostTrimRunner = firedTrims.includes('post_trim_runner');
  const hasRunner         = firedTrims.includes('runner');
  const hasFired          = firedTrims.includes('runner_protect');
  const isTactical        = position.strategy_tag === 'tactical';

  // Core (non-tactical) positions qualify only after all three exit stages have fired.
  const isCoreExhausted   = !isTactical && hasTrim1 && hasTrim2 && hasPostTrimRunner;

  const roundTrip  = (feeRate ?? 0) * 2 * 100;
  const peakNetPct = (peakPrice && peakPrice > 0 && avgCost && avgCost > 0)
    ? +( ((peakPrice - avgCost) / avgCost) * 100 - roundTrip ).toFixed(3)
    : null;

  if (!isTactical && !isCoreExhausted) {
    return { runner_protect_considered: false, runner_protect_blocker: 'not_tactical', runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: false };
  }
  if (!hasTrim1) {
    return { runner_protect_considered: false, runner_protect_blocker: 'trim1_not_yet_fired', runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: false };
  }
  if (!hasPostTrimRunner) {
    return { runner_protect_considered: false, runner_protect_blocker: 'post_trim_runner_not_yet_fired', runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: false };
  }
  if (hasRunner) {
    return { runner_protect_considered: true, runner_protect_blocker: 'runner_already_fired', runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: runnerProtectInExits };
  }
  if (hasFired) {
    return { runner_protect_considered: true, runner_protect_blocker: 'runner_protect_already_fired', runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: runnerProtectInExits };
  }
  if (netGainPct == null) {
    return { runner_protect_considered: true, runner_protect_blocker: 'pnl_unavailable', runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: false };
  }

  const runnerFloorNetPct        = cfg.exit_runner_floor_net_pct         ?? 0.75;
  const runnerRetraceFromPeakPct = cfg.exit_runner_retrace_from_peak_pct ?? 0.75;

  const belowFloor = netGainPct < runnerFloorNetPct;
  const retraceFromPeak = (peakPrice && peakPrice > 0 && currentPrice)
    ? ((peakPrice - currentPrice) / peakPrice) * 100
    : null;
  const retraceHit = retraceFromPeak != null && retraceFromPeak >= runnerRetraceFromPeakPct;

  if (!belowFloor && !retraceHit) {
    const blocker = retraceFromPeak != null
      ? `above_floor(net=${netGainPct.toFixed(2)}>=${runnerFloorNetPct})_no_retrace(${retraceFromPeak.toFixed(2)}%<${runnerRetraceFromPeakPct}%)`
      : `above_floor(net=${netGainPct.toFixed(2)}>=${runnerFloorNetPct})_peak_unknown`;
    return { runner_protect_considered: true, runner_protect_blocker: blocker, runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: false, runner_protect_in_exits: runnerProtectInExits };
  }

  return { runner_protect_considered: true, runner_protect_blocker: null, runner_protect_peak_net_pct: peakNetPct, runner_protect_would_fire: true, runner_protect_in_exits: runnerProtectInExits };
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

  // ── Regime break — one-time reduction per position per regime episode ───────
  // Guard: fired_trims includes 'regime_break' after the first confirmed sell.
  // Without this, every cycle fires a new sell while regime stays DOWNTREND.
  const alreadyRegimeReduced = (position.fired_trims ?? []).includes('regime_break');

  if (!alreadyRegimeReduced && regime.regime === 'DOWNTREND' && asset === 'SOL') {
    exits.push({ asset, side: 'sell', sellPct: 100, reason: 'regime_break_sol', trim: 'regime_break' });
    return exits;
  }

  if (!alreadyRegimeReduced && regime.regime === 'DOWNTREND' && (asset === 'BTC' || asset === 'ETH')) {
    if (position.entry_regime !== 'DOWNTREND') {
      exits.push({ asset, side: 'sell', sellPct: 50, reason: 'regime_break_reduce', trim: 'regime_break' });
      return exits;
    }
  }

  // ── Time stop — flat trade tying up capital ───────────────────────────────
  // Guard: only fire once per position. fired_trims records it after execution.
  // Without this, time_stop fires every cycle (cooldown is bypassed for protective
  // exits) and progressively halves the position to dust each minute.
  const alreadyTimeStopped = (position.fired_trims ?? []).includes('time_stop');
  if (!alreadyTimeStopped && heldHours >= timeStopH && Math.abs(netGainPct) < 0.5) {
    exits.push({ asset, side: 'sell', sellPct: 50, reason: `time_stop_${Math.round(heldHours)}h`, trim: 'time_stop' });
    return exits;
  }

  const firedTrims = position.fired_trims ?? [];

  // ── Ladder exhausted exit — HOISTED ABOVE THE NET-EDGE GATE ───────────────
  // Why this sits above `if (netGainPct < minNet) return exits;`:
  //   Every other profit-taking rung needs the 0.10% net-edge buffer because
  //   closing below that buffer realizes a loss after fees. ladder_exhausted_exit
  //   is the single rung designed to reach positions the edge gate blocks —
  //   either break-even/tiny-profit zombies (branches a/b) or old underwater
  //   bleeds (branch c). Keeping it below the gate would be unreachable for
  //   every case it was designed to solve.
  //
  // All OTHER rungs remain below the gate in their original order — only this
  // one moves. The guards inside still ensure single-fire semantics.
  //
  // Three firing conditions (any one qualifies); all require:
  //   - not already fired
  //   - all four primary rungs (trim1, trim2, post_trim_runner, runner_protect) fired
  //
  //   (a) idle >= exit_ladder_exhausted_hours      AND net >= exit_ladder_exhausted_min_net_pct  → bank modest win
  //   (b) idle >= exit_ladder_exhausted_late_hours AND net >  0.00%                              → break even and move on
  //   (c) held >= exit_ladder_exhausted_underwater_min_age_hours
  //         AND net <= exit_ladder_exhausted_underwater_min_loss_pct
  //         AND exit_ladder_exhausted_underwater_enabled === true                                → force-close bleeding zombie
  //
  // Branch (c) uses heldHours (age from opened_at) rather than idle-since-last-fill
  // on purpose: the concern is "stuck in a loss for days," not "just paused."
  const ladderExhaustedFired         = firedTrims.includes('ladder_exhausted_exit');
  const ladderExhaustedHours         = cfg.exit_ladder_exhausted_hours                      ?? 24.0;
  const ladderExhaustedLateHours     = cfg.exit_ladder_exhausted_late_hours                 ?? 48.0;
  const ladderExhaustedMinNet        = cfg.exit_ladder_exhausted_min_net_pct                ?? 0.30;
  const ladderUnderwaterEnabled      = cfg.exit_ladder_exhausted_underwater_enabled         ?? true;
  const ladderUnderwaterMinLoss      = cfg.exit_ladder_exhausted_underwater_min_loss_pct    ?? -2.0;
  const ladderUnderwaterMinAge       = cfg.exit_ladder_exhausted_underwater_min_age_hours   ?? 96.0;
  const allPrimaryRungsFired =
    firedTrims.includes('trim1') &&
    firedTrims.includes('trim2') &&
    firedTrims.includes('post_trim_runner') &&
    firedTrims.includes('runner_protect');
  const hoursSinceUpdateLE = hoursSinceTimestamp(position.updated_at ?? position.updatedAt);
  if (!ladderExhaustedFired && allPrimaryRungsFired) {
    const idleOk  = hoursSinceUpdateLE != null;
    const branchA = idleOk && hoursSinceUpdateLE >= ladderExhaustedHours     && netGainPct >= ladderExhaustedMinNet;
    const branchB = idleOk && hoursSinceUpdateLE >= ladderExhaustedLateHours && netGainPct >  0.0;
    const branchC = ladderUnderwaterEnabled
                 && heldHours  >= ladderUnderwaterMinAge
                 && netGainPct <= ladderUnderwaterMinLoss;
    if (branchA || branchB) {
      exits.push({
        asset,
        side:    'sell',
        sellPct: 100,
        reason:  `ladder_exhausted_exit_${netGainPct.toFixed(2)}pct_net_${(Math.round(hoursSinceUpdateLE * 10) / 10).toFixed(1)}h_since_last_fill`,
        trim:    'ladder_exhausted_exit',
      });
    } else if (branchC) {
      exits.push({
        asset,
        side:    'sell',
        sellPct: 100,
        reason:  `ladder_exhausted_underwater_${netGainPct.toFixed(2)}pct_net_${heldHours.toFixed(1)}h_held`,
        trim:    'ladder_exhausted_exit',
      });
    }
  }

  // Gate: net gain must clear safety buffer before any profit exit fires
  if (netGainPct < minNet) return exits;

  // ── Reclaim starter partial harvest — earlier, smaller than trim1 / generic harvest ──
  // Positions from dt_reclaim_starter only: bank a small gain after a short hold while
  // still below trim1 gross, without waiting exit_profit_harvest_hours (default 4h).
  // trim name reclaim_harvest is distinct from harvest; one-shot via fired_trims.
  const reclaimHarvestHours   = cfg.exit_reclaim_harvest_hours    ?? 0.75;
  const reclaimHarvestSizePct = cfg.exit_reclaim_harvest_size_pct ?? 12;
  const reclaimHarvestFired   = firedTrims.includes('reclaim_harvest');
  if (
    isDowntrendReclaimStarterPosition(position) &&
    !reclaimHarvestFired &&
    !firedTrims.includes('trim1') &&
    heldHours >= reclaimHarvestHours &&
    gainPct < trim1Target
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: reclaimHarvestSizePct,
      reason:  `reclaim_harvest_${netGainPct.toFixed(2)}pct_net_${Math.round(heldHours * 60)}m`,
      trim:    'reclaim_harvest',
    });
  }

  // ── Tactical profit floor — non-reclaim tactical only, before generic 4h harvest ──
  // Banks a small win when above edge but below trim1; reclaim entries use reclaim_harvest.
  const tacticalFloorHours   = cfg.exit_tactical_profit_floor_hours    ?? 2.5;
  const tacticalFloorSizePct = cfg.exit_tactical_profit_floor_size_pct ?? 12;
  const tacticalFloorFired   = firedTrims.includes('tactical_floor');
  if (
    position.strategy_tag === 'tactical' &&
    !isDowntrendReclaimStarterPosition(position) &&
    !tacticalFloorFired &&
    !firedTrims.includes('trim1') &&
    heldHours >= tacticalFloorHours &&
    gainPct < trim1Target
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: tacticalFloorSizePct,
      reason:  `tactical_floor_${netGainPct.toFixed(2)}pct_net_${(Math.round(heldHours * 10) / 10).toFixed(1)}h`,
      trim:    'tactical_floor',
    });
  }

  // ── Profit-floor harvest — small realization after sustained above-edge ────
  // Fires once when the position has been held for exit_profit_harvest_hours
  // (default 4h) AND net gain is already above the safety buffer, but has not
  // yet reached the trim1 gross target. Prevents positions from sitting
  // indefinitely at above_edge_no_exit_condition_met with realized gains of zero.
  // Guard: only fires before trim1 and only once (harvest in fired_trims).
  const harvestHours    = cfg.exit_profit_harvest_hours    ?? 4;
  const harvestSizePct  = cfg.exit_profit_harvest_size_pct ?? 25;
  const harvestFired    = firedTrims.includes('harvest');
  if (!harvestFired && !firedTrims.includes('trim1') && heldHours >= harvestHours && gainPct < trim1Target) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: harvestSizePct,
      reason:  `harvest_${netGainPct.toFixed(2)}pct_net_${Math.round(heldHours)}h`,
      trim:    'harvest',
    });
  }

  // ── Quick Trim 1 — 25% at first profit target ─────────────────────────────
  if (!firedTrims.includes('trim1') && gainPct >= trim1Target) {
    exits.push({ asset, side: 'sell', sellPct: 25, reason: `trim1_${gainPct.toFixed(2)}pct_gross`, trim: 'trim1' });
  }

  // ── Quick Trim 2 — 25% at second profit target ────────────────────────────
  if (!firedTrims.includes('trim2') && firedTrims.includes('trim1') && gainPct >= trim2Target) {
    exits.push({ asset, side: 'sell', sellPct: 25, reason: `trim2_${gainPct.toFixed(2)}pct_gross`, trim: 'trim2' });
  }

  // ── Post-trim runner partial exit — once after both trims, before trailing stop ──
  // After trim1 + trim2 have both fired, a portion of the remaining runner is sold
  // if the position has been held for at least exit_post_trim_runner_hours total
  // without the ATR trailing stop triggering. Prevents the runner from sitting
  // indefinitely at a profit without any realisation.
  // Guard: fires only once (post_trim_runner in fired_trims) and only before runner.
  const postTrimRunnerFired   = firedTrims.includes('post_trim_runner');
  const postTrimRunnerHours   = cfg.exit_post_trim_runner_hours    ?? 6;
  const postTrimRunnerSizePct = cfg.exit_post_trim_runner_size_pct ?? 33;
  if (
    firedTrims.includes('trim1') &&
    firedTrims.includes('trim2') &&
    !firedTrims.includes('runner') &&
    !postTrimRunnerFired &&
    heldHours >= postTrimRunnerHours
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: postTrimRunnerSizePct,
      reason:  `post_trim_runner_${netGainPct.toFixed(2)}pct_net_${Math.round(heldHours)}h`,
      trim:    'post_trim_runner',
    });
  }

  // ── Runner protection — small slice when profit erodes after post_trim_runner ──
  // Fires once after the position's exit sequence is exhausted and profit starts
  // eroding, when either:
  //   (a) net P&L falls below exit_runner_floor_net_pct (profit eroding toward break-even), OR
  //   (b) current price has retraced from the tracked peak by exit_runner_retrace_from_peak_pct
  // Qualifies for:
  //   - tactical positions: trim1 + post_trim_runner must have fired
  //   - core (non-tactical) positions: trim1 + trim2 + post_trim_runner must all have fired
  // Guard: fires only once (runner_protect in fired_trims), does not replace runner trailing stop.
  const runnerProtectFired          = firedTrims.includes('runner_protect');
  const runnerFloorNetPct           = cfg.exit_runner_floor_net_pct         ?? 0.75;
  const runnerRetraceFromPeakPct    = cfg.exit_runner_retrace_from_peak_pct ?? 0.75;
  const runnerProtectSizePct        = cfg.exit_runner_protect_size_pct      ?? 12;
  const qualifiesForRunnerProtect =
    (position.strategy_tag === 'tactical' &&
      firedTrims.includes('trim1') &&
      firedTrims.includes('post_trim_runner')) ||
    (position.strategy_tag !== 'tactical' &&
      firedTrims.includes('trim1') &&
      firedTrims.includes('trim2') &&
      firedTrims.includes('post_trim_runner'));
  if (
    qualifiesForRunnerProtect &&
    !firedTrims.includes('runner') &&
    !runnerProtectFired
  ) {
    const belowFloor = netGainPct < runnerFloorNetPct;
    const retraceFromPeak = peakPrice && peakPrice > 0
      ? ((peakPrice - currentPrice) / peakPrice) * 100
      : null;
    const retraceHit = retraceFromPeak != null && retraceFromPeak >= runnerRetraceFromPeakPct;
    if (belowFloor || retraceHit) {
      const triggerReason = belowFloor
        ? `floor:net=${netGainPct.toFixed(2)}pct<${runnerFloorNetPct}`
        : `retrace:${retraceFromPeak.toFixed(2)}pct_from_peak>=${runnerRetraceFromPeakPct}`;
      exits.push({
        asset,
        side:    'sell',
        sellPct: runnerProtectSizePct,
        reason:  `runner_protect_${triggerReason}`,
        trim:    'runner_protect',
      });
    }
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

  // ── Tactical time stop — full close when tactical position exceeds max hold time ──
  if (
    position.strategy_tag === 'tactical' &&
    !firedTrims.includes('tactical_time_stop') &&
    netGainPct >= minNet &&
    heldHours >= (cfg.exit_tactical_time_stop_hours ?? 72.0)
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: 100,
      reason:  `tactical_time_stop_${(cfg.exit_tactical_time_stop_hours ?? 72).toFixed(0)}h_held_net=${netGainPct.toFixed(2)}pct`,
      trim:    'tactical_time_stop',
    });
  }

  // ── Tactical final exit — full close after all rungs exhausted ──────────
  const hoursSinceUpdateTactical = hoursSinceTimestamp(position.updated_at ?? position.updatedAt);
  const tacticalFinalExitMinNet = cfg.exit_tactical_final_exit_min_net_pct ?? 0.5;
  if (
    position.strategy_tag === 'tactical' &&
    !firedTrims.includes('tactical_final_exit') &&
    firedTrims.includes('trim1') &&
    firedTrims.includes('trim2') &&
    firedTrims.includes('post_trim_runner') &&
    firedTrims.includes('runner_protect') &&
    netGainPct >= tacticalFinalExitMinNet &&
    hoursSinceUpdateTactical >= (cfg.exit_tactical_final_exit_hours ?? 4.0)
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: 100,
      reason:  `tactical_final_exit_${netGainPct.toFixed(2)}pct_net_${hoursSinceUpdateTactical.toFixed(1)}h_since_last_fill`,
      trim:    'tactical_final_exit',
    });
  }

  // ── Core time stop — full close when core position exceeds max hold time ──
  // Safety fallback for any core (non-tactical) position that has been open
  // longer than exit_core_time_stop_hours (default 48h from opened_at),
  // regardless of rung state. Prevents capital from being permanently stranded
  // if the exit rung ladder stalls for any reason.
  // Gate: only above edge (guarded by the minNet check at line ~657).
  // Guard: fires only once (core_time_stop in fired_trims).
  const coreTimeStopFired = firedTrims.includes('core_time_stop');
  const coreTimeStopHours = cfg.exit_core_time_stop_hours ?? 48.0;
  if (
    position.strategy_tag !== 'tactical' &&
    !coreTimeStopFired &&
    heldHours >= coreTimeStopHours
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: 100,
      reason:  `core_time_stop_${Math.round(heldHours)}h_held_net=${netGainPct.toFixed(2)}pct`,
      trim:    'core_time_stop',
    });
  }

  // ── Core final exit — full close after all rungs exhausted ───────────────
  // Fires once for core (non-tactical) positions after trim1 + trim2 +
  // post_trim_runner + runner_protect have all fired, once the position has
  // been in that exhausted state for at least exit_core_final_exit_hours
  // (default 4h). position.updated_at is used as a proxy for when
  // runner_protect (the last fill) fired.
  // Without this rung, runner_protect fires a partial and the leftover qty
  // sits indefinitely with no remaining exit mechanism.
  // Gate: only above edge (guarded by the minNet check at line ~657).
  // Guard: fires only once (core_final_exit in fired_trims).
  const coreFinalExitFired  = firedTrims.includes('core_final_exit');
  const coreFinalExitHours  = cfg.exit_core_final_exit_hours ?? 4.0;
  const coreFinalExitMinNet = cfg.exit_core_final_exit_min_net_pct ?? 0.5;
  const hoursSinceUpdate    = hoursSinceTimestamp(position.updated_at ?? position.updatedAt);
  if (
    position.strategy_tag !== 'tactical' &&
    firedTrims.includes('trim1') &&
    firedTrims.includes('trim2') &&
    firedTrims.includes('post_trim_runner') &&
    firedTrims.includes('runner_protect') &&
    !coreFinalExitFired &&
    netGainPct >= coreFinalExitMinNet &&
    hoursSinceUpdate != null && hoursSinceUpdate >= coreFinalExitHours
  ) {
    exits.push({
      asset,
      side:    'sell',
      sellPct: 100,
      reason:  `core_final_exit_${netGainPct.toFixed(2)}pct_net_${(Math.round(hoursSinceUpdate * 10) / 10).toFixed(1)}h_since_last_fill`,
      trim:    'core_final_exit',
    });
  }

  return exits;
}

/**
 * Diagnostics for the core_time_stop exit rung.
 * Fires once for non-tactical positions open longer than exit_core_time_stop_hours
 * (default 48h), regardless of rung state.
 * Must stay aligned with the evaluateExit core_time_stop branch.
 *
 * @param {object} position
 * @param {object} cfg
 * @param {{ netGainPct, firedTrims, exits, heldHours }} ctx
 */
function getCoreTimeStopDiagnostics(position, cfg, { netGainPct, firedTrims, exits, heldHours }) {
  const coreTimeStopInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'core_time_stop');
  const isCore              = position.strategy_tag !== 'tactical';
  const hasFired            = firedTrims.includes('core_time_stop');
  const coreTimeStopHours   = cfg.exit_core_time_stop_hours ?? 48.0;

  if (!isCore) {
    return { core_time_stop_considered: false, core_time_stop_blocker: 'not_core', core_time_stop_would_fire: false, core_time_stop_in_exits: false };
  }
  if (hasFired) {
    return { core_time_stop_considered: true, core_time_stop_blocker: 'already_fired', core_time_stop_would_fire: false, core_time_stop_in_exits: coreTimeStopInExits };
  }
  if (netGainPct == null) {
    return { core_time_stop_considered: true, core_time_stop_blocker: 'pnl_unavailable', core_time_stop_would_fire: false, core_time_stop_in_exits: false };
  }
  if (heldHours < coreTimeStopHours) {
    return { core_time_stop_considered: true, core_time_stop_blocker: `wait:${heldHours.toFixed(1)}h<${coreTimeStopHours}h_held`, core_time_stop_would_fire: false, core_time_stop_in_exits: false };
  }
  return { core_time_stop_considered: true, core_time_stop_blocker: null, core_time_stop_would_fire: true, core_time_stop_in_exits: coreTimeStopInExits };
}

/**
 * Diagnostics for the core_final_exit rung.
 * Fires once for non-tactical positions after trim1 + trim2 + post_trim_runner +
 * runner_protect have all fired AND exit_core_final_exit_hours (default 4h) have
 * elapsed since position.updated_at (proxy for when runner_protect fill landed).
 * Must stay aligned with the evaluateExit core_final_exit branch.
 *
 * @param {object} position
 * @param {object} cfg
 * @param {{ netGainPct, firedTrims, exits }} ctx
 */
function getCoreFinalExitDiagnostics(position, cfg, { netGainPct, firedTrims, exits }) {
  const coreFinalExitInExits = Array.isArray(exits) && exits.some((e) => e.trim === 'core_final_exit');
  const isCore               = position.strategy_tag !== 'tactical';
  const hasFired             = firedTrims.includes('core_final_exit');
  const coreFinalExitHours   = cfg.exit_core_final_exit_hours ?? 4.0;
  const coreFinalExitMinNet  = cfg.exit_core_final_exit_min_net_pct ?? 0.5;

  const hasTrim1          = firedTrims.includes('trim1');
  const hasTrim2          = firedTrims.includes('trim2');
  const hasPostTrimRunner = firedTrims.includes('post_trim_runner');
  const hasRunnerProtect  = firedTrims.includes('runner_protect');

  const hoursSinceUpdate = hoursSinceTimestamp(position.updated_at ?? position.updatedAt);

  if (!isCore) {
    return { core_final_exit_considered: false, core_final_exit_blocker: 'not_core', core_final_exit_would_fire: false, core_final_exit_in_exits: false };
  }
  if (!hasTrim1 || !hasTrim2 || !hasPostTrimRunner || !hasRunnerProtect) {
    const missing = [!hasTrim1 && 'trim1', !hasTrim2 && 'trim2', !hasPostTrimRunner && 'post_trim_runner', !hasRunnerProtect && 'runner_protect'].filter(Boolean).join(',');
    return { core_final_exit_considered: true, core_final_exit_blocker: `rungs_not_complete:missing=${missing}`, core_final_exit_would_fire: false, core_final_exit_in_exits: false };
  }
  if (hasFired) {
    return { core_final_exit_considered: true, core_final_exit_blocker: 'already_fired', core_final_exit_would_fire: false, core_final_exit_in_exits: coreFinalExitInExits };
  }
  if (hoursSinceUpdate == null) {
    return { core_final_exit_considered: true, core_final_exit_blocker: 'updated_at_unavailable', core_final_exit_would_fire: false, core_final_exit_in_exits: false };
  }
  if (hoursSinceUpdate < coreFinalExitHours) {
    return { core_final_exit_considered: true, core_final_exit_blocker: `wait:${hoursSinceUpdate.toFixed(1)}h<${coreFinalExitHours}h_since_last_fill`, core_final_exit_would_fire: false, core_final_exit_in_exits: false };
  }
  if (netGainPct == null) {
    return { core_final_exit_considered: true, core_final_exit_blocker: 'pnl_unavailable', core_final_exit_would_fire: false, core_final_exit_in_exits: false };
  }
  if (netGainPct < coreFinalExitMinNet) {
    return { core_final_exit_considered: true, core_final_exit_blocker: `below_min_net:${netGainPct.toFixed(2)}%<${coreFinalExitMinNet}%`, core_final_exit_would_fire: false, core_final_exit_in_exits: false };
  }
  return { core_final_exit_considered: true, core_final_exit_blocker: null, core_final_exit_would_fire: true, core_final_exit_in_exits: coreFinalExitInExits };
}

function getTacticalTimeStopDiagnostics(position, cfg, { netGainPct, firedTrims, exits, heldHours }) {
  const isTactical = position.strategy_tag === 'tactical';
  const alreadyFired = firedTrims.includes('tactical_time_stop');
  const threshold = cfg.exit_tactical_time_stop_hours ?? 72.0;
  const considered = isTactical && !alreadyFired;
  let blocker = null;
  if (!isTactical) blocker = 'not_tactical';
  else if (alreadyFired) blocker = 'tactical_time_stop_already_fired';
  else if (heldHours < threshold) blocker = `wait:${heldHours.toFixed(1)}h<${threshold}h_held`;
  else if (netGainPct < 0.1) blocker = 'below_net_gate';
  const wouldFire = considered && heldHours >= threshold && netGainPct >= 0.1;
  const fired = exits.some(e => e.trim === 'tactical_time_stop');
  return { considered, blocker, would_fire: wouldFire, fired };
}

function getTacticalFinalExitDiagnostics(position, cfg, { netGainPct, firedTrims, exits }) {
  const isTactical = position.strategy_tag === 'tactical';
  const alreadyFired = firedTrims.includes('tactical_final_exit');
  const hasAllRungs = ['trim1','trim2','post_trim_runner','runner_protect'].every(r => firedTrims.includes(r));
  const hoursSinceUpdate = hoursSinceTimestamp(position.updated_at ?? position.updatedAt);
  const threshold = cfg.exit_tactical_final_exit_hours ?? 4.0;
  const minNet = cfg.exit_tactical_final_exit_min_net_pct ?? 0.5;
  const considered = isTactical && !alreadyFired && hasAllRungs;
  let blocker = null;
  if (!isTactical) blocker = 'not_tactical';
  else if (alreadyFired) blocker = 'tactical_final_exit_already_fired';
  else if (!hasAllRungs) blocker = `rungs_not_complete:missing=${['trim1','trim2','post_trim_runner','runner_protect'].filter(r => !firedTrims.includes(r)).join(',')}`;
  else if (hoursSinceUpdate < threshold) blocker = `wait:${hoursSinceUpdate.toFixed(1)}h<${threshold}h_since_last_fill`;
  else if (netGainPct == null) blocker = 'pnl_unavailable';
  else if (netGainPct < minNet) blocker = `below_min_net:${netGainPct.toFixed(2)}%<${minNet}%`;
  const wouldFire = considered && hoursSinceUpdate >= threshold && netGainPct != null && netGainPct >= minNet;
  const fired = exits.some(e => e.trim === 'tactical_final_exit');
  return { considered, blocker, would_fire: wouldFire, fired };
}

/**
 * Compute the required minimum edge to make a sell worthwhile.
 * Uses runtime fee data when available.
 */
function requiredEdge(buyFeeRate, sellFeeRate, spreadEst = 0) {
  const fees = (buyFeeRate + sellFeeRate) * 100;
  return fees + spreadEst + SAFETY_BUFFER_PCT;
}

// ─── Starter entry evaluation ─────────────────────────────────────────────────

/**
 * Evaluate a small starter (rotation) entry.
 *
 * Called ONLY when:
 *   - There is NO existing open position for this asset
 *   - The full pullback signal (evaluateEntry) did NOT fire
 *
 * Allows the bot to open a small position in UPTREND or RANGE even when
 * BB %B and RSI pullback conditions are not met. The only filters are:
 *   - Regime must be UPTREND or RANGE (never DOWNTREND)
 *   - OB imbalance >= ob_imbalance_min (same execution quality gate)
 *   - RSI must be below starter_rsi_max (blocks extreme overbought)
 *   - starter_entry_enabled must not be false in bot_config
 *
 * Size = normal entry budget × starter_size_mult (default 0.25 = 25%).
 * Once open, the position follows the normal add-on and exit logic.
 *
 * RSI thresholds from the pullback path are intentionally NOT applied here.
 * This mode is about rotation frequency, not signal quality.
 */
function evaluateStarterEntry(asset, regime, ind, cfg, navKrw) {
  if (cfg.starter_entry_enabled === false) return null;

  const { regime: r } = regime;
  if (r === 'DOWNTREND') return null;

  const imbal = ind.obImbalance;
  const rsi14 = ind.rsi14;

  // Execution quality gate — uses a separate, looser threshold for starters so that
  // moderately sell-heavy books (between starter_ob_imbalance_min and ob_imbalance_min)
  // can still receive small probe entries. Falls back to ob_imbalance_min when the
  // starter-specific column is not set, which preserves the original behaviour.
  const obMin = cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45;
  if (imbal != null && imbal < obMin) return null;

  // Block extreme overbought only (not a tight RSI window)
  const rsiMaxStarter = cfg.starter_rsi_max ?? 70;
  if (rsi14 != null && rsi14 > rsiMaxStarter) return null;

  // Size: fraction of the normal regime entry budget
  // Mirrors the normalSizePct values in evaluateEntry (50% uptrend, 40% range)
  const maxRiskPct    = cfg.max_risk_per_signal_pct ?? 2;
  const normalSizePct = r === 'UPTREND' ? 50 : 40;
  const starterMult   = cfg.starter_size_mult ?? 0.25;
  const budgetKrw     = Math.max(0, navKrw * (maxRiskPct / 100) * (normalSizePct / 100) * starterMult);

  if (budgetKrw < 5000) return null; // below Upbit minimum

  return {
    asset,
    side:         'buy',
    krwAmount:    budgetKrw,
    reason:       `starter_entry_${r.toLowerCase()} (RSI=${rsi14?.toFixed(1)} OB=${imbal?.toFixed(3)})`,
    strategy_tag: 'tactical',
    sizePct:      +(normalSizePct * starterMult).toFixed(1),
    isStarter:    true,
    indicators: {
      rsi14:       rsi14?.toFixed(1),
      bbPctB:      ind.bbPctB?.toFixed(3),
      obImbalance: imbal?.toFixed(3),
      regime:      r,
    },
  };
}

/**
 * Cautious downtrend reclaim starter — BTC/ETH only, flat portfolio only.
 *
 * Fires when regime is DOWNTREND and price is showing a sane reclaim setup
 * (%B below threshold, RSI in a mid-oversold band) rather than requiring the
 * extreme conditions of evaluateEntry's downtrend path (RSI < 28 + vol spike).
 *
 * Size is intentionally smaller than a normal range/uptrend starter
 * (dt_reclaim_size_mult × 30% downtrend budget fraction × max_risk_per_signal_pct).
 *
 * Controlled entirely by config; disabled by default (dt_reclaim_starter_enabled = false).
 * Add-ons into existing positions in downtrend are never attempted via this path —
 * the caller (cryptoTraderV2) only invokes this when gatingPos is null.
 */
function evaluateDowntrendReclaimStarter(asset, regime, ind, cfg, navKrw) {
  if (asset === 'SOL') return null;
  if (cfg.dt_reclaim_starter_enabled !== true) return null;

  const { regime: r } = regime;
  if (r !== 'DOWNTREND') return null;

  const bbPct = ind.bbPctB;
  const rsi14 = ind.rsi14;
  const imbal = ind.obImbalance;

  // OB execution-quality gate (reuses starter threshold — looser than pullback gate)
  const obMin = cfg.starter_ob_imbalance_min ?? cfg.ob_imbalance_min ?? -0.45;
  if (imbal != null && imbal < obMin) return null;

  // BB reclaim: price must be in the lower portion of the band
  const bbMax = cfg.dt_reclaim_bb_max ?? 0.20;
  if (bbPct == null || bbPct >= bbMax) return null;

  // RSI sane reclaim band: not extreme oversold (signals capitulation, not reclaim)
  // and not mid-range (signals too much recovery, downtrend still dangerous)
  const rsiMin = cfg.dt_reclaim_rsi_min ?? 30.0;
  const rsiMax = cfg.dt_reclaim_rsi_max ?? 48.0;
  if (rsi14 == null || rsi14 < rsiMin || rsi14 > rsiMax) return null;

  // Size: dt_reclaim_size_mult × 30% (downtrend budget fraction) × max_risk_per_signal_pct,
  // floored at 5000 KRW (Upbit minimum) so small accounts can still place the order.
  const maxRiskPct   = cfg.max_risk_per_signal_pct ?? 2;
  const sizeMult     = cfg.dt_reclaim_size_mult ?? 0.15;
  const rawBudgetKrw = navKrw * (maxRiskPct / 100) * 0.30 * sizeMult;
  const budgetKrw    = Math.max(5000, rawBudgetKrw);

  return {
    asset,
    side:         'buy',
    krwAmount:    budgetKrw,
    reason:       `dt_reclaim_starter (RSI=${rsi14?.toFixed(1)} %B=${bbPct?.toFixed(3)} OB=${imbal?.toFixed(3)})`,
    strategy_tag: 'tactical',
    sizePct:      +(30 * sizeMult).toFixed(1),
    isStarter:    true,
    indicators: {
      rsi14:       rsi14?.toFixed(1),
      bbPctB:      bbPct?.toFixed(3),
      obImbalance: imbal?.toFixed(3),
      regime:      r,
    },
  };
}

module.exports = {
  computeIndicators,
  evaluateEntry,
  evaluateStarterEntry,
  evaluateDowntrendReclaimStarter,
  evaluateExit,
  isFullyProtected,
  isDowntrendReclaimStarterPosition,
  getReclaimHarvestDiagnostics,
  getTacticalProfitFloorDiagnostics,
  getPostTrimRunnerDiagnostics,
  getRunnerProtectDiagnostics,
  getCoreTimeStopDiagnostics,
  getCoreFinalExitDiagnostics,
  getTacticalTimeStopDiagnostics,
  getTacticalFinalExitDiagnostics,
  requiredEdge,
};
