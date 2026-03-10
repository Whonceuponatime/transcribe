/**
 * FX indicator engine – pure calculations.
 * Aligns FRED series onto daily snapshot_date; forward-fills only where needed (e.g. Korea rate monthly).
 */

/**
 * Build sorted list of unique dates from multiple series (date strings YYYY-MM-DD).
 * @param {Record<string, Array<{date: string, value: number}>>} seriesByKey
 * @returns {string[]}
 */
function getAllDates(seriesByKey) {
  const set = new Set();
  Object.values(seriesByKey).forEach((arr) => arr.forEach((o) => set.add(o.date)));
  return [...set].sort();
}

/**
 * Map series to date -> value for quick lookup; fill missing with last known (forward-fill).
 * @param {Array<{date: string, value: number}>} observations
 * @returns {Map<string, number>}
 */
function toDateValueMap(observations) {
  const m = new Map();
  if (!observations.length) return m;
  const sorted = [...observations].sort((a, b) => a.date.localeCompare(b.date));
  let last = sorted[0].value;
  for (const o of sorted) {
    last = o.value;
    m.set(o.date, last);
  }
  return m;
}

/**
 * Forward-fill a map so every date in dates has a value (from latest prior).
 * @param {Map<string, number>} dateValueMap
 * @param {string[]} dates
 * @returns {Map<string, number>}
 */
function forwardFill(dateValueMap, dates) {
  const out = new Map();
  let last = null;
  for (const d of dates) {
    if (dateValueMap.has(d)) last = dateValueMap.get(d);
    if (last != null) out.set(d, last);
  }
  return out;
}

/**
 * Arithmetic mean of last n valid values including current (for a given date index in a sorted array).
 */
