import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import './AnalyzerDashboard.css';

const API = '';
const fmt = (n, d = 2) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '—');
const pct = (n) => (n != null ? `${Number(n).toFixed(1)}%` : '—');

export default function AnalyzerDashboard() {
  const [signal, setSignal] = useState(null);
  const [quote, setQuote] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const [capital, setCapital] = useState(() => localStorage.getItem('advisor_capital') || '');
  const [tf, setTf] = useState({ krw: '', usd: '', rate: '', note: '' });
  const [cf, setCf] = useState({ coin: 'BTC', usd: '', amount: '', price: '', note: '' });

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [dashRes, portRes] = await Promise.all([
        fetch(`${API}/api/analyzer?action=dashboard&days=365`),
        fetch(`${API}/api/analyzer?action=portfolio`),
      ]);
      if (dashRes.ok) { const d = await dashRes.json(); setQuote(d.quote); setSignal(d.signal); setSnapshots(d.snapshots || []); }
      if (portRes.ok) setPortfolio(await portRes.json());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const syncAndRefresh = useCallback(async () => {
    setSyncing(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/analyzer?action=sync-live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) setError(j.error);
    } catch (e) { setError(e.message); }
    await refresh();
    setSyncing(false);
  }, [refresh]);

  const logUsdBuy = useCallback(async () => {
    setMsg(null);
    try {
      const res = await fetch(`${API}/api/analyzer?action=trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'BUY_USD', krw_amount: Number(tf.krw) || null, usd_amount: Number(tf.usd) || null, fx_rate: Number(tf.rate) || null, note: tf.note || null }) });
      const j = await res.json();
      if (j.ok) { setMsg('USD purchase logged'); setTf({ krw: '', usd: '', rate: '', note: '' }); refresh(); } else setError(j.error);
    } catch (e) { setError(e.message); }
  }, [tf, refresh]);

  const logCrypto = useCallback(async () => {
    setMsg(null);
    try {
      const res = await fetch(`${API}/api/analyzer?action=crypto`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: cf.coin || 'BTC', usd_spent: Number(cf.usd) || 0, coin_amount: Number(cf.amount) || 0, price_usd: Number(cf.price) || 0, note: cf.note || null }) });
      const j = await res.json();
      if (j.ok) { setMsg('Crypto purchase logged'); setCf({ coin: 'BTC', usd: '', amount: '', price: '', note: '' }); refresh(); } else setError(j.error);
    } catch (e) { setError(e.message); }
  }, [cf, refresh]);

  const u = portfolio?.usd || {};
  const c = portfolio?.crypto || {};
  const t = portfolio?.total || {};
  const levels = signal?.levels || {};
  const rate = quote?.mid || levels.spot || 0;
  const cap = Number(capital) || 0;
  const allocPct = signal?.allocation_pct || 0;
  const convertKrw = cap > 0 ? Math.round(cap * allocPct / 100) : 0;
  const keepKrw = cap > 0 ? cap - convertKrw : 0;
  const getUsd = rate > 0 ? convertKrw / rate : 0;
  const profitColor = (v) => (v >= 0 ? '#22c55e' : '#ef4444');
  const chartData = snapshots.map((s) => ({ date: s.snapshot_ts?.slice(0, 10), rate: s.spot }));

  // Buy planner
  const premium20 = levels.ma20 ? (rate / levels.ma20 - 1) * 100 : null;
  const premium60 = levels.ma60 ? (rate / levels.ma60 - 1) * 100 : null;
  const percentileNum = levels.percentile252 != null ? levels.percentile252 * 100 : null;
  const zscore = levels.zscore20;
  const plannerVix = signal?.macro_snapshot?.vix;

  const plannerChecks = [
    {
      label: 'Rate vs 20d avg',
      value: premium20 != null ? `${premium20 > 0 ? '+' : ''}${premium20.toFixed(1)}%` : '—',
      note: premium20 == null ? '' : premium20 < -0.5 ? 'Cheap — good to buy more' : premium20 < 1.0 ? 'Fair value' : 'Expensive — buy small',
      status: premium20 == null ? 'neutral' : premium20 < -0.5 ? 'good' : premium20 < 1.0 ? 'ok' : 'warn',
    },
    {
      label: 'Z-score (20d)',
      value: zscore != null ? zscore.toFixed(2) : '—',
      note: zscore == null ? '' : zscore < 0 ? 'Below avg — historically cheap' : zscore < 1 ? 'Normal zone' : zscore < 2 ? 'Above avg — elevated' : 'Very high — consider waiting for pullback',
      status: zscore == null ? 'neutral' : zscore < 0 ? 'good' : zscore < 1 ? 'ok' : zscore < 2 ? 'warn' : 'bad',
    },
    {
      label: 'VIX (fear)',
      value: plannerVix != null ? fmt(plannerVix, 1) : '—',
      note: plannerVix == null ? '' : plannerVix < 20 ? 'Calm markets — stable conditions' : plannerVix < 30 ? 'Moderate volatility — normal' : 'High fear — USD tends to strengthen, watch closely',
      status: plannerVix == null ? 'neutral' : plannerVix < 20 ? 'good' : plannerVix < 30 ? 'ok' : 'warn',
    },
  ];

  const plannerTargets = [
    { label: '20d avg', rate: levels.ma20, pct: 40 },
    { label: '60d avg', rate: levels.ma60, pct: 35 },
    { label: '120d avg', rate: levels.ma120, pct: 25 },
  ].filter((tgt) => tgt.rate && tgt.rate < rate).map((tgt) => {
    const changePct = (tgt.rate - rate) / rate * 100;
    const deployKrw = keepKrw > 0 ? Math.round(keepKrw * tgt.pct / 100) : 0;
    const addUsd = tgt.rate > 0 && deployKrw > 0 ? deployKrw / tgt.rate : 0;
    const existingKrw = u.totalKrwSpent || 0;
    const existingUsd = u.totalUsdBought || 0;
    const newAvg = existingKrw + deployKrw > 0 && existingUsd + addUsd > 0
      ? (existingKrw + deployKrw) / (existingUsd + addUsd)
      : null;
    return { ...tgt, changePct, deployKrw, addUsd, newAvg };
  });

  if (loading && !signal && !portfolio) return <div className="analyzer"><div className="analyzer__loading">Loading…</div></div>;

  return (
    <div className="analyzer">
      <header className="analyzer__header">
        <h2 className="analyzer__title">Buy USD Advisor</h2>
        <div className="analyzer__actions">
          <button type="button" className="analyzer__btn analyzer__btn--primary" onClick={syncAndRefresh} disabled={syncing}>{syncing ? 'Updating…' : 'Update'}</button>
        </div>
      </header>
      {error && <div className="analyzer__error">{error}</div>}
      {msg && <div className="analyzer__success">{msg}</div>}

      {/* ═══════════ 1. PORTFOLIO (top, prominent) ═══════════ */}
      <section className="analyzer__portfolio-hero">
        <div className="analyzer__port-total">
          <span className="analyzer__port-total-label">Total portfolio value</span>
          <span className="analyzer__port-total-value">₩{fmt(t.totalValueKrw || 0, 0)}</span>
          <span className="analyzer__port-total-profit" style={{ color: profitColor(t.profitKrw || 0) }}>
            {(t.profitKrw || 0) >= 0 ? '+' : ''}₩{fmt(t.profitKrw || 0, 0)} ({pct(t.profitPct || 0)})
          </span>
          <span className="analyzer__port-total-invested">₩{fmt(t.totalKrwInvested || 0, 0)} invested</span>
        </div>

        <div className="analyzer__port-cards">
          <div className="analyzer__port-card">
            <span className="analyzer__port-card-title">USD Cash</span>
            <span className="analyzer__port-card-value">${fmt(u.usdRemaining || 0, 2)}</span>
            <span className="analyzer__port-card-sub">Avg rate ₩{fmt(u.avgBuyRate, 0)}</span>
            <span className="analyzer__port-card-sub" style={{ color: profitColor(u.profitKrw || 0) }}>
              {(u.profitKrw || 0) >= 0 ? '+' : ''}₩{fmt(u.profitKrw || 0, 0)} ({pct(u.profitPct || 0)})
            </span>
          </div>

          {(c.positions || []).map((p) => (
            <div key={p.coin} className="analyzer__port-card">
              <span className="analyzer__port-card-title">{p.coin}</span>
              <span className="analyzer__port-card-value">${fmt(p.currentValueUsd, 2)}</span>
              <span className="analyzer__port-card-sub">{fmt(p.amount, 6)} @ ${fmt(p.currentPrice, 2)}</span>
              <span className="analyzer__port-card-sub" style={{ color: profitColor(p.profitUsd || 0) }}>
                {(p.profitUsd || 0) >= 0 ? '+' : ''}${fmt(p.profitUsd, 2)} ({pct(p.profitPct)})
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════ 2. WHAT TO DO NOW ═══════════ */}
      <section className="analyzer__whatnow">
        <h3>What to do now</h3>
        <div className="analyzer__rate-strip">
          <span className="analyzer__rate-big">₩{fmt(rate, 0)}</span>
          <span className="analyzer__rate-label">per $1</span>
          {quote?.quote_ts && <span className="analyzer__rate-time">{new Date(quote.quote_ts).toLocaleString()}</span>}
        </div>

        <div className="analyzer__capital-input">
          <label>Available KRW to invest</label>
          <input type="number" placeholder="e.g. 5000000" value={capital}
            onChange={(e) => { setCapital(e.target.value); localStorage.setItem('advisor_capital', e.target.value); }} />
        </div>

        {signal ? (
          <div className="analyzer__action-box" style={{ borderColor: signal.decision === 'BUY_NOW' ? '#22c55e' : '#eab308' }}>
            <div className="analyzer__action-header">
              <span className="analyzer__badge" style={{ background: signal.decision === 'BUY_NOW' ? '#22c55e' : '#eab308' }}>
                {signal.decision === 'BUY_NOW' ? 'BUY NOW' : 'SCALE IN'}
              </span>
              <span className="analyzer__action-pct">{allocPct}% of capital</span>
            </div>

            {cap > 0 && rate > 0 ? (
              <div className="analyzer__action-numbers">
                <div className="analyzer__action-col">
                  <span className="analyzer__action-col-label">Convert now</span>
                  <span className="analyzer__action-col-krw">₩{fmt(convertKrw, 0)}</span>
                  <span className="analyzer__action-col-usd">→ ${fmt(getUsd, 2)}</span>
                </div>
                <div className="analyzer__action-divider" />
                <div className="analyzer__action-col">
                  <span className="analyzer__action-col-label">Save for later</span>
                  <span className="analyzer__action-col-krw">₩{fmt(keepKrw, 0)}</span>
                  <span className="analyzer__action-col-reason">for better entries</span>
                </div>
              </div>
            ) : (
              <p className="analyzer__muted">Enter your available KRW above</p>
            )}

            {(signal.situation || []).length > 0 && (
              <div className="analyzer__situation">
                {signal.situation.map((s, i) => <p key={i}>{s}</p>)}
              </div>
            )}

            {(signal.red_flags || []).length > 0 && (
              <div className="analyzer__action-risks">
                <strong>Caution:</strong>
                <ul>{signal.red_flags.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
          </div>
        ) : (
          <p className="analyzer__muted">Click &quot;Check now&quot; for your recommendation</p>
        )}
      </section>

      {/* ═══════════ 2.5 BUY PLANNER ═══════════ */}
      {signal && levels.ma20 && (
        <section className="planner card">
          <h3 className="planner__title">Buy planner</h3>

          {/* 3-item checklist */}
          <div className="planner__checklist">
            {plannerChecks.map((chk, i) => (
              <div key={i} className={`planner__check planner__check--${chk.status}`}>
                <span className="planner__check-icon">
                  {chk.status === 'good' ? '✓' : chk.status === 'bad' ? '✗' : chk.status === 'warn' ? '!' : '●'}
                </span>
                <div className="planner__check-body">
                  <span className="planner__check-label">{chk.label}</span>
                  <span className="planner__check-value">{chk.value}</span>
                  {chk.note && <span className="planner__check-note">{chk.note}</span>}
                </div>
              </div>
            ))}
          </div>

          {/* Stats row */}
          <div className="planner__stats">
            {premium20 != null && (
              <div className="planner__stat">
                <span className="planner__stat-label">vs 20d avg</span>
                <span className="planner__stat-value" style={{ color: premium20 > 0 ? '#eab308' : '#22c55e' }}>
                  {premium20 > 0 ? '+' : ''}{premium20.toFixed(2)}%
                </span>
              </div>
            )}
            {premium60 != null && (
              <div className="planner__stat">
                <span className="planner__stat-label">vs 60d avg</span>
                <span className="planner__stat-value" style={{ color: premium60 > 0 ? '#eab308' : '#22c55e' }}>
                  {premium60 > 0 ? '+' : ''}{premium60.toFixed(2)}%
                </span>
              </div>
            )}
            {percentileNum != null && (
              <div className="planner__stat">
                <span className="planner__stat-label">252d percentile</span>
                <span className="planner__stat-value" style={{ color: percentileNum > 80 ? '#ef4444' : percentileNum > 50 ? '#eab308' : '#22c55e' }}>
                  {percentileNum.toFixed(0)}th
                </span>
              </div>
            )}
            {zscore != null && (
              <div className="planner__stat">
                <span className="planner__stat-label">Z-score</span>
                <span className="planner__stat-value" style={{ color: Math.abs(zscore) > 1.5 ? '#eab308' : '#22c55e' }}>
                  {zscore.toFixed(2)}
                </span>
              </div>
            )}
            {u.avgBuyRate > 0 && (
              <div className="planner__stat">
                <span className="planner__stat-label">Your avg buy</span>
                <span className="planner__stat-value" style={{ color: rate < u.avgBuyRate ? '#22c55e' : '#ef4444' }}>
                  ₩{fmt(u.avgBuyRate, 0)}
                </span>
              </div>
            )}
          </div>

          {/* Buy targets */}
          {plannerTargets.length > 0 ? (
            <>
              <h4 className="planner__targets-title">If rate dips — where to buy more</h4>
              <div className="planner__target-list">
                {plannerTargets.map((tgt, i) => (
                  <div key={i} className="planner__target-row">
                    <div className="planner__target-left">
                      <span className="planner__target-label">{tgt.label}</span>
                      <span className="planner__target-rate">₩{fmt(tgt.rate, 0)}</span>
                      <span className="planner__target-change">{tgt.changePct.toFixed(1)}%</span>
                    </div>
                    <div className="planner__target-right">
                      {cap > 0 && keepKrw > 0 ? (
                        <>
                          <span className="planner__target-deploy">Deploy ₩{fmt(tgt.deployKrw, 0)}</span>
                          <span className="planner__target-usd">→ +${fmt(tgt.addUsd, 2)}</span>
                        </>
                      ) : (
                        <span className="planner__target-hint">Enter capital above to see amounts</span>
                      )}
                      {tgt.newAvg != null && cap > 0 && keepKrw > 0 && (
                        <span className="planner__target-newavg">New avg ₩{fmt(tgt.newAvg, 0)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="analyzer__muted" style={{ marginTop: '0.75rem' }}>
              Rate is at or below all moving averages — this is a good buy zone.
            </p>
          )}
        </section>
      )}

      {/* ═══════════ 3. WHAT TO DO WITH YOUR USD ═══════════ */}
      {signal && (
        <section className="analyzer__card card analyzer__deploy">
          <h3>What to do with your USD</h3>
          <p className="analyzer__deploy-intro">
            Once you have USD, don&apos;t leave it idle. Here&apos;s how to deploy it based on current conditions:
          </p>
          {(signal.usd_deploy || [
            { category: 'Keep as USD cash', pct: 40, reason: 'Liquid emergency reserve. Park in SGOV ETF (~5% yield).', action: 'Open USD account at Wise or Interactive Brokers.' },
            { category: 'US Index ETFs', pct: 40, reason: 'S&P 500 returns ~10%/year — beats KRW depreciation long-term.', action: 'Buy VOO or QQQ via Interactive Brokers or Kiwoom.' },
            { category: 'Bitcoin / Crypto', pct: 20, reason: 'Small speculative allocation for higher upside.', action: 'Buy BTC or ETH via Binance, Coinbase, or Upbit.' },
          ]).map((d, i) => (
            <div key={i} className="analyzer__deploy-row">
              <div className="analyzer__deploy-header">
                <span className="analyzer__deploy-cat">{d.category}</span>
                <span className="analyzer__deploy-pct">{d.pct}%</span>
              </div>
              <p className="analyzer__deploy-reason">{d.reason}</p>
              <p className="analyzer__deploy-action">→ {d.action}</p>
            </div>
          ))}
          {(signal.next_trigger_to_watch || []).length > 0 && (
            <div className="analyzer__triggers">
              <strong>Watch for — signals to buy more KRW→USD:</strong>
              <ul>{signal.next_trigger_to_watch.map((trig, i) => <li key={i}>{trig}</li>)}</ul>
            </div>
          )}
        </section>
      )}

      {/* ═══════════ 4. LOG TRADES ═══════════ */}
      <div className="analyzer__log-grid">
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
        <section className="analyzer__card card">
          <h3>Log crypto purchase</h3>
          <div className="analyzer__form">
            <select value={cf.coin} onChange={(e) => setCf((f) => ({ ...f, coin: e.target.value }))}>
              {['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','DOT','LINK','NEAR','ARB','OP','SUI','APT','PEPE'].map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <input type="number" placeholder="USD spent" value={cf.usd} onChange={(e) => setCf((f) => ({ ...f, usd: e.target.value }))} />
            <input type="number" placeholder="Coins received" value={cf.amount} onChange={(e) => setCf((f) => ({ ...f, amount: e.target.value }))} />
            <input type="number" placeholder="Price ($)" value={cf.price} onChange={(e) => setCf((f) => ({ ...f, price: e.target.value }))} />
            <button type="button" className="analyzer__btn" onClick={logCrypto}>Log</button>
          </div>
        </section>
      </div>

      {/* ═══════════ 4. RECENT ACTIVITY ═══════════ */}
      {portfolio && ((portfolio.trades || []).length > 0 || (portfolio.cryptoPurchases || []).length > 0) && (
        <section className="analyzer__card card">
          <h3>Recent activity</h3>
          {(portfolio.trades || []).slice(0, 5).map((tr) => (
            <div key={tr.id} className="analyzer__trade-row">
              <span className="green">BUY USD</span>
              <span>₩{fmt(tr.krw_amount, 0)} → ${fmt(tr.usd_amount, 2)}</span>
              <span>@ ₩{fmt(tr.fx_rate, 0)}</span>
              <span className="analyzer__muted">{tr.trade_ts ? new Date(tr.trade_ts).toLocaleDateString() : ''}</span>
            </div>
          ))}
          {(portfolio.cryptoPurchases || []).slice(0, 5).map((cr) => (
            <div key={cr.id} className="analyzer__trade-row">
              <span className="amber">{cr.coin}</span>
              <span>${fmt(cr.usd_spent, 2)} → {fmt(cr.coin_amount, 6)} {cr.coin}</span>
              <span>@ ${fmt(cr.price_usd, 2)}</span>
              <span className="analyzer__muted">{cr.bought_at ? new Date(cr.bought_at).toLocaleDateString() : ''}</span>
            </div>
          ))}
        </section>
      )}

      {/* ═══════════ 5. CHART ═══════════ */}
      {chartData.length > 5 && (
        <section className="analyzer__card card">
          <h3>USD/KRW history</h3>
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

      {/* ═══════════ 6. FULL ANALYSIS (bottom, expandable) ═══════════ */}
      {signal && (
        <section className="analyzer__card card">
          <button type="button" className="analyzer__toggle" onClick={() => setShowAnalysis(!showAnalysis)}>
            {showAnalysis ? '▾ Hide full analysis' : '▸ Why this recommendation? (full macro analysis)'}
          </button>
          {showAnalysis && (
            <div className="analyzer__analysis-body">
              {(signal.why || signal.analysis || []).map((section, si) => {
                if (typeof section === 'string') return <p key={si}>{section}</p>;
                if (!section?.title) return null;
                return (
                  <div key={si} className="analyzer__analysis-section">
                    <h4>{section.title}</h4>
                    <ul>{(section.points || []).map((p, pi) => <li key={pi}>{p}</li>)}</ul>
                  </div>
                );
              })}
              <div className="analyzer__levels">
                <span>MA20: ₩{fmt(levels.ma20, 0)}</span>
                <span>MA60: ₩{fmt(levels.ma60, 0)}</span>
                <span>MA120: ₩{fmt(levels.ma120, 0)}</span>
                {signal.macro_snapshot?.dollar_index && <span>Dollar: {fmt(signal.macro_snapshot.dollar_index, 1)}</span>}
                {signal.macro_snapshot?.us10y && <span>10Y: {fmt(signal.macro_snapshot.us10y, 2)}%</span>}
                {signal.macro_snapshot?.vix && <span>VIX: {fmt(signal.macro_snapshot.vix, 1)}</span>}
                {signal.macro_snapshot?.oil && <span>Oil: ${fmt(signal.macro_snapshot.oil, 0)}</span>}
                {signal.macro_snapshot?.gold && <span>Gold: ${fmt(signal.macro_snapshot.gold, 0)}</span>}
                {signal.macro_snapshot?.fed_rate && <span>Fed: {fmt(signal.macro_snapshot.fed_rate, 2)}%</span>}
                {signal.macro_snapshot?.bok_rate && <span>BOK: {fmt(signal.macro_snapshot.bok_rate, 2)}%</span>}
                {signal.macro_snapshot?.yuan && <span>CNY: {fmt(signal.macro_snapshot.yuan, 2)}</span>}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
