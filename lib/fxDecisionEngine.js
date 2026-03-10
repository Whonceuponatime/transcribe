/**
 * Rules-based FX advisor: BUY_NOW | SCALE_IN | WAIT.
 * Primary trigger = USD/KRW valuation; secondary = broad dollar; filters = VIX, Nasdaq, Korea equity proxy; macro = rate spread.
 */

const VALUATION = Object.freeze({ CHEAP: 'CHEAP', FAIR: 'FAIR', EXPENSIVE: 'EXPENSIVE' });
const DECISION = Object.freeze({ BUY_NOW: 'BUY_NOW', SCALE_IN: 'SCALE_IN', WAIT: 'WAIT' });

function getValuationLabel(row) {
  const p = row.usdkrw_percentile_252;
  const z = row.usdkrw_zscore_20;
  const spot = row.usdkrw_spot;
  const ma20 = row.usdkrw_ma20;
  const ma60 = row.usdkrw_ma60;

  if (p != null && z != null && p >= 0.70) return VALUATION.EXPENSIVE;
  if (z != null && z >= 1.0) return VALUATION.EXPENSIVE;

  if (spot != null && ma20 != null && ma60 != null && p != null && spot < ma20 && spot < ma60 && p <= 0.35)
    return VALUATION.CHEAP;
  if (p != null && z != null && p <= 0.15 && z <= -1.0) return VALUATION.CHEAP;

  return VALUATION.FAIR;
}

function isDollarSupportive(row) {
  const broad = row.usd_broad_index_proxy;
  const ma20 = row.usd_broad_index_proxy_ma20;
  const z = row.usd_broad_index_proxy_zscore_20;
  if (broad == null) return false;
  if (ma20 != null && broad < ma20) return true;
  if (z != null && z <= -0.5) return true;
  return false;
}

function isDollarStronglySupportive(row) {
  const z = row.usd_broad_index_proxy_zscore_20;
  return z != null && z <= -1.0;
}

function isRiskPositive(row) {
  const vix = row.vix;
  const vixCh = row.vix_change_5d;
  const ndx = row.nasdaq100_return_20d;
  const korea = row.korea_equity_proxy_return_20d;
  if (vix == null) return false;
  if (vix >= 22) return false;
  if (vixCh != null && vixCh > 0) return false;
  if (ndx != null && ndx < 0) return false;
  if (korea != null && korea < 0) return false;
  return true;
}

function isRiskNegative(row) {
  const vix = row.vix;
  const ndx = row.nasdaq100_return_20d;
  const korea = row.korea_equity_proxy_return_20d;
  if (vix != null && vix > 25) return true;
  if (ndx != null && korea != null && ndx < 0 && korea < 0) return true;
  return false;
}

/** Rate spread "high" = e.g. > 2% in absolute terms (US much higher than KR). Widening we don't have history here, so only "high" reduces score. */
const RATE_SPREAD_HIGH_THRESHOLD = 2.0;

function isRateSpreadHighOrWidening(row) {
  const spread = row.rate_spread_us_minus_kr;
  if (spread == null) return false;
  return spread >= RATE_SPREAD_HIGH_THRESHOLD;
}

function computeScore(row, manualEventRiskFlag) {
  let score = 0;
  const p = row.usdkrw_percentile_252;
  const z = row.usdkrw_zscore_20;
  const spot = row.usdkrw_spot;
  const ma20 = row.usdkrw_ma20;
  const ma60 = row.usdkrw_ma60;
  const broadZ = row.usd_broad_index_proxy_zscore_20;
  const vix = row.vix;
  const vixCh = row.vix_change_5d;
  const ndxRet = row.nasdaq100_return_20d;
  const koreaRet = row.korea_equity_proxy_return_20d;

  if (p != null && p <= 0.15) score += 3;
  else if (p != null && p <= 0.35) score += 2;
  if (spot != null && ma20 != null && spot < ma20) score += 1;
  if (spot != null && ma60 != null && spot < ma60) score += 1;
  if (broadZ != null && broadZ <= -0.5) score += 1;
  if (broadZ != null && broadZ <= -1.0) score += 1;
  if (vix != null && vix < 22 && (vixCh == null || vixCh <= 0)) score += 1;
  if (ndxRet != null && ndxRet >= 0) score += 1;
  if (koreaRet != null && koreaRet >= 0) score += 1;

  if (p != null && p >= 0.70) score -= 3;
  if (z != null && z >= 1.0) score -= 2;
  if (vix != null && vix > 25) score -= 2;
  if (ndxRet != null && koreaRet != null && ndxRet < 0 && koreaRet < 0) score -= 1;
  if (isRateSpreadHighOrWidening(row)) score -= 1;
  if (manualEventRiskFlag) score -= 2;

  return score;
}

