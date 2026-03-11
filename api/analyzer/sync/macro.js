require('dotenv').config();
const analyzer = require('../../../lib/analyzer');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const supabase = analyzer.getSupabase();
    const apiKey = process.env.FRED_API_KEY;
    if (!supabase) {
      res.status(503).json({ error: 'Supabase not configured' });
      return;
    }
    if (!apiKey) {
      res.status(503).json({ error: 'FRED_API_KEY not set' });
      return;
    }
    const macro = await analyzer.syncMacro(apiKey);
    const usdkrw = macro.usdkrw?.observations || [];
    const broad = macro.usd_broad_index_proxy?.observations || [];
    const nasdaq = macro.nasdaq100?.observations || [];
    const vix = macro.vix?.observations || [];
    const us2y = macro.us2y?.observations || [];

    const toMap = (arr) => {
      const m = new Map();
      (arr || []).forEach((o) => m.set(o.date, o.value));
      return m;
    };
    const mUsd = toMap(usdkrw);
    const mBroad = toMap(broad);
    const mNas = toMap(nasdaq);
    const mVix = toMap(vix);
    const mUs2y = toMap(us2y);

    const dates = Array.from(
      new Set([...(mUsd.keys()), ...(mBroad.keys()), ...(mNas.keys()), ...(mVix.keys()), ...(mUs2y.keys())])
    ).sort();

    const broadSeries = dates.map((d) => ({ date: d, v: mBroad.get(d) ?? null })).filter((x) => x.v != null);
    const nasSeries = dates.map((d) => ({ date: d, v: mNas.get(d) ?? null })).filter((x) => x.v != null);
    const vixSeries = dates.map((d) => ({ date: d, v: mVix.get(d) ?? null })).filter((x) => x.v != null);

    const ma20ByDate = new Map();
    for (let i = 0; i < broadSeries.length; i++) {
      if (i >= 19) {
        const slice = broadSeries.slice(i - 19, i + 1);
        ma20ByDate.set(broadSeries[i].date, slice.reduce((s, x) => s + x.v, 0) / 20);
      }
    }
    const return20NasByDate = new Map();
    for (let i = 0; i < nasSeries.length; i++) {
      if (i >= 20) {
        const prev = nasSeries[i - 20].v;
        const cur = nasSeries[i].v;
        if (prev && cur) return20NasByDate.set(nasSeries[i].date, cur / prev - 1);
      }
    }
    const vixChange5ByDate = new Map();
    for (let i = 0; i < vixSeries.length; i++) {
      if (i >= 5) {
        const prev = vixSeries[i - 5].v;
        const cur = vixSeries[i].v;
        if (prev && cur) vixChange5ByDate.set(vixSeries[i].date, cur / prev - 1);
      }
    }

    const rows = dates.map((date) => {
      const snapshot_ts = `${date}T00:00:00.000Z`;
      return {
        snapshot_ts,
        symbol: 'USDKRW',
        live_provider: 'fred',
        spot: mUsd.get(date) ?? null,
        usd_broad_index_proxy: mBroad.get(date) ?? null,
        usd_broad_index_proxy_ma20: ma20ByDate.get(date) ?? null,
        nasdaq100: mNas.get(date) ?? null,
        nasdaq100_return_20d: return20NasByDate.get(date) ?? null,
        vix: mVix.get(date) ?? null,
        vix_change_5d: vixChange5ByDate.get(date) ?? null,
        macro_payload: null,
        source_dates: {
          usdkrw: usdkrw.length ? usdkrw[usdkrw.length - 1].date : null,
          usd_broad_index_proxy: broad.length ? broad[broad.length - 1].date : null,
          nasdaq100: nasdaq.length ? nasdaq[nasdaq.length - 1].date : null,
          vix: vix.length ? vix[vix.length - 1].date : null,
          us2y: us2y.length ? us2y[us2y.length - 1].date : null,
        },
      };
    });

    let lastSpot = null;
    const filledRows = [];
    for (const r of rows) {
      if (typeof r.spot !== 'number' || Number.isNaN(r.spot) || !Number.isFinite(r.spot)) r.spot = null;
      if (r.spot != null) lastSpot = r.spot;
      if (r.spot == null) r.spot = lastSpot;
      if (r.spot == null) continue;
      filledRows.push(r);
    }

    const chunkSize = 200;
    let upserted = 0;
    for (let i = 0; i < filledRows.length; i += chunkSize) {
      const chunk = filledRows.slice(i, i + chunkSize);
      const { error } = await supabase.from('fx_analyzer_snapshots').upsert(chunk, { onConflict: 'snapshot_ts' });
      if (error) throw new Error(error.message);
      upserted += chunk.length;
    }

    const lastDate = dates.length ? dates[dates.length - 1] : null;
    res.status(200).json({
      ok: true,
      upserted_days: upserted,
      latest: lastDate
        ? {
            date: lastDate,
            usd_broad_index_proxy: mBroad.get(lastDate) ?? null,
            nasdaq100: mNas.get(lastDate) ?? null,
            vix: mVix.get(lastDate) ?? null,
          }
        : null,
    });
  } catch (err) {
    console.error('analyzer/sync/macro', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