function ma(values, idx, n) {
  const start = Math.max(0, idx - n + 1);
  const slice = values.slice(start, idx + 1).filter((v) => v != null && !Number.isNaN(v));
  if (!slice.length) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function stddev(values, idx, n) {
  const m = ma(values, idx, n);
  if (m == null) return null;
  const start = Math.max(0, idx - n + 1);
  const slice = values.slice(start, idx + 1).filter((v) => v != null && !Number.isNaN(v));
  if (slice.length < 2) return 0;
  const variance = slice.reduce((acc, v) => acc + (v - m) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

/**
 * zscore_20 = (today - mean20) / stddev20
 */
function zscore20(values, idx) {
  const mean = ma(values, idx, 20);
  const sd = stddev(values, idx, 20);
  if (mean == null || sd == null || sd === 0) return null;
  const v = values[idx];
  if (v == null || Number.isNaN(v)) return null;
  return (v - mean) / sd;
}

/**
 * Percentile rank of current value within trailing 252 valid observations (0 to 1).
 */
function percentile252(values, idx) {
  const start = Math.max(0, idx - 251);
  const window = values.slice(start, idx + 1).filter((v) => v != null && !Number.isNaN(v));
  if (window.length < 2) return null;
  const current = values[idx];
  const below = window.filter((v) => v <= current).length;
  return below / window.length;
}

/**
 * return_20d = (today / value_20_obs_ago) - 1. Uses 20 calendar-day lookback (valid obs).
 */
function return20d(values, idx) {
  const lookback = 20;
  const fromIdx = idx - lookback;
  if (fromIdx < 0) return null;
  const vNow = values[idx];
  const vThen = values[fromIdx];
  if (vNow == null || vThen == null || vThen === 0) return null;
  return vNow / vThen - 1;
}

/**
 * vix_change_5d = (today / value_5_obs_ago) - 1
 */
function change5d(values, idx) {
  const lookback = 5;
  const fromIdx = idx - lookback;
  if (fromIdx < 0) return null;
  const vNow = values[idx];
  const vThen = values[fromIdx];
  if (vNow == null || vThen == null || vThen === 0) return null;
  return vNow / vThen - 1;
}

/** Check if kr_rate_proxy for this date is from forward-fill (stale). */
const KR_RATE_STALE_DAYS = 7;

function isKoreaRateStale(sourceDateStr, snapshotDateStr) {
  if (!sourceDateStr) return true;
  const a = new Date(sourceDateStr);
  const b = new Date(snapshotDateStr);
  const diffDays = (b - a) / (1000 * 60 * 60 * 24);
  return diffDays > KR_RATE_STALE_DAYS;
}

/**
 * Build daily snapshots with all indicators.
 * @param {Record<string, { observations: Array<{date: string, value: number}>, sourceDate: string | null }>} fredData - keyed by our names (usdkrw_spot, usd_broad_index_proxy, ...)
 * @returns {Array<object>} rows for fx_market_snapshots
 */
function computeSnapshots(fredData) {
  const dates = getAllDates(
    Object.fromEntries(
      Object.entries(fredData).map(([k, v]) => [k, v.observations])
    )
  );
  if (!dates.length) return [];

  const usdkrwObs = fredData.usdkrw_spot?.observations || [];
  const usdBroadObs = fredData.usd_broad_index_proxy?.observations || [];
  const nasdaqObs = fredData.nasdaq100?.observations || [];
  const koreaEqObs = fredData.korea_equity_proxy?.observations || [];
  const vixObs = fredData.vix?.observations || [];
  const us2yObs = fredData.us2y?.observations || [];
  const krObs = fredData.kr_rate_proxy?.observations || [];

  const usdkrwMap = toDateValueMap(usdkrwObs);
  const usdBroadMap = forwardFill(toDateValueMap(usdBroadObs), dates);
  const nasdaqMap = forwardFill(toDateValueMap(nasdaqObs), dates);
  const koreaEqMap = forwardFill(toDateValueMap(koreaEqObs), dates);
  const vixMap = forwardFill(toDateValueMap(vixObs), dates);
  const us2yMap = forwardFill(toDateValueMap(us2yObs), dates);
  const krMap = forwardFill(toDateValueMap(krObs), dates);

  const usdkrwValues = dates.map((d) => usdkrwMap.get(d) ?? null);
  const usdBroadValues = dates.map((d) => usdBroadMap.get(d) ?? null);
  const nasdaqValues = dates.map((d) => nasdaqMap.get(d) ?? null);
  const koreaEqValues = dates.map((d) => koreaEqMap.get(d) ?? null);
  const vixValues = dates.map((d) => vixMap.get(d) ?? null);
  const us2yValues = dates.map((d) => us2yMap.get(d) ?? null);
  const krValues = dates.map((d) => krMap.get(d) ?? null);

  const snapshots = [];
  for (let i = 0; i < dates.length; i++) {
    const snapshot_date = dates[i];
    const usdkrw_spot = usdkrwValues[i];
    if (usdkrw_spot == null) continue;

    const usd_broad_index_proxy = usdBroadValues[i] ?? null;
    const nasdaq100 = nasdaqValues[i] ?? null;
    const korea_equity_proxy = koreaEqValues[i] ?? null;
    const vix = vixValues[i] ?? null;
    const us2y = us2yValues[i] ?? null;
    const kr_rate_proxy = krValues[i] ?? null;

    const usdkrw_ma20 = ma(usdkrwValues, i, 20);
    const usdkrw_ma60 = ma(usdkrwValues, i, 60);
    const usdkrw_ma120 = ma(usdkrwValues, i, 120);
    const usdkrw_zscore_20 = zscore20(usdkrwValues, i);
    const usdkrw_percentile_252 = percentile252(usdkrwValues, i);

    const usd_broad_index_proxy_ma20 = usdBroadValues[i] != null ? ma(usdBroadValues, i, 20) : null;
    const usd_broad_index_proxy_ma60 = usdBroadValues[i] != null ? ma(usdBroadValues, i, 60) : null;
    const usd_broad_index_proxy_zscore_20 = usdBroadValues[i] != null ? zscore20(usdBroadValues, i) : null;

    const nasdaq100_return_20d = return20d(nasdaqValues, i);
    const korea_equity_proxy_return_20d = return20d(koreaEqValues, i);
    const vix_change_5d = change5d(vixValues, i);

    const rate_spread_us_minus_kr =
      us2y != null && kr_rate_proxy != null ? us2y - kr_rate_proxy : null;

    const krSourceDate = krObs.length ? (krObs.find((o) => o.date <= snapshot_date)?.date ?? null) : null;
    const korea_rate_is_forward_filled = krSourceDate ? snapshot_date !== krSourceDate : true;

    const source_dates = {
      usdkrw_spot: fredData.usdkrw_spot?.sourceDate ?? null,
      usd_broad_index_proxy: fredData.usd_broad_index_proxy?.sourceDate ?? null,
      nasdaq100: fredData.nasdaq100?.sourceDate ?? null,
      korea_equity_proxy: fredData.korea_equity_proxy?.sourceDate ?? null,
      vix: fredData.vix?.sourceDate ?? null,
      us2y: fredData.us2y?.sourceDate ?? null,
      kr_rate_proxy: fredData.kr_rate_proxy?.sourceDate ?? null,
    };

    snapshots.push({
      snapshot_date,
      usdkrw_spot,
      usd_broad_index_proxy,
      nasdaq100,
      korea_equity_proxy,
      vix,
      us2y,
      kr_rate_proxy,
      usdkrw_ma20,
      usdkrw_ma60,
      usdkrw_ma120,
      usdkrw_zscore_20,
      usdkrw_percentile_252,
      usd_broad_index_proxy_ma20,
      usd_broad_index_proxy_ma60,
      usd_broad_index_proxy_zscore_20,
      nasdaq100_return_20d,
      korea_equity_proxy_return_20d,
      vix_change_5d,
      rate_spread_us_minus_kr,
      korea_rate_is_forward_filled,
      source_dates,
    });
  }

  return snapshots;
}

module.exports = {
  computeSnapshots,
  isKoreaRateStale,
  getAllDates,
  toDateValueMap,
  forwardFill,
};
