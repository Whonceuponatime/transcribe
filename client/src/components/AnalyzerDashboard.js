/**
 * Analyzer-only KRW→USD dashboard. No execution, no trade button. Manual trading only.
 */

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
} from 'recharts';
import './AnalyzerDashboard.css';

const API_BASE = '';
const fmt = (n, decimals = 2) =>
  (n != null && n !== '')
    ? Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
    : '—';

function useAnalyzerDashboard() {
  const [data, setData] = useState({
    quote: null,
    signal: null,
    bars: [],
    snapshots: [],
    signals: [],
    trades: [],
    provider_health: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/analyzer/dashboard?days=90`);
      if (!res.ok) throw new Error(res.statusText);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return { ...data, loading, error, refetch: fetchDashboard };
}

export default function AnalyzerDashboard() {
  const {
    quote,
    signal,
    bars,
    snapshots,
    trades,
    provider_health,
    loading,
    error,
    refetch,
  } = useAnalyzerDashboard();

  const [syncing, setSyncing] = useState(false);
  const [macroSyncing, setMacroSyncing] = useState(false);
  const [tradeForm, setTradeForm] = useState({ action: 'BUY_USD', krw_amount: '', usd_amount: '', fx_rate: '', note: '' });
  const [tradeResult, setTradeResult] = useState(null);

  const runLiveSync = useCallback(async () => {
    setSyncing(true);
    setTradeResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/analyzer/sync/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (json.ok) refetch();
      else setTradeResult({ error: json.error });
    } finally {
      setSyncing(false);
    }
  }, [refetch]);

  const runMacroSync = useCallback(async () => {
    setMacroSyncing(true);
    setTradeResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/analyzer/sync/macro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (json.ok) refetch();
      else setTradeResult({ error: json.error });
    } finally {
      setMacroSyncing(false);
    }
  }, [refetch]);

  const submitManualTrade = useCallback(async () => {
    const payload = {
      action: tradeForm.action,
      krw_amount: tradeForm.krw_amount ? Number(tradeForm.krw_amount) : null,
      usd_amount: tradeForm.usd_amount ? Number(tradeForm.usd_amount) : null,
      fx_rate: tradeForm.fx_rate ? Number(tradeForm.fx_rate) : null,
      note: tradeForm.note || null,
    };
    const res = await fetch(`${API_BASE}/api/analyzer/trades/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    setTradeResult(json);
    if (json.ok) {
      setTradeForm({ action: 'BUY_USD', krw_amount: '', usd_amount: '', fx_rate: '', note: '' });
      refetch();
    }
  }, [tradeForm, refetch]);

  const healthByProvider = (provider_health || []).reduce((acc, r) => {
    if (!acc[r.provider] || new Date(r.checked_at) > new Date(acc[r.provider].checked_at)) acc[r.provider] = r;
    return acc;
  }, {});

  const priceChartData = (bars || []).slice(-200).map((b) => ({
    ts: b.bucket_ts,
    spot: b.close,
    ma20: null,
    ma60: null,
    ma120: null,
  }));
  if (priceChartData.length >= 20) {
    const closes = priceChartData.map((d) => d.spot);
    priceChartData.forEach((d, i) => {
      if (i >= 19) d.ma20 = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
      if (i >= 59) d.ma60 = closes.slice(i - 59, i + 1).reduce((a, b) => a + b, 0) / 60;
      if (i >= 119) d.ma120 = closes.slice(i - 119, i + 1).reduce((a, b) => a + b, 0) / 120;
    });
  }

  const valuationChartData = (snapshots || []).map((s) => ({
    ts: s.snapshot_ts,
    percentile252: s.percentile252 != null ? s.percentile252 * 100 : null,
    zscore20: s.zscore20,
  }));

  const macroChartData = (snapshots || []).map((s) => ({
    ts: s.snapshot_ts,
    usd_broad: s.usd_broad_index_proxy,
    nasdaq: s.nasdaq100,
    vix: s.vix,
  }));

  const totalUsd = (trades || [])
    .filter((t) => t.action === 'BUY_USD')
    .reduce((s, t) => s + (Number(t.usd_amount) || 0), 0);
  const totalKrw = (trades || [])
    .filter((t) => t.action === 'BUY_USD')
    .reduce((s, t) => s + (Number(t.krw_amount) || 0), 0);
  const avgRate = totalUsd > 0 ? totalKrw / totalUsd : null;

  if (loading && !quote && !signal) {
    return (
      <div className="analyzer">
        <div className="analyzer__loading">Loading analyzer…</div>
      </div>
    );
  }

  return (
    <div className="analyzer">
      <header className="analyzer__header">
        <h2 className="analyzer__title">KRW → USD Analyzer</h2>
        <p className="analyzer__subtitle">
          Analysis only — no execution. You trade manually. Data: Massive (primary) / Finnhub (fallback); FRED for macro context.
        </p>
        <div className="analyzer__actions">
          <button type="button" className="analyzer__btn analyzer__btn--primary" onClick={refetch} disabled={loading}>
            Refresh
          </button>
          <button type="button" className="analyzer__btn" onClick={runLiveSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync live'}
          </button>
          <button type="button" className="analyzer__btn" onClick={runMacroSync} disabled={macroSyncing}>
            {macroSyncing ? 'Syncing…' : 'Sync macro (FRED)'}
          </button>
        </div>
      </header>

      {error && <div className="analyzer__error">{error}</div>}
      {tradeResult?.error && <div className="analyzer__error">{tradeResult.error}</div>}
      {tradeResult?.ok && <div className="analyzer__success">Trade logged.</div>}

      <div className="analyzer__grid">
        {/* Current signal */}
        <section className="analyzer__card card">
          <h3>Current signal</h3>
          {signal ? (
            <>
              <div className="analyzer__decision-row">
                <span className={`analyzer__decision analyzer__decision--${(signal.decision || '').toLowerCase()}`}>
                  {signal.decision}
                </span>
                <span className="analyzer__allocation">{signal.allocation_pct}% allocation</span>
                <span className="analyzer__confidence">Confidence: {signal.confidence}%</span>
              </div>
              <p className="analyzer__valuation">Valuation: {signal.valuation_label}</p>
              <p className="analyzer__summary">{signal.summary}</p>
              <p className="analyzer__meta">
                Provider: {signal.live_provider}
                {signal.is_stale && <span className="analyzer__stale"> · Stale data</span>}
                {signal.quote_timestamp && ` · Quote: ${new Date(signal.quote_timestamp).toLocaleString()}`}
              </p>
              {(signal.why || []).length > 0 && (
                <ul className="analyzer__why">
                  {(signal.why || []).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              {(signal.red_flags || []).length > 0 && (
                <ul className="analyzer__red-flags">
                  {(signal.red_flags || []).map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="analyzer__no-data">No signal yet. Run &quot;Sync live&quot;.</p>
          )}
        </section>

        {/* Live quote */}
        <section className="analyzer__card card">
          <h3>Live quote</h3>
          {quote ? (
            <div className="analyzer__quote">
              <div className="analyzer__quote-row">
                <span className="analyzer__quote-mid">USD/KRW {fmt(quote.mid ?? (quote.bid + quote.ask) / 2)}</span>
                <span>Bid {fmt(quote.bid)} · Ask {fmt(quote.ask)}</span>
              </div>
              <div className="analyzer__quote-meta">
                Spread {fmt(quote.spread)} · {quote.provider} · {quote.quote_ts ? new Date(quote.quote_ts).toLocaleString() : '—'}
                {quote.is_stale && <span className="analyzer__stale"> · Stale</span>}
              </div>
            </div>
          ) : (
            <p className="analyzer__no-data">No quote. Run &quot;Sync live&quot;.</p>
          )}
        </section>

        {/* USD/KRW chart */}
        <section className="analyzer__card card analyzer__chart-wrap">
          <h3>USD/KRW</h3>
          {priceChartData.length > 0 ? (
            <div className="analyzer__chart">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={priceChartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="ts" tick={{ fontSize: 10 }} tickFormatter={(v) => (v ? new Date(v).toLocaleDateString() : '')} />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 0)} />
                  <Tooltip labelFormatter={(v) => (v ? new Date(v).toLocaleString() : '')} formatter={(v) => fmt(v)} />
                  <Legend />
                  <Line type="monotone" dataKey="spot" stroke="#22c55e" name="Spot" dot={false} />
                  <Line type="monotone" dataKey="ma20" stroke="#eab308" name="MA20" dot={false} />
                  <Line type="monotone" dataKey="ma60" stroke="#f97316" name="MA60" dot={false} />
                  <Line type="monotone" dataKey="ma120" stroke="#a855f7" name="MA120" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="analyzer__no-data">No bar data. Sync live to build history.</p>
          )}
        </section>

        {/* Valuation chart */}
        <section className="analyzer__card card analyzer__chart-wrap">
          <h3>Valuation (percentile & z-score)</h3>
          {valuationChartData.length > 0 ? (
            <div className="analyzer__chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={valuationChartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="ts" tick={{ fontSize: 10 }} tickFormatter={(v) => (v ? new Date(v).toLocaleDateString() : '')} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
                  <Tooltip labelFormatter={(v) => (v ? new Date(v).toLocaleString() : '')} />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="percentile252" stroke="#22c55e" name="Percentile 252" dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="zscore20" stroke="#3b82f6" name="Z-score 20" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="analyzer__no-data">No snapshot history yet.</p>
          )}
        </section>

        {/* Macro chart */}
        <section className="analyzer__card card analyzer__chart-wrap">
          <h3>Macro context (Broad Dollar Proxy, Nasdaq, VIX)</h3>
          <p className="analyzer__chart-note">Not a direct trade trigger. FRED data for context only.</p>
          {macroChartData.length > 0 ? (
            <div className="analyzer__chart">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={macroChartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="ts" tick={{ fontSize: 10 }} tickFormatter={(v) => (v ? new Date(v).toLocaleDateString() : '')} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
                  <Tooltip labelFormatter={(v) => (v ? new Date(v).toLocaleString() : '')} />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="usd_broad" stroke="#eab308" name="Broad Dollar Proxy" dot={false} />
                  <Line yAxisId="left" type="monotone" dataKey="nasdaq" stroke="#22c55e" name="Nasdaq 100" dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="vix" stroke="#ef4444" name="VIX" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="analyzer__no-data">Run &quot;Sync macro (FRED)&quot; for context.</p>
          )}
        </section>

        {/* Provider health */}
        <section className="analyzer__card card">
          <h3>Provider health</h3>
          <div className="analyzer__health">
            {['massive', 'finnhub'].map((p) => {
              const h = healthByProvider[p];
              const status = h?.status || 'unknown';
              return (
                <div key={p} className={`analyzer__health-row analyzer__health-row--${status}`}>
                  <span>{p}</span>
                  <span>{status}</span>
                  {h?.latency_ms != null && <span>{h.latency_ms} ms</span>}
                  {h?.stale_seconds != null && <span>stale {h.stale_seconds}s</span>}
                </div>
              );
            })}
          </div>
        </section>

        {/* Trade journal */}
        <section className="analyzer__card card">
          <h3>Trade journal (manual)</h3>
          <p className="analyzer__hint">Log your manual trades here. No execution in this app.</p>
          <div className="analyzer__journal-stats">
            <span>Total USD acquired: {fmt(totalUsd, 2)}</span>
            <span>Total KRW spent: {fmt(totalKrw, 0)}</span>
            <span>Avg buy rate: {fmt(avgRate, 0)}</span>
          </div>
          <div className="analyzer__trade-form">
            <select
              value={tradeForm.action}
              onChange={(e) => setTradeForm((f) => ({ ...f, action: e.target.value }))}
            >
              <option value="BUY_USD">BUY_USD</option>
              <option value="SELL_USD">SELL_USD</option>
            </select>
            <input
              type="number"
              placeholder="KRW amount"
              value={tradeForm.krw_amount}
              onChange={(e) => setTradeForm((f) => ({ ...f, krw_amount: e.target.value }))}
            />
            <input
              type="number"
              placeholder="USD amount"
              value={tradeForm.usd_amount}
              onChange={(e) => setTradeForm((f) => ({ ...f, usd_amount: e.target.value }))}
            />
            <input
              type="number"
              placeholder="FX rate"
              value={tradeForm.fx_rate}
              onChange={(e) => setTradeForm((f) => ({ ...f, fx_rate: e.target.value }))}
            />
            <input
              type="text"
              placeholder="Note"
              value={tradeForm.note}
              onChange={(e) => setTradeForm((f) => ({ ...f, note: e.target.value }))}
            />
            <button type="button" className="analyzer__btn" onClick={submitManualTrade}>
              Log trade
            </button>
          </div>
          <div className="analyzer__trades-list">
            {(trades || []).slice(0, 10).map((t) => (
              <div key={t.id} className="analyzer__trade-row">
                <span>{t.action}</span>
                <span>{fmt(t.krw_amount)} KRW</span>
                <span>{fmt(t.usd_amount)} USD</span>
                <span>{fmt(t.fx_rate)}</span>
                <span>{t.trade_ts ? new Date(t.trade_ts).toLocaleString() : ''}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
