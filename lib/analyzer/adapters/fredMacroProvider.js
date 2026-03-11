/**
 * FRED: macro and historical context only. Do not treat as live.
 * Use for broad dollar proxy (usd_broad_index_proxy), VIX, Nasdaq, yields, long-term comparison.
 * Do not label FRED broad dollar as official DXY.
 */

const axios = require('axios');

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

const SERIES = {
  DEXKOUS: 'usdkrw',
  DTWEXBGS: 'usd_broad_index_proxy',
  NASDAQ100: 'nasdaq100',
  VIXCLS: 'vix',
  DGS2: 'us2y',
};

async function fetchSeries(seriesId, apiKey, observationStart) {
  const url = `${FRED_BASE}?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${observationStart}&sort_order=asc`;
  const res = await axios.get(url, { timeout: 15000 });
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

async function fetchAllMacro(apiKey, observationStart) {
  const out = {};
  for (const [id, key] of Object.entries(SERIES)) {
    try {
      out[key] = await fetchSeries(id, apiKey, observationStart);
    } catch (_) {
      out[key] = { observations: [], sourceDate: null };
    }
  }
  return out;
}

module.exports = {
  fetchSeries,
  fetchAllMacro,
  SERIES,
};
