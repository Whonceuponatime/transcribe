import React, { useState, useEffect, useCallback } from 'react';
import './LiveTradingDashboard.css';

const API = '';

const fmt = (n, d = 2) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d }) : '—');

function useLiveApi(path, options = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}${path}`);
      if (!res.ok) throw new Error(res.statusText);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useEffect(() => {
    if (!options.pollMs) return;
    const id = setInterval(refetch, options.pollMs);
    return () => clearInterval(id);
  }, [refetch, options.pollMs]);
  return { data, loading, error, refetch };
}

export default function LiveTradingDashboard() {
  const { data: quoteData, refetch: refetchQuote } = useLiveApi('/api/live/quote', { pollMs: 10000 });
  const { data: signalData, refetch: refetchSignal } = useLiveApi('/api/live/signal');
  const { data: portfolioData, refetch: refetchPortfolio } = useLiveApi('/api/live/portfolio');
  const { data: ordersData, refetch: refetchOrders } = useLiveApi('/api/live/orders');
  const [killSwitch, setKillSwitch] = useState(false);
  const [mode, setMode] = useState('paper');
  const [actionError, setActionError] = useState(null);

  const quote = quoteData?.quote ?? quoteData?.lastQuote ?? null;
  const health = quoteData?.health || {};
  const signal = signalData?.signal;
  const killOn = signalData?.killSwitch ?? killSwitch;
  const tradingMode = signalData?.mode ?? mode;
  const cash = portfolioData?.cash || {};
  const positions = portfolioData?.positions || [];
  const orders = ordersData?.orders || [];

  useEffect(() => {
    if (signalData?.killSwitch !== undefined) setKillSwitch(signalData.killSwitch);
    if (signalData?.mode !== undefined) setMode(signalData.mode);
  }, [signalData?.killSwitch, signalData?.mode]);

  const doKillSwitch = async (enabled) => {
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/live/kill-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      setKillSwitch(json.killSwitch);
      refetchSignal();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const doMode = async (newMode) => {
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/live/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      setMode(json.mode);
      refetchSignal();
      refetchPortfolio();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const doSync = async () => {
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/live/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Sync failed');
      refetchQuote();
      refetchSignal();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const doTestOrder = async () => {
    setActionError(null);
    try {
      const res = await fetch(`${API}/api/live/order/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || json.reason || 'Test order failed');
      refetchOrders();
      refetchPortfolio();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const isLive = tradingMode === 'live';
  const healthStatus = health?.status || 'unknown';
  const quoteStale = quote?.staleSeconds != null && quote.staleSeconds > 60;

  return (
    <div className="live-trading">
      <header className="live-trading__header">
        <h2 className="live-trading__title">Live Trading (KRW→USD)</h2>
        <div className="live-trading__badges">
          <span className={`live-trading__mode-badge live-trading__mode-badge--${isLive ? 'live' : 'paper'}`}>
            {isLive ? 'LIVE' : 'PAPER'}
          </span>
          {killOn && <span className="live-trading__kill-badge">KILL SWITCH ON</span>}
        </div>
        <div className="live-trading__actions">
          <button type="button" className="live-trading__btn" onClick={() => doSync()}>Sync</button>
          <button type="button" className="live-trading__btn" onClick={() => doTestOrder()}>Test order</button>
          <button
            type="button"
            className={`live-trading__btn live-trading__btn--${killOn ? 'danger' : 'secondary'}`}
            onClick={() => doKillSwitch(!killOn)}
          >
            {killOn ? 'Turn kill switch OFF' : 'Turn kill switch ON'}
          </button>
          {!isLive && (
            <button type="button" className="live-trading__btn live-trading__btn--warn" onClick={() => doMode('live')}>
              Switch to LIVE (requires env)
            </button>
          )}
          {isLive && (
            <button type="button" className="live-trading__btn" onClick={() => doMode('paper')}>Switch to PAPER</button>
          )}
        </div>
      </header>

      {actionError && <div className="live-trading__error">{actionError}</div>}

      <div className="live-trading__grid">
        <section className="live-trading__card card">
          <h3>Live quote</h3>
          <div className="live-trading__quote">
            {quote ? (
              <>
                <span className="live-trading__quote-mid">USD/KRW {fmt(quote.mid ?? (quote.bid + quote.ask) / 2)}</span>
                <span className="live-trading__quote-spread">Spread {fmt(quote.spread ?? (quote.ask - quote.bid))}</span>
                <span className="live-trading__quote-time">
                  {quote.eventTs ? new Date(quote.eventTs).toLocaleTimeString() : '—'}
                  {quoteStale && ' (stale)'}
                </span>
              </>
            ) : (
              <p className="live-trading__no-quote">No quote yet. Run Sync.</p>
            )}
          </div>
        </section>

        <section className="live-trading__card card">
          <h3>Connection health</h3>
          <p className={`live-trading__health live-trading__health--${healthStatus}`}>
            {healthStatus}
            {health?.staleSeconds != null && ` · ${Math.round(health.staleSeconds)}s ago`}
          </p>
        </section>

        <section className="live-trading__card card">
          <h3>Signal</h3>
          {signal ? (
            <>
              <p className={`live-trading__decision live-trading__decision--${(signal.decision || '').toLowerCase()}`}>
                {signal.decision}
              </p>
              <p>Score {fmt(signal.score, 0)} · Allocation {fmt(signal.allocation_pct, 0)}% · Confidence {fmt(signal.confidence, 0)}%</p>
              <p className="live-trading__summary">{signal.reasons?.join('; ') || '—'}</p>
            </>
          ) : (
            <p>No signal yet. Run Sync.</p>
          )}
        </section>

        <section className="live-trading__card card">
          <h3>Position / Cash</h3>
          <p>KRW {fmt(cash.krw, 0)}</p>
          <p>USD {fmt(cash.usd, 2)}</p>
          {positions.length > 0 && (
            <ul>
              {positions.map((p, i) => (
                <li key={i}>{p.symbol} {fmt(p.quantity)} @ {fmt(p.avgPrice)}</li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="live-trading__card card">
        <h3>Order status</h3>
        <div className="live-trading__orders">
          {orders.length === 0 ? (
            <p>No orders yet.</p>
          ) : (
            <table className="live-trading__table">
              <thead>
                <tr>
                  <th>Client ID</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 20).map((o) => (
                  <tr key={o.id}>
                    <td>{o.client_order_id?.slice(0, 16)}</td>
                    <td>{o.side}</td>
                    <td>{fmt(o.quantity)}</td>
                    <td>{o.status}</td>
                    <td>{o.created_at ? new Date(o.created_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="live-trading__card card">
        <h3>Execution log (recent orders)</h3>
        <p className="live-trading__hint">Same as order status; full audit trail in DB (order_events, fills).</p>
      </section>
    </div>
  );
}
