/**
 * Technical indicators library — pure functions, no external dependencies.
 * All inputs are arrays of numbers (close prices or OHLCV), oldest first.
 */

// ─── Moving Averages ──────────────────────────────────────────────────────────

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k);
  }
  return val;
}

// ─── RSI (Wilder's smoothed) ─────────────────────────────────────────────────

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

function bollinger(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mean + multiplier * std,
    middle: mean,
    lower: mean - multiplier * std,
    std,
    pctB: std === 0 ? 0.5 : (closes[closes.length - 1] - (mean - multiplier * std)) / (2 * multiplier * std),
  };
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;

  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const e12 = ema(slice, fast);
    const e26 = ema(slice, slow);
    if (e12 != null && e26 != null) macdLine.push(e12 - e26);
  }

  const signalLine = ema(macdLine, signal);
  const macdVal = macdLine[macdLine.length - 1];
  const histogram = macdVal != null && signalLine != null ? macdVal - signalLine : null;
  const prevHistogram = macdLine.length >= 2 && signalLine != null
    ? macdLine[macdLine.length - 2] - signalLine : null;

  return {
    macd: macdVal,
    signal: signalLine,
    histogram,
    bullishCross: prevHistogram != null && prevHistogram < 0 && histogram > 0,
    bearishCross: prevHistogram != null && prevHistogram > 0 && histogram < 0,
  };
}

// ─── Volume analysis ──────────────────────────────────────────────────────────

function relativeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avgVol = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avgVol === 0) return null;
  return volumes[volumes.length - 1] / avgVol;
}

// ─── Stochastic RSI ───────────────────────────────────────────────────────────

function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14) {
  if (closes.length < rsiPeriod + stochPeriod + 1) return null;

  const rsiValues = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const r = rsi(slice, rsiPeriod);
    if (r != null) rsiValues.push(r);
  }

  if (rsiValues.length < stochPeriod) return null;

  const slice = rsiValues.slice(-stochPeriod);
  const minRsi = Math.min(...slice);
  const maxRsi = Math.max(...slice);
  if (maxRsi === minRsi) return 50;

  return ((rsiValues[rsiValues.length - 1] - minRsi) / (maxRsi - minRsi)) * 100;
}

// ─── 24h momentum ────────────────────────────────────────────────────────────

function momentum24h(candles) {
  if (!candles || candles.length < 2) return null;
  const current = candles[0].trade_price;
  const target = Date.now() - 24 * 60 * 60 * 1000;
  let best = candles[candles.length - 1];
  for (const c of candles) {
    if (Math.abs(new Date(c.candle_date_time_utc).getTime() - target) <
        Math.abs(new Date(best.candle_date_time_utc).getTime() - target)) {
      best = c;
    }
  }
  return (current - best.trade_price) / best.trade_price * 100;
}

// ─── VWAP (Volume Weighted Average Price) ────────────────────────────────────

/**
 * Calculates VWAP from Upbit candle objects.
 * candles: [{ high_price, low_price, trade_price (close), candle_acc_trade_volume }]
 */
function vwap(candles) {
  if (!candles || candles.length < 2) return null;
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  for (const c of candles) {
    const typical = (c.high_price + c.low_price + c.trade_price) / 3;
    const vol = c.candle_acc_trade_volume || 0;
    cumulativeTPV += typical * vol;
    cumulativeVol += vol;
  }
  return cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : null;
}

// ─── ATR (Average True Range) ─────────────────────────────────────────────────

/**
 * Measures volatility. Higher ATR = wider price swings.
 * candles: Upbit OHLCV objects with high_price, low_price, trade_price.
 */
function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high_price;
    const l = candles[i].low_price;
    const prevClose = candles[i - 1].trade_price;
    trueRanges.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  return sma(trueRanges, period);
}

// ─── Williams %R ─────────────────────────────────────────────────────────────

/**
 * Momentum oscillator, range: -100 (oversold) to 0 (overbought).
 * < -80: oversold (buy), > -20: overbought (sell)
 */