function getDecision(score) {
  if (score >= 6) return DECISION.BUY_NOW;
  if (score >= 3) return DECISION.SCALE_IN;
  return DECISION.WAIT;
}

function getAllocationPct(decision, row, manualEventRiskFlag) {
  if (decision === DECISION.WAIT) return 0;
  if (decision === DECISION.SCALE_IN) {
    const score = computeScore(row, manualEventRiskFlag);
    return score >= 4 ? 50 : 25;
  }
  if (decision === DECISION.BUY_NOW) {
    const valuation = getValuationLabel(row);
    const veryCheap = valuation === VALUATION.CHEAP && row.usdkrw_percentile_252 <= 0.15 && row.usdkrw_zscore_20 <= -1.0;
    const strongDollar = isDollarStronglySupportive(row);
    const vixLow = row.vix != null && row.vix < 20;
    if (veryCheap && strongDollar && vixLow && !manualEventRiskFlag) return 100;
    return 50;
  }
  return 0;
}

function getConfidence(score, hasStaleSource) {
  let conf = Math.min(100, Math.max(0, 50 + score * 10));
  if (hasStaleSource) conf = Math.max(0, conf - 15);
  return Math.round(conf);
}

/**
 * @param {object} snapshot - one row from fx_market_snapshots (with manual_event_risk_flag)
 * @param {object} options - { user_cash_krw?: number }
 * @returns {object} advisor output per schema
 */
function runAdvisor(snapshot, options = {}) {
  const manualEventRiskFlag = !!snapshot.manual_event_risk_flag;
  const valuation_label = getValuationLabel(snapshot);
  const score = computeScore(snapshot, manualEventRiskFlag);
  const decision = getDecision(score);
  const allocation_pct = getAllocationPct(decision, snapshot, manualEventRiskFlag);
  const hasStaleSource = !!snapshot.korea_rate_is_forward_filled;
  const confidence = getConfidence(score, hasStaleSource);

  const why = [];
  if (valuation_label === VALUATION.CHEAP) why.push('USD/KRW is cheap vs history');
  else if (valuation_label === VALUATION.EXPENSIVE) why.push('USD/KRW is expensive vs history');
  else why.push('USD/KRW is fair');
  if (isDollarSupportive(snapshot)) why.push('Broad USD index (FRED proxy) is supportive');
  if (isRiskNegative(snapshot)) why.push('Risk sentiment is negative');
  else if (isRiskPositive(snapshot)) why.push('Risk sentiment is positive');

  const red_flags = [];
  if (snapshot.usdkrw_percentile_252 >= 0.70) red_flags.push('USD/KRW at high percentile');
  if (snapshot.vix != null && snapshot.vix > 25) red_flags.push('VIX elevated');
  if (manualEventRiskFlag) red_flags.push('Manual event risk flag set');
  if (hasStaleSource) red_flags.push('Korea rate proxy is forward-filled (monthly source)');

  const next_trigger_to_watch = [];
  if (decision === DECISION.WAIT && valuation_label !== VALUATION.EXPENSIVE)
    next_trigger_to_watch.push('Wait for USD/KRW to cheapen or broad dollar to weaken');
  if (decision === DECISION.SCALE_IN)
    next_trigger_to_watch.push('Consider scaling in another tranche if valuation improves');

  const user_cash_krw = options.user_cash_krw != null ? Number(options.user_cash_krw) : 0;
  const krw_to_convert = allocation_pct > 0 && user_cash_krw > 0
    ? Math.round((user_cash_krw * allocation_pct) / 100)
    : 0;
  const estimated_usd_before_fees = krw_to_convert > 0 && snapshot.usdkrw_spot
    ? krw_to_convert / snapshot.usdkrw_spot
    : 0;

  const summary =
    decision === DECISION.BUY_NOW
      ? `Valuation cheap; broad USD supportive. Consider converting ${allocation_pct}% of KRW.`
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
    buy_plan: {
      krw_to_convert: Math.round(krw_to_convert),
      estimated_usd_before_fees: Math.round(estimated_usd_before_fees * 100) / 100,
      comment: allocation_pct > 0 ? `Based on ${allocation_pct}% allocation and current spot.` : 'No conversion suggested.',
    },
  };
}

module.exports = {
  runAdvisor,
  getValuationLabel,
  getDecision,
  computeScore,
  VALUATION,
  DECISION,
};
