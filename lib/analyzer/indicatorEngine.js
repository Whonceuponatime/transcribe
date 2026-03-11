/**
 * Compute MA20, MA60, MA120, zscore20, percentile252 from bars/snapshots.
 */

function ma(values, period) {
  if (!values.length || period < 1) return null;
  const slice = values.slice(-period).filter((v) => v != null && !Number.isNaN(v));
  if (!slice.length) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function stddev(values, period) {
  const m = ma(values, period);
  if (m == null) return null;
  const slice = values.slice(-period).filter((v) => v != null && !Number.isNaN(v));
  if (slice.length < 2) return 0;
  const variance = slice.reduce((acc, v) => acc + (v - m) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function zscore(values, period) {
  const m = ma(values, period);
  const sd = stddev(values, period);
  if (m == null || sd == null || sd === 0) return null;
  const v = values[values.length - 1];
  if (v == null) return null;
  return (v - m) / sd;
}

function percentileRank(sortedValues, value) {
  if (!sortedValues.length) return null;
  const below = sortedValues.filter((v) => v <= value).length;
  return below / sortedValues.length;
}

function computeFromBars(bars) {
  const closes = (bars || []).map((b) => b.close).filter((v) => v != null);
  if (!closes.length) return null;
  const spot = closes[closes.length - 1];
  const ma20 = ma(closes, 20);
  const ma60 = ma(closes, 60);
  const ma120 = ma(closes, 120);
  const zscore20 = zscore(closes, 20);
  const sorted252 = closes.slice(-252).sort((a, b) => a - b);
  const percentile252 = percentileRank(sorted252, spot);
  return { spot, ma20, ma60, ma120, zscore20, percentile252 };
}

module.exports = {
  ma,
  stddev,
  zscore,
  percentileRank,
  computeFromBars,
};