function williamsR(highs, lows, closes, period = 14) {
  if (!highs || !lows || closes.length < period) return null;
  const recentHighs = highs.slice(-period);
  const recentLows = lows.slice(-period);
  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const currentClose = closes[closes.length - 1];
  if (highestHigh === lowestLow) return -50;
  return ((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100;
}

// ─── CCI (Commodity Channel Index) ───────────────────────────────────────────

/**
 * Mean reversion indicator.
 * > +100: overbought (sell), < -100: oversold (buy)
 */
function cci(highs, lows, closes, period = 20) {
  if (!highs || !lows || closes.length < period) return null;
  const typicalPrices = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const slice = typicalPrices.slice(-period);
  const meanTP = slice.reduce((a, b) => a + b, 0) / period;
  const meanDeviation = slice.reduce((sum, tp) => sum + Math.abs(tp - meanTP), 0) / period;
  if (meanDeviation === 0) return 0;
  return (typicalPrices[typicalPrices.length - 1] - meanTP) / (0.015 * meanDeviation);
}

// ─── OBV Trend (On Balance Volume) ───────────────────────────────────────────

/**
 * Returns positive slope = accumulation (bullish), negative = distribution (bearish).
 */
function obvTrend(closes, volumes, period = 10) {
  if (closes.length < 2 || volumes.length < 2) return null;
  const obvValues = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obvValues.push(obvValues[i - 1] + (volumes[i] || 0));
    else if (closes[i] < closes[i - 1]) obvValues.push(obvValues[i - 1] - (volumes[i] || 0));
    else obvValues.push(obvValues[i - 1]);
  }
  const recentObv = obvValues.slice(-period);
  return recentObv[recentObv.length - 1] - recentObv[0];
}

// ─── ROC (Rate of Change) ─────────────────────────────────────────────────────

/**
 * Returns % price change over `period` bars.
 * Negative ROC = dip (potential buy). Extreme positive = pump (potential sell).
 */
function roc(closes, period = 9) {
  if (closes.length < period + 1) return null;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  if (past === 0) return null;
  return (current - past) / past * 100;
}

// ─── Composite signal score ───────────────────────────────────────────────────

/**
 * Full multi-indicator composite score for a coin.
 * score > 0 = bullish (buy), score < 0 = bearish (sell)
 *
 * extras: { highs, lows, orderBookImbalance (0-1), kimchiPremium (%) }
 */
function compositeSignal(closes, volumes, candles4h, extras = {}) {
  const signals = [];
  const { highs, lows, orderBookImbalance, kimchiPremium } = extras;

  const rsi14      = rsi(closes, 14);
  const rsi7       = rsi(closes, 7);
  const bb         = bollinger(closes, 20, 2);
  const macdData   = macd(closes, 12, 26, 9);
  const stochRsi14 = stochRsi(closes, 14, 14);
  const relVol     = relativeVolume(volumes, 20);
  const mom24      = candles4h ? momentum24h(candles4h) : null;
  const ma20       = sma(closes, 20);
  const ma50       = sma(closes, 50);
  const ma200      = sma(closes, 200);
  const currentPrice = closes[closes.length - 1];

  // VWAP from 4h candles
  const vwapVal      = candles4h ? vwap(candles4h) : null;
  const vwapDev      = vwapVal ? (currentPrice - vwapVal) / vwapVal * 100 : null;

  // ATR (volatility context)
  const atrVal    = candles4h ? atr(candles4h, 14) : null;
  const atrPct    = atrVal && currentPrice ? atrVal / currentPrice * 100 : null;

  // Williams %R
  const wR        = highs && lows ? williamsR(highs, lows, closes, 14) : null;

  // CCI
  const cciVal    = highs && lows ? cci(highs, lows, closes, 20) : null;

  // OBV trend
  const obvSlope  = obvTrend(closes, volumes, 10);

  // ROC
  const roc9      = roc(closes, 9);

  // ── RSI signals ─────────────────────────────────────────────────────────────
  if (rsi14 != null) {
    if      (rsi14 < 25) signals.push({ name: 'RSI_OVERSOLD_STRONG',   score: +3, value: rsi14.toFixed(1) });
    else if (rsi14 < 35) signals.push({ name: 'RSI_OVERSOLD',          score: +2, value: rsi14.toFixed(1) });
    else if (rsi14 > 80) signals.push({ name: 'RSI_OVERBOUGHT_STRONG', score: -3, value: rsi14.toFixed(1) });
    else if (rsi14 > 70) signals.push({ name: 'RSI_OVERBOUGHT',        score: -2, value: rsi14.toFixed(1) });
    else                 signals.push({ name: 'RSI_NEUTRAL',            score:  0, value: rsi14.toFixed(1) });
  }

  // Fast RSI (7-period) for extra responsiveness
  if (rsi7 != null) {
    if      (rsi7 < 20) signals.push({ name: 'RSI7_EXTREME_OS', score: +2, value: rsi7.toFixed(1) });
    else if (rsi7 > 80) signals.push({ name: 'RSI7_EXTREME_OB', score: -2, value: rsi7.toFixed(1) });
  }

  // ── Bollinger Bands ──────────────────────────────────────────────────────────
  if (bb != null) {
    if      (bb.pctB < 0)    signals.push({ name: 'BB_BELOW_LOWER', score: +3, value: bb.pctB.toFixed(2) });
    else if (bb.pctB < 0.1)  signals.push({ name: 'BB_NEAR_LOWER',  score: +1, value: bb.pctB.toFixed(2) });
    else if (bb.pctB > 1)    signals.push({ name: 'BB_ABOVE_UPPER', score: -3, value: bb.pctB.toFixed(2) });
    else if (bb.pctB > 0.9)  signals.push({ name: 'BB_NEAR_UPPER',  score: -1, value: bb.pctB.toFixed(2) });
  }

  // ── MACD ─────────────────────────────────────────────────────────────────────
  if (macdData) {
    if      (macdData.bullishCross)    signals.push({ name: 'MACD_BULL_CROSS', score: +2, value: macdData.histogram?.toFixed(0) });
    else if (macdData.bearishCross)    signals.push({ name: 'MACD_BEAR_CROSS', score: -2, value: macdData.histogram?.toFixed(0) });
    else if (macdData.histogram > 0)   signals.push({ name: 'MACD_BULL',       score: +1 });
    else if (macdData.histogram < 0)   signals.push({ name: 'MACD_BEAR',       score: -1 });
  }

  // ── Stochastic RSI ───────────────────────────────────────────────────────────
  if (stochRsi14 != null) {
    if      (stochRsi14 < 15) signals.push({ name: 'STOCH_RSI_OVERSOLD',   score: +2, value: stochRsi14.toFixed(1) });
    else if (stochRsi14 > 85) signals.push({ name: 'STOCH_RSI_OVERBOUGHT', score: -2, value: stochRsi14.toFixed(1) });
  }

  // ── Moving averages ───────────────────────────────────────────────────────────
  if (ma20 != null && ma50 != null) {
    if      (ma20 > ma50 && currentPrice > ma20) signals.push({ name: 'MA_UPTREND',   score: +1 });
    else if (ma20 < ma50 && currentPrice < ma20) signals.push({ name: 'MA_DOWNTREND', score: -1 });
  }
  if (ma50 != null && ma200 != null) {
    if      (ma50 > ma200) signals.push({ name: 'GOLDEN_CROSS', score: +1 });
    else                   signals.push({ name: 'DEATH_CROSS',  score: -1 });
  }

  // ── VWAP deviation ───────────────────────────────────────────────────────────
  if (vwapDev != null) {
    if      (vwapDev < -4) signals.push({ name: 'VWAP_DEEP_BELOW', score: +3, value: `${vwapDev.toFixed(1)}%` });
    else if (vwapDev < -2) signals.push({ name: 'VWAP_BELOW',      score: +2, value: `${vwapDev.toFixed(1)}%` });
    else if (vwapDev < -1) signals.push({ name: 'VWAP_SLIGHTLY_BELOW', score: +1, value: `${vwapDev.toFixed(1)}%` });
    else if (vwapDev > 4)  signals.push({ name: 'VWAP_DEEP_ABOVE', score: -3, value: `${vwapDev.toFixed(1)}%` });
    else if (vwapDev > 2)  signals.push({ name: 'VWAP_ABOVE',      score: -2, value: `${vwapDev.toFixed(1)}%` });
    else if (vwapDev > 1)  signals.push({ name: 'VWAP_SLIGHTLY_ABOVE', score: -1, value: `${vwapDev.toFixed(1)}%` });
  }

  // ── Williams %R ──────────────────────────────────────────────────────────────
  if (wR != null) {
    if      (wR < -90) signals.push({ name: 'WILLIAMS_R_DEEP_OS', score: +2, value: wR.toFixed(1) });
    else if (wR < -80) signals.push({ name: 'WILLIAMS_R_OVERSOLD', score: +1, value: wR.toFixed(1) });
    else if (wR > -10) signals.push({ name: 'WILLIAMS_R_DEEP_OB', score: -2, value: wR.toFixed(1) });
    else if (wR > -20) signals.push({ name: 'WILLIAMS_R_OVERBOUGHT', score: -1, value: wR.toFixed(1) });
  }

  // ── CCI ───────────────────────────────────────────────────────────────────────
  if (cciVal != null) {
    if      (cciVal < -150) signals.push({ name: 'CCI_DEEP_OS',    score: +2, value: cciVal.toFixed(0) });
    else if (cciVal < -100) signals.push({ name: 'CCI_OVERSOLD',   score: +1, value: cciVal.toFixed(0) });
    else if (cciVal > 150)  signals.push({ name: 'CCI_DEEP_OB',    score: -2, value: cciVal.toFixed(0) });
    else if (cciVal > 100)  signals.push({ name: 'CCI_OVERBOUGHT', score: -1, value: cciVal.toFixed(0) });
  }

  // ── OBV trend ─────────────────────────────────────────────────────────────────
  if (obvSlope != null) {
    if      (obvSlope > 0)  signals.push({ name: 'OBV_ACCUMULATION', score: +1 });
    else if (obvSlope < 0)  signals.push({ name: 'OBV_DISTRIBUTION', score: -1 });
  }

  // ── ROC momentum ──────────────────────────────────────────────────────────────
  if (roc9 != null) {
    if      (roc9 < -6)  signals.push({ name: 'ROC_SHARP_DIP',  score: +2, value: `${roc9.toFixed(1)}%` });
    else if (roc9 < -3)  signals.push({ name: 'ROC_DIP',        score: +1, value: `${roc9.toFixed(1)}%` });
    else if (roc9 >  8)  signals.push({ name: 'ROC_SHARP_PUMP', score: -2, value: `${roc9.toFixed(1)}%` });
    else if (roc9 >  4)  signals.push({ name: 'ROC_PUMP',       score: -1, value: `${roc9.toFixed(1)}%` });
  }

  // ── Order book imbalance (0–1; >0.6 = bid-heavy = buy pressure) ──────────────
  if (orderBookImbalance != null) {
    if      (orderBookImbalance > 0.65) signals.push({ name: 'OB_BUY_PRESSURE',  score: +2, value: `${(orderBookImbalance * 100).toFixed(0)}%` });
    else if (orderBookImbalance > 0.55) signals.push({ name: 'OB_SLIGHT_BUY',   score: +1, value: `${(orderBookImbalance * 100).toFixed(0)}%` });
    else if (orderBookImbalance < 0.35) signals.push({ name: 'OB_SELL_PRESSURE', score: -2, value: `${(orderBookImbalance * 100).toFixed(0)}%` });
    else if (orderBookImbalance < 0.45) signals.push({ name: 'OB_SLIGHT_SELL',  score: -1, value: `${(orderBookImbalance * 100).toFixed(0)}%` });
  }

  // ── Kimchi premium (Upbit KRW price vs global price × USD/KRW) ───────────────
  // High premium = Korean market overheated = sell signal
  // Low/negative = discount on Korean market = buy signal
  if (kimchiPremium != null) {
    if      (kimchiPremium > 5)  signals.push({ name: 'KIMCHI_EXTREME',  score: -3, value: `${kimchiPremium.toFixed(1)}%` });
    else if (kimchiPremium > 3)  signals.push({ name: 'KIMCHI_HIGH',     score: -2, value: `${kimchiPremium.toFixed(1)}%` });
    else if (kimchiPremium > 1)  signals.push({ name: 'KIMCHI_MODERATE', score: -1, value: `${kimchiPremium.toFixed(1)}%` });
    else if (kimchiPremium < -2) signals.push({ name: 'KIMCHI_NEGATIVE', score: +2, value: `${kimchiPremium.toFixed(1)}%` });
    else if (kimchiPremium < 0)  signals.push({ name: 'KIMCHI_LOW',      score: +1, value: `${kimchiPremium.toFixed(1)}%` });
  }

  // ── Volume confirmation (amplifies direction) ─────────────────────────────────
  if (relVol != null && relVol > 1.8) {
    const currentScore = signals.reduce((s, sig) => s + sig.score, 0);
    signals.push({ name: 'HIGH_VOLUME', score: currentScore > 0 ? +1 : currentScore < 0 ? -1 : 0, value: relVol.toFixed(2) });
  }

  // ── 24h momentum ─────────────────────────────────────────────────────────────
  if (mom24 != null) {
    if      (mom24 < -10) signals.push({ name: 'SHARP_DROP_24H', score: +3, value: `${mom24.toFixed(1)}%` });
    else if (mom24 < -5)  signals.push({ name: 'DROP_24H',       score: +2, value: `${mom24.toFixed(1)}%` });
    else if (mom24 >  10) signals.push({ name: 'SHARP_PUMP_24H', score: -2, value: `${mom24.toFixed(1)}%` });
    else if (mom24 >  5)  signals.push({ name: 'PUMP_24H',       score: -1, value: `${mom24.toFixed(1)}%` });
  }

  const totalScore = signals.reduce((s, sig) => s + sig.score, 0);
  return {
    score: totalScore,
    signals,
    rsi: rsi14,
    rsi7,
    bb,
    macd: macdData,
    stochRsi: stochRsi14,
    relVol,
    ma20,
    ma50,
    ma200,
    vwap: vwapVal,
    vwapDev,
    atr: atrVal,
    atrPct,
    williamsR: wR,
    cci: cciVal,
    obvSlope,
    roc: roc9,
    orderBookImbalance,
    kimchiPremium,
    currentPrice,
  };
}

module.exports = {
  sma, ema, rsi, bollinger, macd, stochRsi,
  relativeVolume, momentum24h,
  vwap, atr, williamsR, cci, obvTrend, roc,
  compositeSignal,
};
