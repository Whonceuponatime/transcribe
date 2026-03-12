import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import './AnalyzerDashboard.css';

const API = '';
const fmt = (n, d = 2) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '—');
const pct = (n) => (n != null ? `${Number(n).toFixed(1)}%` : '—');
const decColor = (d) => (d === 'BUY_NOW' ? '#22c55e' : '#eab308');

function AnalysisDetails({ signal, levels }) {
  const [open, setOpen] = useState(false);
  const sections = signal.why || signal.analysis || [];
  return (
    <section className="analyzer__card card">
      <button type="button" className="analyzer__toggle" onClick={() => setOpen(!open)}>
        {open ? '▾ Hide analysis' : '▸ Show full analysis (why this recommendation)'}
      </button>
      {open && (
        <div className="analyzer__analysis-body">
          {sections.map((section, si) => {
            if (typeof section === 'string') return <p key={si}>{section}</p>;
            if (!section.title) return null;
            return (
              <div key={si} className="analyzer__analysis-section">
                <h4>{section.title}</h4>
                <ul>{(section.points || []).map((p, pi) => <li key={pi}>{p}</li>)}</ul>
              </div>
            );
          })}
          {(signal.red_flags || []).length > 0 && (
            <div className="analyzer__analysis-section analyzer__analysis-section--warn">
              <h4>Risks</h4>
              <ul>{signal.red_flags.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {(signal.next_trigger_to_watch || []).length > 0 && (
            <div className="analyzer__analysis-section analyzer__analysis-section--trigger">
              <h4>Watch for</h4>
              <ul>{signal.next_trigger_to_watch.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          <div className="analyzer__levels">
            <span>MA20: ₩{fmt(levels.ma20, 0)}</span>
            <span>MA60: ₩{fmt(levels.ma60, 0)}</span>
            <span>MA120: ₩{fmt(levels.ma120, 0)}</span>
            {signal.macro_snapshot?.dollar_index && <span>Dollar Index: {fmt(signal.macro_snapshot.dollar_index, 1)}</span>}
            {signal.macro_snapshot?.us10y && <span>US 10Y: {fmt(signal.macro_snapshot.us10y, 2)}%</span>}
            {signal.macro_snapshot?.vix && <span>VIX: {fmt(signal.macro_snapshot.vix, 1)}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

export default function AnalyzerDashboard() {
  const [signal, setSignal] = useState(null);
  const [quote, setQuote] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  // Capital input
  const [capital, setCapital] = useState(() => localStorage.getItem('advisor_capital') || '');
  // Trade form
  const [tf, setTf] = useState({ krw: '', usd: '', rate: '', note: '' });
  // Crypto form
  const [cf, setCf] = useState({ coin: 'BTC', usd: '', amount: '', price: '', note: '' });

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [dashRes, portRes] = await Promise.all([
        fetch(`${API}/api/analyzer?action=dashboard&days=365`),
        fetch(`${API}/api/analyzer?action=portfolio`),
      ]);
      if (dashRes.ok) {
        const d = await dashRes.json();
        setQuote(d.quote); setSignal(d.signal); setSnapshots(d.snapshots || []);
      }
      if (portRes.ok) {
        setPortfolio(await portRes.json());
      }
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const syncLive = useCallback(async () => {
    setSyncing(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/analyzer?action=sync-live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) setError(j.error); else { setMsg('Updated'); refresh(); }
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  }, [refresh]);

  const logUsdBuy = useCallback(async () => {
    setMsg(null);
    const body = { action: 'BUY_USD', krw_amount: Number(tf.krw) || null, usd_amount: Number(tf.usd) || null, fx_rate: Number(tf.rate) || null, note: tf.note || null };
    try {
      const res = await fetch(`${API}/api/analyzer?action=trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (j.ok) { setMsg('USD purchase logged'); setTf({ krw: '', usd: '', rate: '', note: '' }); refresh(); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
  }, [tf, refresh]);

  const logCrypto = useCallback(async () => {
    setMsg(null);
    const body = { coin: cf.coin || 'BTC', usd_spent: Number(cf.usd) || 0, coin_amount: Number(cf.amount) || 0, price_usd: Number(cf.price) || 0, note: cf.note || null };
    try {
      const res = await fetch(`${API}/api/analyzer?action=crypto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (j.ok) { setMsg('Crypto purchase logged'); setCf({ coin: 'BTC', usd: '', amount: '', price: '', note: '' }); refresh(); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
  }, [cf, refresh]);

  const u = portfolio?.usd || {};
  const c = portfolio?.crypto || {};
  const t = portfolio?.total || {};
  const levels = signal?.levels || {};

  const chartData = snapshots.map((s) => ({ date: s.snapshot_ts?.slice(0, 10), rate: s.spot }));

  if (loading && !signal && !portfolio) {
    return <div className="analyzer"><div className="analyzer__loading">Loading…</div></div>;
  }

  return (
    <div className="analyzer">
      <header className="analyzer__header">
        <h2 className="analyzer__title">Buy USD Advisor</h2>
        <p className="analyzer__subtitle">KRW depreciates over time. This tells you when to buy more USD and tracks your gains.</p>
        <div className="analyzer__actions">
          <button type="button" className="analyzer__btn analyzer__btn--primary" onClick={syncLive} disabled={syncing}>
            {syncing ? 'Checking…' : 'Check now'}
          </button>
          <button type="button" className="analyzer__btn" onClick={refresh} disabled={loading}>Refresh</button>
        </div>
      </header>

      {error && <div className="analyzer__error">{error}</div>}
      {msg && <div className="analyzer__success">{msg}</div>}

      {/* ── CAPITAL + ACTION PLAN ── */}
      {(() => {
        const rate = quote?.mid || levels.spot || 0;
        const cap = Number(capital) || 0;
        const allocPct = signal?.allocation_pct || 0;
        const convertKrw = cap > 0 ? Math.round(cap * allocPct / 100) : 0;
        const keepKrw = cap > 0 ? cap - convertKrw : 0;
        const getUsd = rate > 0 ? convertKrw / rate : 0;

        return (
          <section className="analyzer__card card analyzer__action-card" style={{ borderLeft: signal ? `4px solid ${decColor(signal.decision)}` : '4px solid #444' }}>
            <div className="analyzer__rate-row">
              <span className="analyzer__rate-big">₩{fmt(rate, 0)}</span>
              <span className="analyzer__rate-label">per $1 USD</span>
              {quote?.quote_ts && <span className="analyzer__rate-time">{new Date(quote.quote_ts).toLocaleString()}</span>}
            </div>

            <div className="analyzer__capital-input">
              <label>Your available KRW</label>
              <input
                type="number"
                placeholder="e.g. 5000000"
                value={capital}
                onChange={(e) => { setCapital(e.target.value); localStorage.setItem('advisor_capital', e.target.value); }}
              />
            </div>

            {signal ? (
              <>
                <div className="analyzer__signal-row">
                  <span className="analyzer__badge" style={{ background: decColor(signal.decision) }}>
                    {signal.decision === 'BUY_NOW' ? 'BUY NOW' : 'SCALE IN'}
                  </span>
                  <span className="analyzer__alloc-label">{allocPct}% of capital</span>
                  <span className="analyzer__muted">{signal.valuation_label}</span>
                </div>

                {cap > 0 && rate > 0 ? (
                  <div className="analyzer__action-plan">
                    <div className="analyzer__action-main">
                      <div className="analyzer__action-convert">
                        <span className="analyzer__action-label">Convert now</span>
                        <span className="analyzer__action-amount">₩{fmt(convertKrw, 0)} → ${fmt(getUsd, 2)}</span>
                      </div>
                      <div className="analyzer__action-keep">
                        <span className="analyzer__action-label">Keep for later</span>
                        <span className="analyzer__action-amount">₩{fmt(keepKrw, 0)}</span>
                      </div>
                    </div>
                    <p className="analyzer__action-rate">at ₩{fmt(rate, 2)} per USD</p>
                  </div>
                ) : (
                  <p className="analyzer__muted">Enter your KRW capital above to see exact amounts</p>
                )}

                <p className="analyzer__summary">{signal.summary}</p>
              </>
            ) : (
              <p className="analyzer__muted">Click &quot;Check now&quot; to get your recommendation</p>
            )}
          </section>
        );
      })()}

      {/* ── ANALYSIS (collapsible) ── */}
      {signal && (
        <AnalysisDetails signal={signal} levels={levels} />
      )}

      {/* ── USD/KRW CHART ── */}
      {chartData.length > 5 && (
        <section className="analyzer__card card">
          <h3>USD/KRW (past year)</h3>
          <div className="analyzer__chart">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Line type="monotone" dataKey="rate" stroke="#22c55e" dot={false} name="₩/USD" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {/* ── PORTFOLIO SUMMARY ── */}
      {portfolio && (u.totalUsdBought > 0 || (c.positions || []).length > 0) && (
        <section className="analyzer__card card">
          <h3>Your portfolio</h3>
          <div className="analyzer__portfolio">
            <div className="analyzer__port-row">
              <span>Total KRW invested</span>
              <span>₩{fmt(t.totalKrwInvested, 0)}</span>
            </div>
            <div className="analyzer__port-row">
              <span>Current value (KRW)</span>
              <span>₩{fmt(t.totalValueKrw, 0)}</span>
            </div>
            <div className={`analyzer__port-row ${(t.profitKrw || 0) >= 0 ? 'green' : 'red'}`}>
              <span>Total profit</span>
              <span>₩{fmt(t.profitKrw, 0)} ({pct(t.profitPct)})</span>
            </div>
          </div>

          {u.totalUsdBought > 0 && (
            <div className="analyzer__section">
              <h4>USD holdings</h4>
              <div className="analyzer__port-row"><span>USD bought</span><span>${fmt(u.totalUsdBought, 2)}</span></div>
              <div className="analyzer__port-row"><span>Avg buy rate</span><span>₩{fmt(u.avgBuyRate, 0)}</span></div>
              <div className="analyzer__port-row"><span>USD remaining</span><span>${fmt(u.usdRemaining, 2)}</span></div>
              <div className={`analyzer__port-row ${(u.profitKrw || 0) >= 0 ? 'green' : 'red'}`}>
                <span>USD profit (KRW)</span>
                <span>₩{fmt(u.profitKrw, 0)} ({pct(u.profitPct)})</span>
              </div>
            </div>
          )}

          {(c.positions || []).length > 0 && (
            <div className="analyzer__section">
              <h4>Crypto holdings</h4>
              {c.positions.map((p) => (
                <div key={p.coin} className="analyzer__crypto-row">
                  <span className="analyzer__coin">{p.coin}</span>
                  <span>{fmt(p.amount, 6)}</span>
                  <span>${fmt(p.currentPrice, 2)}</span>
                  <span className={p.profitUsd >= 0 ? 'green' : 'red'}>
                    ${fmt(p.profitUsd, 2)} ({pct(p.profitPct)})
                  </span>
                </div>
              ))}
              <div className={`analyzer__port-row ${(c.profitUsd || 0) >= 0 ? 'green' : 'red'}`}>
                <span>Crypto total</span>
                <span>${fmt(c.totalValueUsd, 2)} (profit ${fmt(c.profitUsd, 2)})</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── LOG USD PURCHASE ── */}
      <section className="analyzer__card card">
        <h3>Log USD purchase</h3>
        <div className="analyzer__form">
          <input type="number" placeholder="KRW spent" value={tf.krw} onChange={(e) => setTf((f) => ({ ...f, krw: e.target.value }))} />
          <input type="number" placeholder="USD received" value={tf.usd} onChange={(e) => setTf((f) => ({ ...f, usd: e.target.value }))} />
          <input type="number" placeholder="Rate (₩/USD)" value={tf.rate} onChange={(e) => setTf((f) => ({ ...f, rate: e.target.value }))} />
          <input type="text" placeholder="Note" value={tf.note} onChange={(e) => setTf((f) => ({ ...f, note: e.target.value }))} />
          <button type="button" className="analyzer__btn" onClick={logUsdBuy}>Log</button>
        </div>
      </section>

      {/* ── LOG CRYPTO PURCHASE ── */}
      <section className="analyzer__card card">
        <h3>Log crypto purchase</h3>
        <div className="analyzer__form">
          <select value={cf.coin} onChange={(e) => setCf((f) => ({ ...f, coin: e.target.value }))}>
            {['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK', 'NEAR', 'ARB', 'OP', 'SUI', 'APT', 'PEPE'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input type="number" placeholder="USD spent" value={cf.usd} onChange={(e) => setCf((f) => ({ ...f, usd: e.target.value }))} />
          <input type="number" placeholder="Coins received" value={cf.amount} onChange={(e) => setCf((f) => ({ ...f, amount: e.target.value }))} />
          <input type="number" placeholder="Price per coin ($)" value={cf.price} onChange={(e) => setCf((f) => ({ ...f, price: e.target.value }))} />
          <input type="text" placeholder="Note" value={cf.note} onChange={(e) => setCf((f) => ({ ...f, note: e.target.value }))} />
          <button type="button" className="analyzer__btn" onClick={logCrypto}>Log</button>
        </div>
      </section>

      {/* ── RECENT TRADES ── */}
      {portfolio && ((portfolio.trades || []).length > 0 || (portfolio.cryptoPurchases || []).length > 0) && (
        <section className="analyzer__card card">
          <h3>Recent activity</h3>
          {(portfolio.trades || []).slice(0, 5).map((t) => (
            <div key={t.id} className="analyzer__trade-row">
              <span className="green">BUY USD</span>
              <span>₩{fmt(t.krw_amount, 0)} → ${fmt(t.usd_amount, 2)}</span>
              <span>@ ₩{fmt(t.fx_rate, 0)}</span>
              <span className="analyzer__muted">{t.trade_ts ? new Date(t.trade_ts).toLocaleDateString() : ''}</span>
            </div>
          ))}
          {(portfolio.cryptoPurchases || []).slice(0, 5).map((c) => (
            <div key={c.id} className="analyzer__trade-row">
              <span className="amber">{c.coin}</span>
              <span>${fmt(c.usd_spent, 2)} → {fmt(c.coin_amount, 6)} {c.coin}</span>
              <span>@ ${fmt(c.price_usd, 2)}</span>
              <span className="analyzer__muted">{c.bought_at ? new Date(c.bought_at).toLocaleDateString() : ''}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
