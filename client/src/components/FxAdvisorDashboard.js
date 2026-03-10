import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceDot,
} from 'recharts';
import './FxAdvisorDashboard.css';

const API_BASE = '';

const fmt = (n, decimals = 2) =>
  Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });

function useFxToday() {
  const [data, setData] = useState({ snapshot: null, advice: null, portfolio: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetchToday = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/fx-advice/today`);
      if (!res.ok) throw new Error(res.statusText);
      const json = await res.json();
      setData({
        snapshot: json.snapshot,
        advice: json.advice,
        portfolio: json.portfolio || {},
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchToday();
  }, [fetchToday]);
  return { ...data, loading, error, refetch: fetchToday };
}

function useFxDashboard() {
  const [data, setData] = useState({ series: [], buyMarkers: [], conversions: [] });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/fx-dashboard?days=365`);
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (_) {}
      finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return { ...data, loading };
}

function normalizeSeriesToFirst(series, keys) {
  if (!series.length) return [];
  const firsts = {};
  keys.forEach((k) => { firsts[k] = series[0][k]; });
  const nameMap = { usd_broad_index_proxy: 'usd_broad_norm', nasdaq100: 'nasdaq100_norm', korea_equity_proxy: 'korea_equity_norm' };
  return series.map((r) => {
    const out = { date: r.snapshot_date };
    keys.forEach((key) => {
      const first = firsts[key];
      const name = nameMap[key];
      out[name] = first != null && first !== 0 && r[key] != null ? (r[key] / first) * 100 : null;
    });
    return out;
  });
}

export default function FxAdvisorDashboard() {
  const { snapshot, advice, portfolio, loading, error, refetch } = useFxToday();
  const { series, buyMarkers, conversions, loading: dashboardLoading } = useFxDashboard();
  const [syncing, setSyncing] = useState(false);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${API_BASE}/api/fx-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (json.ok) refetch();
    } finally {
      setSyncing(false);
    }
  }, [refetch]);

  const buySet = new Set(buyMarkers || []);
  const seriesWithBuy = (series || []).map((r) => ({ ...r, isBuy: buySet.has(r.snapshot_date) }));

  const chartPercentile = (series || []).map((r) => ({
    date: r.snapshot_date,
    percentile_252: r.usdkrw_percentile_252 != null ? r.usdkrw_percentile_252 * 100 : null,
  }));

  const normalizedSeries = (series || []).length
    ? normalizeSeriesToFirst([...(series || [])], ['usd_broad_index_proxy', 'nasdaq100', 'korea_equity_proxy']).map((r) => ({
        date: r.snapshot_date,
        usd_broad_norm: r.usd_broad_norm,
        nasdaq100_norm: r.nasdaq100_norm,
        korea_equity_norm: r.korea_equity_norm,
      }))
    : [];

  const vixSeries = (series || []).map((r) => ({
    date: r.snapshot_date,
    vix: r.vix,
  }));

  const convWithCumulative = (conversions || []).map((c, i, arr) => {
    const slice = arr.slice(0, i + 1);
    const totalKrw = slice.reduce((s, x) => s + Number(x.krw_amount || 0), 0);
    const totalUsd = slice.reduce((s, x) => s + Number(x.usd_amount || 0), 0);
    const avgRate = totalUsd > 0 ? totalKrw / totalUsd : null;
    return {
      date: c.executed_at?.slice(0, 10) || '',
      fx_rate: c.fx_rate,
      avg_buy_rate: avgRate,
    };
  });

  const latestDate = snapshot?.snapshot_date;
  const todayStr = new Date().toISOString().slice(0, 10);
  const isStale = latestDate && latestDate !== todayStr;

  if (loading && !advice) {
    return (
      <div className="fx-advisor">
        <div className="fx-advisor__loading">Loading FX advisor…</div>
      </div>
    );
  }

  return (
    <div className="fx-advisor">
      <header className="fx-advisor__header">
        <h2 className="fx-advisor__title">KRW → USD Advisor (FRED)</h2>
        <p className="fx-advisor__subtitle">
          Valuation-driven; broad USD and risk filters. Data from FRED only.
        </p>
        <div className="fx-advisor__actions">
          <button type="button" className="fx-advisor__btn fx-advisor__btn--primary" onClick={refetch} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="fx-advisor__btn" onClick={runSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Run sync (FRED + advice)'}
          </button>
        </div>
      </header>

      {error && (
        <div className="fx-advisor__error">
          {error}. Ensure Supabase and (for sync) FRED_API_KEY are set.
        </div>
      )}

      {/* Decision card */}
      <section className="fx-advisor__card card">
        <h3>Today’s advice</h3>
        {advice ? (
          <>
            <div className="fx-advisor__decision-row">
              <span className={`fx-advisor__decision fx-advisor__decision--${(advice.decision || '').toLowerCase()}`}>
                {advice.decision}
              </span>
              <span className="fx-advisor__allocation">{advice.allocation_pct}% allocation</span>
              <span className="fx-advisor__confidence">Confidence: {advice.confidence}%</span>
            </div>
            <p className="fx-advisor__summary">{advice.summary}</p>
            <p className="fx-advisor__valuation">Valuation: {advice.valuation_label}</p>
            {advice.red_flags?.length > 0 && (
              <ul className="fx-advisor__red-flags">
                {advice.red_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p>No advice yet. Run sync to fetch FRED data and generate advice.</p>
        )}
      </section>

      {/* Portfolio summary */}
      {portfolio && (portfolio.totalKrwConverted > 0 || portfolio.totalUsdAcquired > 0) && (
        <section className="fx-advisor__card card">
          <h3>Portfolio (from conversions)</h3>
          <p>Total KRW converted: ₩{fmt(portfolio.totalKrwConverted, 0)}</p>
          <p>Total USD acquired: ${fmt(portfolio.totalUsdAcquired, 2)}</p>
          <p>Average buy rate: {fmt(portfolio.averageBuyRate, 2)} KRW/USD</p>
          {snapshot?.usdkrw_spot && (
            <p>Unrealized KRW value (at current spot): ₩{fmt(portfolio.unrealizedKrwValue, 0)}</p>
          )}
        </section>
      )}

      {/* Source dates & stale warning */}
      {snapshot?.source_dates && Object.keys(snapshot.source_dates).length > 0 && (
        <section className="fx-advisor__card card fx-advisor__sources">
          <h3>Source dates (latest FRED observation per series)</h3>
          {isStale && (
            <p className="fx-advisor__stale">
              Stale data: latest snapshot is {latestDate}, not today. Run sync to update.
            </p>
          )}
          <ul>
            {Object.entries(snapshot.source_dates).map(([key, date]) => (
              <li key={key}>{key}: {date || '—'}</li>
            ))}
          </ul>
          <p className="fx-advisor__disclaimer">
            Dollar index = FRED broad dollar index proxy (DTWEXBGS), not official ICE DXY. Korea equity = FRED Korea equity proxy (NASDAQNQDXKR), not official KOSPI.
          </p>
        </section>
      )}

      {/* Charts */}
      {dashboardLoading ? (
        <div className="fx-advisor__loading">Loading charts…</div>
      ) : (
        <>
          <section className="fx-advisor__card card">
            <h3>USD/KRW spot vs MA20, MA60 (buy markers = BUY_NOW days)</h3>
            <div className="fx-advisor__chart">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={seriesWithBuy} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="snapshot_date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => fmt(v)} labelFormatter={(l) => l} />
                  <Legend />
                  <Line type="monotone" dataKey="usdkrw_spot" name="USD/KRW spot" stroke="var(--accent)" dot={false} />
                  <Line type="monotone" dataKey="usdkrw_ma20" name="MA20" stroke="rgba(34,197,94,0.7)" dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="usdkrw_ma60" name="MA60" stroke="rgba(34,197,94,0.5)" dot={false} strokeDasharray="2 2" />
                  {seriesWithBuy.filter((r) => r.isBuy).map((r, i) => (
                    <ReferenceDot key={i} x={r.snapshot_date} y={r.usdkrw_spot} r={5} fill="var(--accent)" />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="fx-advisor__card card">
            <h3>USD/KRW 252-day percentile (0–100)</h3>
            <div className="fx-advisor__chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartPercentile} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => (v != null ? `${Number(v).toFixed(1)}%` : '—')} />
                  <Line type="monotone" dataKey="percentile_252" name="Percentile" stroke="var(--accent)" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="fx-advisor__card card">
            <h3>Normalized: FRED broad USD proxy, Nasdaq 100, Korea equity proxy</h3>
            <p className="fx-advisor__chart-note">Indexed to first value = 100. Korea line = FRED Korea equity proxy, not KOSPI.</p>
            <div className="fx-advisor__chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={normalizedSeries} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="usd_broad_norm" name="Broad USD (FRED proxy)" stroke="#94a3b8" dot={false} />
                  <Line type="monotone" dataKey="nasdaq100_norm" name="Nasdaq 100" stroke="#22c55e" dot={false} />
                  <Line type="monotone" dataKey="korea_equity_norm" name="Korea equity (FRED proxy)" stroke="#e2e8f0" dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="fx-advisor__card card">
            <h3>VIX</h3>
            <div className="fx-advisor__chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={vixSeries} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="vix" name="VIX" stroke="#f59e0b" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {convWithCumulative.length > 0 && (
            <section className="fx-advisor__card card">
              <h3>Conversion history & rolling average buy rate</h3>
              <div className="fx-advisor__chart">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={convWithCumulative} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => (v != null ? fmt(v) : '—')} />
                    <Legend />
                    <Line type="monotone" dataKey="fx_rate" name="FX rate" stroke="var(--accent)" dot={true} />
                    <Line type="monotone" dataKey="avg_buy_rate" name="Avg buy rate" stroke="#94a3b8" dot={false} strokeDasharray="4 2" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
