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

const API = '';
const fmt = (n, d = 2) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '—');
const pct = (n) => (n != null ? `${(n * 100).toFixed(1)}%` : '—');

function decisionColor(d) {
  if (d === 'BUY_NOW') return '#22c55e';
  if (d === 'SCALE_IN') return '#eab308';
  return '#6b7280';
}

export default function AnalyzerDashboard() {
  const [signal, setSignal] = useState(null);
  const [quote, setQuote] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [trades, setTrades] = useState([]);
  const [, setHealth] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [macroSyncing, setMacroSyncing] = useState(false);
  const [error, setError] = useState(null);

  const [tradeForm, setTradeForm] = useState({ action: 'BUY_USD', krw_amount: '', usd_amount: '', fx_rate: '', note: '' });
  const [tradeMsg, setTradeMsg] = useState(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/analyzer/dashboard?days=365`);
      if (!res.ok) throw new Error(res.statusText);
      const j = await res.json();
      setQuote(j.quote);
      setSignal(j.signal);
      setSnapshots(j.snapshots || []);
      setTrades(j.trades || []);
      setHealth(j.provider_health || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  const syncLive = useCallback(async () => {
    setSyncing(true); setError(null);
    try {
      const res = await fetch(`${API}/api/analyzer/sync/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) setError(j.error);
      else fetchDashboard();
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  }, [fetchDashboard]);

  const syncMacro = useCallback(async () => {
    setMacroSyncing(true); setError(null);
    try {
      const res = await fetch(`${API}/api/analyzer/sync/macro`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) setError(j.error);
      else fetchDashboard();
    } catch (e) { setError(e.message); }
    finally { setMacroSyncing(false); }
  }, [fetchDashboard]);

  const submitTrade = useCallback(async () => {
    setTradeMsg(null);
    try {
      const res = await fetch(`${API}/api/analyzer/trades/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: tradeForm.action,
          krw_amount: tradeForm.krw_amount ? Number(tradeForm.krw_amount) : null,
          usd_amount: tradeForm.usd_amount ? Number(tradeForm.usd_amount) : null,
          fx_rate: tradeForm.fx_rate ? Number(tradeForm.fx_rate) : null,
          note: tradeForm.note || null,
        }),
      });
      const j = await res.json();
      if (j.ok) { setTradeMsg('Trade logged'); setTradeForm({ action: 'BUY_USD', krw_amount: '', usd_amount: '', fx_rate: '', note: '' }); fetchDashboard(); }
      else setTradeMsg(j.error || 'Failed');
    } catch (e) { setTradeMsg(e.message); }
  }, [tradeForm, fetchDashboard]);

  const levels = signal?.levels || {};
  const totalUsd = trades.filter((t) => t.action === 'BUY_USD').reduce((s, t) => s + (Number(t.usd_amount) || 0), 0);
  const totalKrw = trades.filter((t) => t.action === 'BUY_USD').reduce((s, t) => s + (Number(t.krw_amount) || 0), 0);
  const avgRate = totalUsd > 0 ? totalKrw / totalUsd : null;

  const chartData = snapshots.map((s) => ({
    date: s.snapshot_ts?.slice(0, 10),
    spot: s.spot,
    vix: s.vix,
    nasdaq: s.nasdaq100,
  }));

  if (loading && !signal) {
    return <div className="analyzer"><div className="analyzer__loading">Loading advisor…</div></div>;
  }

  return (
    <div className="analyzer">
      <header className="analyzer__header">
        <h2 className="analyzer__title">When to Buy USD</h2>
        <p className="analyzer__subtitle">
          KRW depreciates over time. This advisor tells you when USD is cheap so you can time your purchases.
        </p>
        <div className="analyzer__actions">
          <button type="button" className="analyzer__btn analyzer__btn--primary" onClick={syncLive} disabled={syncing}>
            {syncing ? 'Checking…' : 'Check now'}
          </button>
          <button type="button" className="analyzer__btn" onClick={syncMacro} disabled={macroSyncing}>
            {macroSyncing ? 'Loading…' : 'Load history (FRED)'}
          </button>
          <button type="button" className="analyzer__btn" onClick={fetchDashboard} disabled={loading}>Refresh</button>
        </div>
      </header>

      {error && <div className="analyzer__error">{error}</div>}

      {/* Live rate */}
      <section className="analyzer__card card analyzer__rate-card">
        <div className="analyzer__rate-main">
          <span className="analyzer__rate-label">USD/KRW now</span>
          <span className="analyzer__rate-value">{fmt(quote?.mid || levels.spot, 2)}</span>
        </div>
        <div className="analyzer__rate-meta">
          {quote?.provider && <span>via {quote.provider}</span>}
          {quote?.quote_ts && <span>{new Date(quote.quote_ts).toLocaleString()}</span>}
        </div>
      </section>

      {/* Signal */}
      {signal && (
        <section className="analyzer__card card analyzer__signal-card" style={{ borderLeft: `4px solid ${decisionColor(signal.decision)}` }}>
          <div className="analyzer__signal-top">
            <span className="analyzer__decision" style={{ background: decisionColor(signal.decision) }}>
              {signal.decision === 'BUY_NOW' ? 'BUY NOW' : signal.decision === 'SCALE_IN' ? 'SCALE IN' : 'WAIT'}
            </span>
            <span className="analyzer__alloc">{signal.allocation_pct}% suggested</span>
            <span className="analyzer__conf">Confidence: {signal.confidence}%</span>
            <span className="analyzer__val">{signal.valuation_label}</span>
          </div>
          <p className="analyzer__summary">{signal.summary}</p>

          {(signal.why || []).length > 0 && (
            <div className="analyzer__reasons">
              <strong>Why:</strong>
              <ul>{(signal.why || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {(signal.red_flags || []).length > 0 && (
            <div className="analyzer__warnings">
              <strong>Caution:</strong>
              <ul>{(signal.red_flags || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {(signal.next_trigger_to_watch || []).length > 0 && (
            <div className="analyzer__triggers">
              <strong>Watch for:</strong>
              <ul>{(signal.next_trigger_to_watch || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}

          <div className="analyzer__levels">
            <span>MA20: {fmt(levels.ma20, 0)}</span>
            <span>MA60: {fmt(levels.ma60, 0)}</span>
            <span>MA120: {fmt(levels.ma120, 0)}</span>
            <span>Z-score: {fmt(levels.zscore20, 2)}</span>
            <span>Percentile: {pct(levels.percentile252)}</span>
          </div>
        </section>
      )}

      {!signal && (
        <section className="analyzer__card card">
          <p className="analyzer__no-data">No signal yet. Click &quot;Check now&quot; to get your first recommendation.</p>
        </section>
      )}

      {/* USD/KRW chart */}
      {chartData.length > 5 && (
        <section className="analyzer__card card">
          <h3>USD/KRW history</h3>
          <div className="analyzer__chart">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} tickFormatter={(v) => fmt(v, 0)} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="spot" stroke="#22c55e" name="USD/KRW" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {/* Trade journal */}
      <section className="analyzer__card card">
        <h3>Your trade journal</h3>
        <p className="analyzer__hint">Log trades you make manually. This app never places orders for you.</p>
        {totalUsd > 0 && (
          <div className="analyzer__journal-stats">
            <span>Total USD: {fmt(totalUsd, 2)}</span>
            <span>Total KRW spent: {fmt(totalKrw, 0)}</span>
            <span>Avg buy rate: {fmt(avgRate, 0)}</span>
          </div>
        )}
        <div className="analyzer__trade-form">
          <select value={tradeForm.action} onChange={(e) => setTradeForm((f) => ({ ...f, action: e.target.value }))}>
            <option value="BUY_USD">BUY USD</option>
            <option value="SELL_USD">SELL USD</option>
          </select>
          <input type="number" placeholder="KRW" value={tradeForm.krw_amount} onChange={(e) => setTradeForm((f) => ({ ...f, krw_amount: e.target.value }))} />
          <input type="number" placeholder="USD" value={tradeForm.usd_amount} onChange={(e) => setTradeForm((f) => ({ ...f, usd_amount: e.target.value }))} />
          <input type="number" placeholder="Rate" value={tradeForm.fx_rate} onChange={(e) => setTradeForm((f) => ({ ...f, fx_rate: e.target.value }))} />
          <input type="text" placeholder="Note" value={tradeForm.note} onChange={(e) => setTradeForm((f) => ({ ...f, note: e.target.value }))} />
          <button type="button" className="analyzer__btn" onClick={submitTrade}>Log</button>
        </div>
        {tradeMsg && <div className="analyzer__trade-msg">{tradeMsg}</div>}
        {trades.length > 0 && (
          <div className="analyzer__trades-list">
            {trades.slice(0, 10).map((t) => (
              <div key={t.id} className="analyzer__trade-row">
                <span className={t.action === 'BUY_USD' ? 'green' : 'red'}>{t.action}</span>
                <span>{fmt(t.krw_amount, 0)} KRW</span>
                <span>{fmt(t.usd_amount, 2)} USD</span>
                <span>@ {fmt(t.fx_rate, 2)}</span>
                <span>{t.trade_ts ? new Date(t.trade_ts).toLocaleDateString() : ''}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
