import React, { useState, useEffect, useCallback } from 'react';
import './LiveTradingDashboard.css';

const API = '';
const fmt = (n, d = 2) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '—');

const DECISION_LABELS = {
  BUY_NOW: 'BUY NOW',
  SCALE_IN: 'SCALE IN',
  WAIT: 'WAIT',
  BLOCKED_BY_RISK: 'BLOCKED',
};

export default function LiveTradingDashboard() {
  const [quote, setQuote] = useState(null);
  const [health, setHealth] = useState(null);
  const [signal, setSignal] = useState(null);
  const [mode, setMode] = useState('paper');
  const [killSwitch, setKillSwitchState] = useState(false);
  const [portfolio, setPortfolio] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [quoteRes, signalRes, portRes, ordersRes] = await Promise.all([
        fetch(`${API}/api/live/quote`),
        fetch(`${API}/api/live/signal`),
        fetch(`${API}/api/live/portfolio`),
        fetch(`${API}/api/live/orders?limit=20`),
      ]);

      if (quoteRes.ok) {
        const d = await quoteRes.json();
        setQuote(d.quote);
        setHealth(d.health);
      }
      if (signalRes.ok) {
        const d = await signalRes.json();
        setSignal(d.signal);
        setMode(d.mode || 'paper');
        setKillSwitchState(d.killSwitch || false);
      }
      if (portRes.ok) {
        setPortfolio(await portRes.json());
      }
      if (ordersRes.ok) {
        const d = await ordersRes.json();
        setOrders(d.orders || []);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const doSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch(`${API}/api/live/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) setError(j.error || 'Sync failed');
      else setMsg('Synced — new signal generated');
    } catch (e) {
      setError(e.message);
    }
    await fetchAll();
    setSyncing(false);
  }, [fetchAll]);

  const toggleKillSwitch = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${API}/api/live/kill-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !killSwitch }),
      });
      const j = await res.json();
      if (j.ok) {
        setKillSwitchState(j.killSwitch);
        setMsg(j.killSwitch ? 'Kill switch activated — all trading halted' : 'Kill switch deactivated');
      } else {
        setError(j.error);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [killSwitch]);

  const changeMode = useCallback(async (newMode) => {
    if (newMode === 'live' && !window.confirm('Switch to LIVE mode? Real money will be at risk.')) return;
    setError(null);
    try {
      const res = await fetch(`${API}/api/live/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });
      const j = await res.json();
      if (j.ok) { setMode(j.mode); setMsg(`Mode set to: ${j.mode}`); }
      else setError(j.error);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const runTestOrder = useCallback(async () => {
    if (!window.confirm('Place a test order (₩13,500 paper buy)?')) return;
    setError(null);
    try {
      const res = await fetch(`${API}/api/live/order/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await res.json();
      if (j.ok) { setMsg('Test order placed'); await fetchAll(); }
      else setError(j.reason ? `${j.reason}: ${j.detail}` : j.error);
    } catch (e) {
      setError(e.message);
    }
  }, [fetchAll]);

  const decisionClass = signal?.decision ? `live-trading__decision--${signal.decision.toLowerCase()}` : '';

  if (loading && !quote && !signal) {
    return (
      <div className="live-trading">
        <div className="live-trading__no-quote">Loading…</div>
      </div>
    );
  }

  return (
    <div className="live-trading">
      {/* Header */}
      <header className="live-trading__header">
        <div>
          <h2 className="live-trading__title">Live Trading — USD/KRW</h2>
        </div>
        <div className="live-trading__badges">
          <span className={`live-trading__mode-badge live-trading__mode-badge--${mode}`}>
            {mode.toUpperCase()}
          </span>
          {killSwitch && (
            <span className="live-trading__kill-badge">KILL SWITCH ON</span>
          )}
        </div>
        <div className="live-trading__actions">
          <button type="button" className="live-trading__btn live-trading__btn--secondary" onClick={doSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
          <button type="button" className={`live-trading__btn ${killSwitch ? 'live-trading__btn--warn' : 'live-trading__btn--danger'}`} onClick={toggleKillSwitch}>
            {killSwitch ? 'Deactivate Kill Switch' : 'Kill Switch'}
          </button>
        </div>
      </header>

      {error && <div className="live-trading__error">{error}</div>}
      {msg && <div style={{ padding: '0.5rem 1rem', background: 'rgba(34,197,94,0.12)', border: '1px solid #22c55e', borderRadius: '4px', marginBottom: '1rem', color: 'var(--text)' }}>{msg}</div>}

      {/* Status grid */}
      <div className="live-trading__grid">

        {/* Quote card */}
        <div className="card live-trading__card">
          <h3>Live Quote</h3>
          {quote ? (
            <div className="live-trading__quote">
              <span className="live-trading__quote-mid">₩{fmt(quote.mid, 0)}</span>
              <span className="live-trading__quote-spread">
                Bid ₩{fmt(quote.bid, 0)} / Ask ₩{fmt(quote.ask, 0)}
              </span>
              {quote.spread && (
                <span className="live-trading__quote-spread">
                  Spread ₩{fmt(quote.spread, 1)} ({quote.mid > 0 ? ((quote.spread / quote.mid) * 10000).toFixed(1) : '—'}bps)
                </span>
              )}
              {quote.event_ts && (
                <span className="live-trading__quote-time">
                  {new Date(quote.event_ts).toLocaleTimeString()}
                </span>
              )}
            </div>
          ) : (
            <p className="live-trading__no-quote">No quote — press Sync Now</p>
          )}
        </div>

        {/* Provider health card */}
        <div className="card live-trading__card">
          <h3>Provider Health</h3>
          {health ? (
            <div>
              <span className={`live-trading__health live-trading__health--${health.status}`}>
                {health.status?.toUpperCase()}
              </span>
              {health.staleSeconds != null && (
                <p className="live-trading__summary">
                  Last quote {health.staleSeconds < 60 ? `${health.staleSeconds}s` : `${Math.round(health.staleSeconds / 60)}m`} ago
                </p>
              )}
              {health.message && <p className="live-trading__summary">{health.message}</p>}
            </div>
          ) : (
            <p className="live-trading__no-quote">—</p>
          )}
        </div>

        {/* Signal card */}
        <div className="card live-trading__card">
          <h3>Latest Signal</h3>
          {signal ? (
            <div>
              <div className={`live-trading__decision ${decisionClass}`}>
                {DECISION_LABELS[signal.decision] || signal.decision}
                {signal.allocation_pct != null && ` — ${signal.allocation_pct}%`}
              </div>
              {signal.score != null && (
                <p className="live-trading__summary">Score: {signal.score} | Confidence: {signal.confidence != null ? `${(signal.confidence * 100).toFixed(0)}%` : '—'}</p>
              )}
              {(signal.reasons || []).slice(0, 2).map((r, i) => (
                <p key={i} className="live-trading__summary">{r}</p>
              ))}
              {signal.signal_ts && (
                <p className="live-trading__summary">{new Date(signal.signal_ts).toLocaleTimeString()}</p>
              )}
            </div>
          ) : (
            <p className="live-trading__no-quote">No signal — press Sync Now</p>
          )}
        </div>

        {/* Portfolio card */}
        <div className="card live-trading__card">
          <h3>Portfolio</h3>
          {portfolio ? (
            <div>
              {portfolio.cash && (
                <p className="live-trading__summary">
                  USD Cash: ${fmt(portfolio.cash?.usd, 2)}<br />
                  KRW Cash: ₩{fmt(portfolio.cash?.krw, 0)}
                </p>
              )}
              {portfolio.snapshot && (
                <p className="live-trading__summary">
                  {portfolio.snapshot.avg_buy_rate && `Avg rate: ₩${fmt(portfolio.snapshot.avg_buy_rate, 0)}`}
                  {portfolio.snapshot.unrealized_pnl_krw != null && (
                    <><br />Unrealized P&L: {portfolio.snapshot.unrealized_pnl_krw >= 0 ? '+' : ''}₩{fmt(portfolio.snapshot.unrealized_pnl_krw, 0)}</>
                  )}
                </p>
              )}
              {(portfolio.positions || []).map((p) => (
                <p key={p.symbol || p.contractDesc} className="live-trading__summary">
                  {p.symbol || p.contractDesc}: {fmt(p.quantity, 4)} @ ${fmt(p.avgCost, 2)}
                </p>
              ))}
            </div>
          ) : (
            <p className="live-trading__no-quote">—</p>
          )}
        </div>

      </div>

      {/* Mode controls */}
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Mode:</span>
        <button
          type="button"
          className={`live-trading__btn ${mode === 'paper' ? 'live-trading__btn--secondary' : ''}`}
          onClick={() => changeMode('paper')}
        >
          Paper
        </button>
        <button
          type="button"
          className={`live-trading__btn ${mode === 'live' ? 'live-trading__btn--danger' : ''}`}
          onClick={() => changeMode('live')}
        >
          Live
        </button>
        <button
          type="button"
          className="live-trading__btn"
          onClick={runTestOrder}
          style={{ marginLeft: 'auto' }}
        >
          Place Test Order
        </button>
        <p className="live-trading__hint" style={{ width: '100%', marginTop: 0 }}>
          Paper mode is always safe. Live mode requires <code>LIVE_TRADING_ENABLED=true</code> and IBKR credentials.
        </p>
      </div>

      {/* Orders table */}
      <div className="card" style={{ padding: '1rem' }}>
        <h3 style={{ marginBottom: '0.75rem' }}>Recent Orders</h3>
        {orders.length > 0 ? (
          <div className="live-trading__orders">
            <table className="live-trading__table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Notional</th>
                  <th>Mode</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.created_at ? new Date(o.created_at).toLocaleString() : '—'}</td>
                    <td>{o.symbol}</td>
                    <td style={{ color: o.side === 'buy' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                      {o.side?.toUpperCase()}
                    </td>
                    <td>{fmt(o.quantity, 4)}</td>
                    <td>{o.notional_krw ? `₩${fmt(o.notional_krw, 0)}` : '—'}</td>
                    <td>{o.mode}</td>
                    <td style={{ color: o.status === 'filled' ? '#22c55e' : o.status === 'rejected' ? '#ef4444' : '#eab308' }}>
                      {o.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="live-trading__no-quote">No orders yet. Press "Sync Now" to generate a signal, then "Place Test Order" to test the pipeline.</p>
        )}
      </div>

      {/* Safety info */}
      {(signal?.safeguards || []).length > 0 && (
        <div className="card" style={{ padding: '1rem', marginTop: '1rem', border: '1px solid #f59e0b', borderRadius: '6px' }}>
          <h3 style={{ color: '#f59e0b', marginBottom: '0.5rem' }}>Active Safeguards</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {signal.safeguards.map((s, i) => (
              <li key={i} style={{ color: 'var(--text)', fontSize: '0.9rem' }}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
