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
    // Position of current price relative to bands: -1 = at/below lower, 0 = middle, 1 = at/above upper
    pctB: std === 0 ? 0.5 : (closes[closes.length - 1] - (mean - multiplier * std)) / (2 * multiplier * std),
  };
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;

  // Calculate MACD line at each point from 'slow' onwards
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
    // Crossover detection
    bullishCross: prevHistogram != null && prevHistogram < 0 && histogram > 0,
    bearishCross: prevHistogram != null && prevHistogram > 0 && histogram < 0,
  };
}

// ─── Volume analysis ──────────────────────────────────────────────────────────

function relativeVolume(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avgVol = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  if (avgVol === 0) return null;
  return volumes[volumes.length - 1] / avgVol; // > 1.5 = high volume
}

// ─── Stochastic RSI ───────────────────────────────────────────────────────────

function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14) {
  if (closes.length < rsiPeriod + stochPeriod + 1) return null;

  // Build RSI array over rolling windows
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
  // candles: array of { trade_price, candle_date_time_utc }
  if (!candles || candles.length < 2) return null;
  const current = candles[0].trade_price;
  // Find candle closest to 24h ago
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

// ─── Composite signal score ───────────────────────────────────────────────────

/**
 * Returns a composite signal for a coin.
 * score > 0 = bullish, score < 0 = bearish
 * Signals: RSI, Bollinger, MACD, Stoch RSI, Volume, Momentum
 */
function compositeSignal(closes, volumes, candles4h) {
  const signals = [];

  const rsi14 = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const macdData = macd(closes, 12, 26, 9);
  const stochRsi14 = stochRsi(closes, 14, 14);
  const relVol = relativeVolume(volumes, 20);
  const mom24 = candles4h ? momentum24h(candles4h) : null;
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const currentPrice = closes[closes.length - 1];

  // RSI signals
  if (rsi14 != null) {
    if (rsi14 < 25)      signals.push({ name: 'RSI_OVERSOLD_STRONG', score: +3, value: rsi14.toFixed(1) });
    else if (rsi14 < 35) signals.push({ name: 'RSI_OVERSOLD', score: +2, value: rsi14.toFixed(1) });
    else if (rsi14 > 80) signals.push({ name: 'RSI_OVERBOUGHT_STRONG', score: -3, value: rsi14.toFixed(1) });
    else if (rsi14 > 70) signals.push({ name: 'RSI_OVERBOUGHT', score: -2, value: rsi14.toFixed(1) });
    else                 signals.push({ name: 'RSI_NEUTRAL', score: 0, value: rsi14.toFixed(1) });
  }

  // Bollinger signals
  if (bb != null) {
    if (bb.pctB < 0)     signals.push({ name: 'BB_BELOW_LOWER', score: +3, value: bb.pctB.toFixed(2) });
    else if (bb.pctB < 0.1) signals.push({ name: 'BB_NEAR_LOWER', score: +1, value: bb.pctB.toFixed(2) });
    else if (bb.pctB > 1)   signals.push({ name: 'BB_ABOVE_UPPER', score: -3, value: bb.pctB.toFixed(2) });
    else if (bb.pctB > 0.9) signals.push({ name: 'BB_NEAR_UPPER', score: -1, value: bb.pctB.toFixed(2) });
  }

  // MACD signals
  if (macdData) {
    if (macdData.bullishCross) signals.push({ name: 'MACD_BULL_CROSS', score: +2, value: macdData.histogram?.toFixed(0) });
    else if (macdData.bearishCross) signals.push({ name: 'MACD_BEAR_CROSS', score: -2, value: macdData.histogram?.toFixed(0) });
    else if (macdData.histogram > 0) signals.push({ name: 'MACD_BULL', score: +1 });
    else if (macdData.histogram < 0) signals.push({ name: 'MACD_BEAR', score: -1 });
  }

  // Stochastic RSI
  if (stochRsi14 != null) {
    if (stochRsi14 < 20) signals.push({ name: 'STOCH_RSI_OVERSOLD', score: +2, value: stochRsi14.toFixed(1) });
    else if (stochRsi14 > 80) signals.push({ name: 'STOCH_RSI_OVERBOUGHT', score: -2, value: stochRsi14.toFixed(1) });
  }

  // Moving average trend
  if (ma20 != null && ma50 != null) {
    if (ma20 > ma50 && currentPrice > ma20) signals.push({ name: 'MA_UPTREND', score: +1 });
    else if (ma20 < ma50 && currentPrice < ma20) signals.push({ name: 'MA_DOWNTREND', score: -1 });
  }

  // Volume confirmation
  if (relVol != null && relVol > 1.8) {
    const lastScore = signals.reduce((s, sig) => s + sig.score, 0);
    // High volume amplifies the direction
    signals.push({ name: 'HIGH_VOLUME', score: lastScore > 0 ? +1 : lastScore < 0 ? -1 : 0, value: relVol.toFixed(2) });
  }

  // 24h momentum
  if (mom24 != null) {
    if (mom24 < -8)      signals.push({ name: 'SHARP_DROP_24H', score: +2, value: `${mom24.toFixed(1)}%` });
    else if (mom24 > 8)  signals.push({ name: 'SHARP_PUMP_24H', score: -1, value: `${mom24.toFixed(1)}%` });
  }

  const totalScore = signals.reduce((s, sig) => s + sig.score, 0);
  return {
    score: totalScore,
    signals,
    rsi: rsi14,
    bb,
    macd: macdData,
    stochRsi: stochRsi14,
    relVol,
    ma20,
    ma50,
    currentPrice,
  };
}

module.exports = { sma, ema, rsi, bollinger, macd, stochRsi, relativeVolume, momentum24h, compositeSignal };
