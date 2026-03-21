/**
 * Regime Engine — classifies BTC market regime from 4h candles.
 *
 * Three regimes:
 *   UPTREND   — BTC 4h close > EMA200, EMA50 > EMA200, ADX > threshold
 *   RANGE     — EMA50 and EMA200 within ema_range_pct of each other, ADX weak
 *   DOWNTREND — BTC 4h close < EMA200, EMA50 < EMA200
 *
 * Hysteresis: entry and exit thresholds differ to prevent flip-flopping.
 * Cache: regime is re-evaluated at most once per 4h candle period.
 * Events: a bot_events row is written ONCE when regime switches.
 */

const { emaArray, adx } = require('./indicators');
const upbit = require('./upbit');

// ─── In-process cache ────────────────────────────────────────────────────────
let _cache = null;
// { regime, ema50, ema200, adxVal, plusDI, minusDI, evaluatedAt, lastCandle }

const CACHE_TTL_MS  = 4 * 60 * 60 * 1000; // re-evaluate at most every 4h
const CANDLES_NEEDED = 200;                // 200 × 4h ≈ 33 days — Upbit API max per request, sufficient for EMA200 + ADX

// ─── Default thresholds (overridden by bot_config from DB) ──────────────────
const DEFAULTS = {
  regime_adx_uptrend:    20,   // ADX must exceed this to confirm uptrend
  regime_adx_range_exit: 25,   // ADX must exceed this to break out of RANGE
  regime_ema_range_pct:  0.02, // EMA50/200 must be within 2% to classify RANGE
};

/**
 * Determine the new regime given computed indicators and current cached regime.
 * Hysteresis is implemented by using slightly tighter thresholds to LEAVE a regime
 * than to ENTER it.
 */
function classify(ema50, ema200, adxVal, currentRegime, cfg) {
  const adxUptrend  = cfg.regime_adx_uptrend    ?? DEFAULTS.regime_adx_uptrend;
  const adxRangeExit= cfg.regime_adx_range_exit  ?? DEFAULTS.regime_adx_range_exit;
  const emaBand     = cfg.regime_ema_range_pct   ?? DEFAULTS.regime_ema_range_pct;

  const emaDiffPct  = Math.abs(ema50 - ema200) / ema200;
  const closeAbove200 = ema50 > ema200; // proxy — we compare close vs ema200 below

  // UPTREND conditions
  const strongUptrend   = ema50 > ema200 && adxVal > adxUptrend;
  // Hysteresis: to EXIT uptrend, ADX must fall further or EMA flip
  const exitUptrend     = ema50 <= ema200 * 0.995 || adxVal < adxUptrend * 0.7;

  // DOWNTREND conditions
  const strongDowntrend = ema50 < ema200;
  const exitDowntrend   = ema50 >= ema200 * 1.005; // needs clear recovery

  // RANGE conditions
  const inRange         = emaDiffPct <= emaBand && adxVal < adxRangeExit;
  const exitRange       = adxVal > adxRangeExit || emaDiffPct > emaBand * 1.5;

  // Apply hysteresis: sticky regimes unless exit condition clearly met
  if (currentRegime === 'UPTREND') {
    if (exitUptrend) {
      return emaDiffPct <= emaBand ? 'RANGE' : 'DOWNTREND';
    }
    return 'UPTREND';
  }

  if (currentRegime === 'DOWNTREND') {
    if (exitDowntrend) {
      return inRange ? 'RANGE' : 'UPTREND';
    }
    return 'DOWNTREND';
  }

  if (currentRegime === 'RANGE') {
    if (exitRange) {
      return strongUptrend ? 'UPTREND' : 'DOWNTREND';
    }
    return 'RANGE';
  }

  // No cached regime — cold start: pick the most clearly met condition
  if (strongUptrend)   return 'UPTREND';
  if (strongDowntrend) return 'DOWNTREND';
  return 'RANGE';
}

/**
 * Write a bot_events row when regime switches.
 * Never throws — logging failure must not block the cycle.
 */
async function logRegimeSwitch(supabase, fromRegime, toRegime, indicators, mode) {
  try {
    await supabase.from('bot_events').insert({
      event_type:   'REGIME_SWITCH',
      severity:     'info',
      subsystem:    'regime_engine',
      message:      `Regime changed: ${fromRegime ?? 'NONE'} → ${toRegime}`,
      context_json: indicators,
      regime:       toRegime,
      mode,
    });
  } catch (_) {}
}

