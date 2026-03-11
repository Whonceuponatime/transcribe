/**
 * Generate BUY_NOW | SCALE_IN | WAIT. Scoring and allocation. No execution.
 */

const { computeFromBars } = require('./indicatorEngine');

const VALUATION = { CHEAP: 'CHEAP', FAIR: 'FAIR', EXPENSIVE: 'EXPENSIVE' };
const DECISION = { BUY_NOW: 'BUY_NOW', SCALE_IN: 'SCALE_IN', WAIT: 'WAIT' };

function getValuationLabel(levels) {
  const p = levels.percentile252;
  const z = levels.zscore20;
  if (p != null && p >= 0.70) return VALUATION.EXPENSIVE;
  if (z != null && z >= 1.0) return VALUATION.EXPENSIVE;
  if (levels.spot != null && levels.ma20 != null && levels.ma60 != null && p != null &&
      levels.spot < levels.ma20 && levels.spot < levels.ma60 && p <= 0.35) return VALUATION.CHEAP;
  if (p != null && z != null && p <= 0.15 && z <= -1.0) return VALUATION.CHEAP;
  return VALUATION.FAIR;
}

function computeScore(levels, context) {
  const { spot, ma20, ma60, zscore20, percentile252 } = levels;
  const {
    spreadAcceptable = true,
    quoteFresh = true,
    dollarWeak = false,
    vixCalm = true,
    nasdaqPositive = true,
    dataStale = false,
    spreadWide = false,
    dollarStrong = false,
    vixHigh = false,
    nasdaqNegative = false,
  } = context;

  let score = 0;
  if (percentile252 != null && percentile252 <= 0.15) score += 3;
  else if (percentile252 != null && percentile252 <= 0.35) score += 2;
  if (spot != null && ma20 != null && spot < ma20) score += 1;
  if (spot != null && ma60 != null && spot < ma60) score += 1;
  if (zscore20 != null && zscore20 <= -0.5) score += 1;
  if (zscore20 != null && zscore20 <= -1.0) score += 1;
  if (spreadAcceptable && quoteFresh) score += 1;
  if (dollarWeak) score += 1;
  if (vixCalm) score += 1;
  if (nasdaqPositive) score += 1;

  if (percentile252 != null && percentile252 >= 0.70) score -= 3;
  if (zscore20 != null && zscore20 >= 1.0) score -= 2;
  if (spreadWide) score -= 2;
  if (dataStale) score -= 2;
  if (dollarStrong) score -= 1;
  if (vixHigh) score -= 1;
  if (nasdaqNegative) score -= 1;

  return score;
}

function getDecision(score) {
  if (score >= 6) return DECISION.BUY_NOW;
  if (score >= 3) return DECISION.SCALE_IN;
  return DECISION.WAIT;
}

function getAllocationPct(decision, score, valuationLabel) {
  if (decision === DECISION.WAIT) return 0;
  if (decision === DECISION.BUY_NOW) {
    return (valuationLabel === VALUATION.CHEAP && score >= 7) ? 100 : 50;
  }
  return score >= 4 ? 50 : 25;
}

function getConfidence(score, context) {
  const { fallbackProvider, isStale, spreadWide, insufficientHistory } = context;
  let c = Math.min(100, Math.max(0, 50 + score * 8));
  if (fallbackProvider) c -= 10;
  if (isStale) c -= 15;
  if (spreadWide) c -= 10;
  if (insufficientHistory) c -= 10;
  return Math.round(Math.max(0, c));
}

function runSignal(levels, macro, context) {
  const valuation_label = getValuationLabel(levels);
  const score = computeScore(levels, context);
  const decision = getDecision(score);
  const allocation_pct = getAllocationPct(decision, score, valuation_label);
  const confidence = getConfidence(score, context);

  const why = [];
  if (valuation_label === VALUATION.CHEAP) why.push('USD/KRW cheap vs history');
  else if (valuation_label === VALUATION.EXPENSIVE) why.push('USD/KRW expensive vs history');
  else why.push('USD/KRW fair');
  if (context.dollarWeak) why.push('Broad dollar proxy weak (supportive)');
  if (context.dataStale) why.push('Data stale – reduced confidence');

  const red_flags = [];
  if (levels.percentile252 >= 0.70) red_flags.push('High percentile');
  if (context.spreadWide) red_flags.push('Wide spread');
  if (context.isStale) red_flags.push('Quote stale');
  if (context.fallbackProvider) red_flags.push('Using fallback provider');

  const next_trigger_to_watch = [];
  if (decision === DECISION.WAIT) next_trigger_to_watch.push('Wait for USD/KRW to cheapen or conditions to improve');
  if (decision === DECISION.SCALE_IN) next_trigger_to_watch.push('Consider another tranche if valuation improves');

  const summary =
    decision === DECISION.BUY_NOW
      ? `Valuation cheap; conditions supportive. Consider converting ${allocation_pct}% of KRW.`
      : decision === DECISION.SCALE_IN
        ? `Valuation mildly attractive. Consider scaling in ${allocation_pct}%.`
        : `Wait. ${valuation_label === VALUATION.EXPENSIVE ? 'USD/KRW is expensive.' : 'Signals not aligned.'}`;

  return {
    decision,
    allocation_pct,
    confidence,
    score,
    valuation_label,
    summary,
    why,
    red_flags,
    next_trigger_to_watch,
    levels: {
      spot: levels.spot,
      bid: levels.bid,
      ask: levels.ask,
      spread: levels.spread,
      ma20: levels.ma20,
      ma60: levels.ma60,
      ma120: levels.ma120,
      zscore20: levels.zscore20,
      percentile252: levels.percentile252,
    },
  };
}

module.exports = {
  runSignal,
  getValuationLabel,
  getDecision,
  computeScore,
  VALUATION,
  DECISION,
};
