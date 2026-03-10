/**
 * FRED API client – fetches observations for a series.
 * Uses only FRED; no DXY/KOSPI naming (use usd_broad_index_proxy / korea_equity_proxy).
 */

const axios = require('axios');

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const OBS_LIMIT = 500;

/**
 * Fetch observations for one series. Returns [{ date: 'YYYY-MM-DD', value: number }, ...].
 * FRED uses '.' for missing values – those are excluded from the returned array.
 * @param {string} seriesId - FRED series ID (e.g. DEXKOUS, DTWEXBGS)
 * @param {string} apiKey - FRED_API_KEY
 * @param {string} observationStart - YYYY-MM-DD
 * @returns {Promise<{ observations: Array<{date: string, value: number}>, sourceDate: string | null }>}
 *   sourceDate = date of the latest valid observation in the response.
 */
async function fetchSeriesObservations(seriesId, apiKey, observationStart) {
  const url = `${FRED_BASE}?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${observationStart}&sort_order=asc`;
  const res = await axios.get(url, { timeout: 20000 });
  const raw = res.data?.observations || [];
  const observations = [];
  let sourceDate = null;
  for (const obs of raw) {
    const v = obs.value;
    if (v == null || v === '.' || v === '') continue;
    const num = Number(v);
    if (Number.isNaN(num)) continue;
    const date = String(obs.date || '').slice(0, 10);
    if (!date) continue;
    observations.push({ date, value: num });
    sourceDate = date;
  }
  return { observations, sourceDate: observations.length ? sourceDate : null };
}

/**
 * Fetch multiple series in parallel (400–500 observations each).
 * @param {Record<string, string>} seriesIdMap - e.g. { usdkrw: 'DEXKOUS', usd_broad: 'DTWEXBGS' }
 * @param {string} apiKey - FRED_API_KEY
 * @param {string} observationStart - YYYY-MM-DD
 * @returns {Promise<Record<string, { observations: Array<{date: string, value: number}>, sourceDate: string | null }>>}
 */
async function fetchMultipleSeries(seriesIdMap, apiKey, observationStart) {
  const keys = Object.keys(seriesIdMap);
  const results = await Promise.all(
    keys.map((key) => fetchSeriesObservations(seriesIdMap[key], apiKey, observationStart))
  );
  const out = {};
  keys.forEach((key, i) => {
    out[key] = results[i];
  });
  return out;
}

/** FRED series IDs used by this advisor (do not use DXY/KOSPI in code). */
const FRED_SERIES_IDS = {
  DEXKOUS: 'usdkrw_spot',
  DTWEXBGS: 'usd_broad_index_proxy',
  NASDAQ100: 'nasdaq100',
  VIXCLS: 'vix',
  DGS2: 'us2y',
  NASDAQNQDXKR: 'korea_equity_proxy',
  IR3TIB01KRM156N: 'kr_rate_proxy',
};

/**
 * Fetch all advisor series from FRED (400–500 obs per series).
 * @param {string} apiKey
 * @param {string} observationStart - YYYY-MM-DD
 */
async function fetchAllFredSeries(apiKey, observationStart) {
  const idToKey = {};
  Object.entries(FRED_SERIES_IDS).forEach(([id, key]) => {
    idToKey[key] = id;
  });
  return fetchMultipleSeries(idToKey, apiKey, observationStart);
}

module.exports = {
  fetchSeriesObservations,
  fetchMultipleSeries,
  fetchAllFredSeries,
  FRED_SERIES_IDS,
  OBS_LIMIT,
};