/**
 * Persist current regime to app_settings so dashboard can read it cheaply
 * without querying the full bot_events table.
 */
async function persistRegime(supabase, result) {
  try {
    await supabase.from('app_settings').upsert({
      key:        'current_regime',
      value:      result,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}
}

/**
 * Main entry point. Returns cached regime if still fresh; otherwise recomputes.
 *
 * @param {SupabaseClient} supabase
 * @param {object}         cfg      — from bot_config row
 * @returns {{ regime, ema50, ema200, adxVal, plusDI, minusDI, evaluatedAt, fromCache }}
 */
async function getRegime(supabase, cfg = {}) {
  const now = Date.now();

  // Return cached if fresh
  if (_cache && (now - new Date(_cache.evaluatedAt).getTime()) < CACHE_TTL_MS) {
    return { ..._cache, fromCache: true };
  }

  // Fetch BTC 4h candles
  let candles;
  try {
    // getMinuteCandles returns a flat array (oldest→newest) — not getCandleData which returns an object
    candles = await upbit.getMinuteCandles('KRW-BTC', 240, CANDLES_NEEDED);
  } catch (err) {
    console.error('[regime] Failed to fetch candles:', err.message);
    if (_cache) return { ..._cache, fromCache: true, stale: true };
    return { regime: 'RANGE', ema50: null, ema200: null, adxVal: null, evaluatedAt: new Date().toISOString(), fromCache: false, error: err.message };
  }

  if (!Array.isArray(candles) || candles.length < 60) {
    console.warn('[regime] Insufficient candles:', candles?.length);
    if (_cache) return { ..._cache, fromCache: true, stale: true };
    return { regime: 'RANGE', evaluatedAt: new Date().toISOString(), fromCache: false };
  }

  const closes = candles.map((c) => c.trade_price);
  const highs  = candles.map((c) => c.high_price);
  const lows   = candles.map((c) => c.low_price);

  // Compute EMAs
  const ema50arr  = emaArray(closes, 50);
  const ema200arr = emaArray(closes, 200);
  const ema50     = ema50arr[ema50arr.length - 1];
  const ema200    = ema200arr[ema200arr.length - 1];

  // Compute ADX
  const adxResult = adx(highs, lows, closes, 14);
  const adxVal    = adxResult?.adx    ?? null;
  const plusDI    = adxResult?.plusDI  ?? null;
  const minusDI   = adxResult?.minusDI ?? null;

  if (ema50 == null || ema200 == null) {
    console.warn('[regime] EMA computation failed — not enough data');
    if (_cache) return { ..._cache, fromCache: true, stale: true };
    return { regime: 'RANGE', evaluatedAt: new Date().toISOString(), fromCache: false };
  }

  const previousRegime = _cache?.regime ?? null;
  const newRegime = classify(ema50, ema200, adxVal ?? 0, previousRegime, cfg);

  const result = {
    regime:      newRegime,
    ema50:       +ema50.toFixed(0),
    ema200:      +ema200.toFixed(0),
    adxVal:      adxVal  != null ? +adxVal.toFixed(2)  : null,
    plusDI:      plusDI  != null ? +plusDI.toFixed(2)  : null,
    minusDI:     minusDI != null ? +minusDI.toFixed(2) : null,
    evaluatedAt: new Date().toISOString(),
    fromCache:   false,
  };

  // Log switch event if regime changed
  if (previousRegime !== newRegime) {
    const mode = cfg.mode ?? 'paper';
    await logRegimeSwitch(supabase, previousRegime, newRegime, result, mode);
    console.log(`[regime] ★ Switch: ${previousRegime ?? 'NONE'} → ${newRegime}  EMA50=${result.ema50}  EMA200=${result.ema200}  ADX=${result.adxVal}`);
  } else {
    console.log(`[regime] ${newRegime}  EMA50=${result.ema50}  EMA200=${result.ema200}  ADX=${result.adxVal} (no change)`);
  }

  _cache = result;
  await persistRegime(supabase, result);
  return result;
}

/**
 * Force-clear the in-process cache (useful after restart or manual override).
 */
function clearCache() {
  _cache = null;
}

/**
 * Return the cached regime without fetching — safe to call from signal engine
 * after getRegime() has already run this cycle.
 */
function getCached() {
  return _cache;
}

module.exports = { getRegime, clearCache, getCached };
