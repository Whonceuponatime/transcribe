/**
 * Rules-based signal engine: BUY_NOW | SCALE_IN | WAIT | BLOCKED_BY_RISK.
 * Primary: live USD/KRW vs rolling MAs and percentile. Secondary: broad USD, volatility, trend.
 * No martingale, no leverage. Prefer partial buys when mixed.
 */

const DECISION = Object.freeze({ BUY_NOW: 'BUY_NOW', SCALE_IN: 'SCALE_IN', WAIT: 'WAIT', BLOCKED_BY_RISK: 'BLOCKED_BY_RISK' });

function ma(values, period) {
  if (!values.length || period < 1) return null;
  const slice = values.slice(-period).filter((v) => v != null && !Number.isNaN(v));
  if (!slice.length) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function percentileRank(sortedValues, value) {
  if (!sortedValues.length) return null;
  const below = sortedValues.filter((v) => v <= value).length;
  return below / sortedValues.length;
}

function computeFromBars(bars1m, bars1d) {
  const closes1m = (bars1m || []).map((b) => b.close);
  const closes1d = (bars1d || []).map((b) => b.close);
  const lastClose = closes1m.length ? closes1m[closes1m.length - 1] : (closes1d.length ? closes1d[closes1d.length - 1] : null);
  if (lastClose == null) return null;

  const ma20_1m = ma(closes1m, 20);
  const ma60_1m = ma(closes1m, 60);
  const ma120_1m = ma(closes1m, 120);
  const ma20_1d = ma(closes1d, 20);
  const ma60_1d = ma(closes1d, 60);
  const sorted252 = closes1d.slice(-252).filter((v) => v != null).sort((a, b) => a - b);
  const percentile = percentileRank(sorted252, lastClose);

  let score = 0;
  const reasons = [];
  if (percentile != null && percentile <= 0.15) { score += 3; reasons.push('percentile_252 <= 0.15'); }
  else if (percentile != null && percentile <= 0.35) { score += 2; reasons.push('percentile_252 <= 0.35'); }
  if (ma20_1m != null && lastClose < ma20_1m) { score += 1; reasons.push('spot < ma20'); }
  if (ma60_1m != null && lastClose < ma60_1m) { score += 1; reasons.push('spot < ma60'); }
  if (percentile != null && percentile >= 0.70) { score -= 3; reasons.push('percentile_252 >= 0.70'); }

  let decision = DECISION.WAIT;
  let allocationPct = 0;
  if (score >= 6) {
    decision = DECISION.BUY_NOW;
    allocationPct = (percentile != null && percentile <= 0.15) ? 100 : 50;
  } else if (score >= 3) {
    decision = DECISION.SCALE_IN;
    allocationPct = score >= 4 ? 50 : 25;
  }

  const confidence = Math.min(100, Math.max(0, 50 + score * 8));

  return {
    lastClose,
    ma20_1m,
    ma60_1m,
    ma120_1m,
    ma20_1d,
    ma60_1d,
    percentile_252: percentile,
    score,
    decision,
    allocation_pct: allocationPct,
    confidence,
    reasons,
    safeguards: [],
  };
}

function runSignal(quote, bars1m, bars1d, safetyBlocked = false) {
  if (safetyBlocked) {
    return {
      decision: DECISION.BLOCKED_BY_RISK,
      allocation_pct: 0,
      confidence: 0,
      score: 0,
      reasons: [],
      safeguards: ['blocked_by_risk'],
      snapshot: { quote, safetyBlocked: true },
    };
  }

  const computed = computeFromBars(bars1m, bars1d);
  if (!computed) {
    return {
      decision: DECISION.WAIT,
      allocation_pct: 0,
      confidence: 0,
      score: 0,
      reasons: ['insufficient_data'],
      safeguards: [],
      snapshot: { quote },
    };
  }

  const mid = quote?.mid ?? quote?.close ?? computed.lastClose;
  return {
    ...computed,
    snapshot: {
      quote: { bid: quote?.bid, ask: quote?.ask, mid, spread: quote?.spread },
      ...computed,
    },
  };
}

module.exports = {
  runSignal,
  computeFromBars,
  DECISION,
};
