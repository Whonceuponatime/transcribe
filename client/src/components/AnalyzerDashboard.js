import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import './AnalyzerDashboard.css';

const API = '';
const fmt = (n, d = 2) => (n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '—');
const pct = (n) => (n != null ? `${Number(n).toFixed(1)}%` : '—');

// Staircase profit-take levels per strategy doc
const PROFIT_TAKE_LEVELS = [
  { mult: 1.5, label: '+50%', sell: '20%' },
  { mult: 2.0, label: '+100% (2×)', sell: '20%' },
  { mult: 3.0, label: '+200% (3×)', sell: '20%' },
];

// Category colors for deploy section
const DEPLOY_COLORS = {
  'Keep as USD cash': { text: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  'US Index ETFs': { text: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  'Bitcoin / Crypto': { text: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
};

function getDeployColor(category) {
  return DEPLOY_COLORS[category] || { text: '#22c55e', bg: 'rgba(34,197,94,0.10)' };
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
  const [showAnalysis, setShowAnalysis] = useState(false);

  // Fear & Greed Index
  const [fng, setFng] = useState(null);

  // DCA schedule display
  const [showDca, setShowDca] = useState(false);
  const [lastCryptoBuy, setLastCryptoBuy] = useState(null);

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

  // Fetch Fear & Greed index on mount
  const fetchFng = useCallback(async () => {
    try {
      const res = await fetch('https://api.alternative.me/fng/?limit=1');
      if (res.ok) {
        const d = await res.json();
        const entry = d?.data?.[0];
        if (entry) {
          setFng({
            value: Number(entry.value),
            label: entry.value_classification,
            timestamp: entry.timestamp,
          });
        }
      }
    } catch {
      // F&G is optional, non-critical
    }
  }, []);

  useEffect(() => { refresh(); fetchFng(); }, [refresh, fetchFng]);

  const syncAndRefresh = useCallback(async () => {
    setSyncing(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/analyzer?action=sync-live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json();
      if (!j.ok) setError(j.error);
    } catch (e) { setError(e.message); }
    await refresh();
    await fetchFng();
    setSyncing(false);
  }, [refresh, fetchFng]);

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
      const usdSpent = Number(cf.usd) || 0;
      const res = await fetch(`${API}/api/analyzer?action=crypto`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coin: cf.coin || 'BTC', usd_spent: usdSpent, coin_amount: Number(cf.amount) || 0, price_usd: Number(cf.price) || 0, note: cf.note || null }) });
      const j = await res.json();
      if (j.ok) {
        setMsg('Crypto purchase logged');
        if (usdSpent > 0) {
          setLastCryptoBuy({ coin: cf.coin, usdSpent, date: new Date() });
          setShowDca(true);
        }
        setCf({ coin: 'BTC', usd: '', amount: '', price: '', note: '' });
        refresh();
      } else {
        setError(j.error);
      }
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

  // F&G status helper
  const fngStatus = fng ? (fng.value <= 25 ? 'good' : fng.value <= 50 ? 'ok' : fng.value <= 75 ? 'warn' : 'bad') : 'neutral';
  const fngNote = fng ? (
    fng.value <= 25 ? 'Extreme Fear — historically a strong crypto buy signal'
    : fng.value <= 45 ? 'Fear — good crypto entry zone'
    : fng.value <= 55 ? 'Neutral — no strong signal'
    : fng.value <= 75 ? 'Greed — caution, reduce new entries'
    : 'Extreme Greed — wait for pullback before buying crypto'
  ) : '';

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
    {
      label: 'Fear & Greed (crypto)',
      value: fng ? `${fng.value} — ${fng.label}` : '—',
      note: fngNote,
      status: fngStatus,
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

  // DCA schedule: 4 equal weekly tranches from last crypto buy
  function buildDcaPlan(usdSpent, coin, startDate) {
    const tranche = usdSpent / 4;
    return Array.from({ length: 4 }, (_, i) => {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i * 7);
      return {
        week: i + 1,
        amount: tranche,
        date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        done: i === 0,
      };
    });
  }

  if (loading && !signal && !portfolio) return <div className="analyzer"><div className="analyzer__loading">Loading…</div></div>;

  return (
    <div className="analyzer">
      <header className="analyzer__header">
        <div>
          <h2 className="analyzer__title">KRW → USD → Crypto</h2>
          <p className="analyzer__subtitle">Time your KRW→USD conversion, then deploy USD into crypto</p>
        </div>
        <div className="analyzer__actions">
          <button type="button" className="analyzer__btn analyzer__btn--primary" onClick={syncAndRefresh} disabled={syncing}>
            {syncing ? 'Checking…' : signal ? 'Refresh' : 'Check Now'}
          </button>
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

          {(c.positions || []).map((p) => {
            const avgBuy = p.avgPriceUsd || 0;
            return (
              <div key={p.coin} className="analyzer__port-card">
                <span className="analyzer__port-card-title">{p.coin}</span>
                <span className="analyzer__port-card-value">${fmt(p.currentValueUsd, 2)}</span>
                <span className="analyzer__port-card-sub">{fmt(p.amount, 6)} @ ${fmt(p.currentPrice, 2)}</span>
                <span className="analyzer__port-card-sub" style={{ color: profitColor(p.profitUsd || 0) }}>
                  {(p.profitUsd || 0) >= 0 ? '+' : ''}${fmt(p.profitUsd, 2)} ({pct(p.profitPct)})
                </span>
                {/* Profit-take staircase */}
                {avgBuy > 0 && p.currentPrice > 0 && (
                  <div className="analyzer__profit-take">
                    {PROFIT_TAKE_LEVELS.map((lvl) => {
                      const targetPrice = avgBuy * lvl.mult;
                      const reached = p.currentPrice >= targetPrice;
                      return (
                        <span
                          key={lvl.label}
                          className="analyzer__profit-take-step"
                          style={{
                            color: reached ? '#22c55e' : 'var(--text-muted)',
                            background: reached ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.04)',
                          }}
                        >
                          {reached ? '✓' : '○'} {lvl.label} → sell {lvl.sell} @ ${fmt(targetPrice, 0)}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
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
          <div className="analyzer__empty-state">
            <p>Press <strong>Check Now</strong> to get a live recommendation.</p>
            <p className="analyzer__muted">Fetches real-time USD/KRW rate + macro data and tells you exactly how much KRW to convert today.</p>
          </div>
        )}
      </section>

      {/* ═══════════ 2.5 BUY PLANNER ═══════════ */}
      {signal && levels.ma20 && (
        <section className="planner card">
          <h3 className="planner__title">Buy planner</h3>

          {/* 4-item checklist (now includes Fear & Greed) */}
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

      {/* ═══════════ 3. DEPLOY USD INTO CRYPTO (dynamic from signal.usd_deploy) ═══════════ */}
      {signal && (
        <section className="analyzer__card card analyzer__deploy">
          <h3>Deploy your USD into crypto</h3>
          <p className="analyzer__deploy-intro">
            You converted KRW → USD to protect against KRW depreciation. Now put that USD to work:
          </p>

          {/* Fear & Greed banner */}
          {fng && (
            <div className="analyzer__fng-banner" style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              padding: '0.6rem 0.9rem', borderRadius: '6px', marginBottom: '1rem',
              background: fng.value <= 45 ? 'rgba(34,197,94,0.10)' : fng.value <= 55 ? 'rgba(148,163,184,0.10)' : 'rgba(239,68,68,0.10)',
              border: `1px solid ${fng.value <= 45 ? '#22c55e' : fng.value <= 55 ? 'var(--border)' : '#ef4444'}`,
            }}>
              <span style={{ fontSize: '1.25rem' }}>{fng.value <= 25 ? '😱' : fng.value <= 45 ? '😨' : fng.value <= 55 ? '😐' : fng.value <= 75 ? '😏' : '🤑'}</span>
              <div>
                <strong style={{ color: 'var(--text)' }}>Fear &amp; Greed: {fng.value} — {fng.label}</strong>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>{fngNote}</p>
              </div>
            </div>
          )}

          {/* Dynamic deploy rows from signal.usd_deploy */}
          {(signal.usd_deploy && signal.usd_deploy.length > 0) ? (
            signal.usd_deploy.map((item, i) => {
              const col = getDeployColor(item.category);
              return (
                <div key={i} className="analyzer__deploy-row">
                  <div className="analyzer__deploy-header">
                    <span className="analyzer__deploy-cat">{item.category}</span>
                    <span className="analyzer__deploy-pct" style={{ color: col.text, background: col.bg }}>{item.pct}%</span>
                  </div>
                  <p className="analyzer__deploy-reason">{item.reason}</p>
                  <p className="analyzer__deploy-action">→ {item.action}</p>
                </div>
              );
            })
          ) : (
            /* Fallback if no usd_deploy yet */
            <>
              <div className="analyzer__deploy-row">
                <div className="analyzer__deploy-header">
                  <span className="analyzer__deploy-cat">Keep as USD cash</span>
                  <span className="analyzer__deploy-pct" style={{ color: '#94a3b8', background: 'rgba(148,163,184,0.12)' }}>40%</span>
                </div>
                <p className="analyzer__deploy-reason">Liquid emergency reserve in USD. Earns ~5% in US money market funds (e.g. SGOV ETF).</p>
                <p className="analyzer__deploy-action">→ Park in a USD account at Wise or Interactive Brokers.</p>
              </div>
              <div className="analyzer__deploy-row">
                <div className="analyzer__deploy-header">
                  <span className="analyzer__deploy-cat">US Index ETFs</span>
                  <span className="analyzer__deploy-pct" style={{ color: '#3b82f6', background: 'rgba(59,130,246,0.12)' }}>40%</span>
                </div>
                <p className="analyzer__deploy-reason">Long-term S&amp;P 500 returns ~10%/year. Holding KRW earns far less after depreciation.</p>
                <p className="analyzer__deploy-action">→ Buy VOO or QQQ via Interactive Brokers or Korean broker with US access.</p>
              </div>
              <div className="analyzer__deploy-row">
                <div className="analyzer__deploy-header">
                  <span className="analyzer__deploy-cat">Bitcoin / Crypto</span>
                  <span className="analyzer__deploy-pct" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)' }}>20%</span>
                </div>
                <p className="analyzer__deploy-reason">Small crypto allocation (10–20%) can amplify returns. Keep as a speculative bet only.</p>
                <p className="analyzer__deploy-action">→ Buy BTC or ETH on Binance, Coinbase, or Upbit. DCA — don't buy all at once.</p>
              </div>
            </>
          )}

          <div className="analyzer__deploy-reserve">
            <span>Keep 10–20% as USD cash reserve</span>
            <span className="analyzer__muted"> — for dip-buying opportunities</span>
          </div>

          {(signal.next_trigger_to_watch || []).length > 0 && (
            <div className="analyzer__triggers">
              <strong>Watch for these to buy more KRW→USD:</strong>
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

          {/* DCA schedule — shown after logging a crypto buy */}
          {showDca && lastCryptoBuy && (
            <div className="analyzer__dca">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <strong style={{ color: 'var(--text)' }}>DCA Schedule — {lastCryptoBuy.coin}</strong>
                <button type="button" className="analyzer__btn" style={{ padding: '0.15rem 0.5rem', fontSize: '0.8rem' }} onClick={() => setShowDca(false)}>✕</button>
              </div>
              <p className="analyzer__muted" style={{ marginBottom: '0.5rem', fontSize: '0.82rem' }}>
                Split ${fmt(lastCryptoBuy.usdSpent, 2)} into 4 weekly buys instead of all at once:
              </p>
              {buildDcaPlan(lastCryptoBuy.usdSpent, lastCryptoBuy.coin, lastCryptoBuy.date).map((t) => (
                <div key={t.week} className="analyzer__dca-row">
                  <span className="analyzer__dca-week" style={{ color: t.done ? '#22c55e' : 'var(--text-muted)' }}>
                    {t.done ? '✓' : '○'} Week {t.week}
                  </span>
                  <span className="analyzer__dca-date">{t.date}</span>
                  <span className="analyzer__dca-amount">${fmt(t.amount, 2)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ═══════════ 5. RECENT ACTIVITY ═══════════ */}
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

      {/* ═══════════ 6. CHART ═══════════ */}
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

      {/* ═══════════ 7. EXTERNAL SIGNALS PANEL ═══════════ */}
      <section className="analyzer__card card analyzer__external-signals">
        <h3>External signals to watch</h3>
        <p className="analyzer__muted" style={{ marginBottom: '0.75rem', fontSize: '0.88rem' }}>
          Check these before making large KRW→USD or crypto decisions:
        </p>
        <div className="analyzer__ext-grid">
          {[
            { label: 'Fed Rate Decision', desc: 'Rate hike = USD stronger, buy more USD', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', icon: '🏦' },
            { label: 'Fear & Greed Index', desc: fng ? `Now: ${fng.value} — ${fng.label}` : 'Below 30 = good crypto buy zone', url: 'https://alternative.me/crypto/fear-and-greed-index/', icon: '📊' },
            { label: 'Bitcoin Dominance', desc: 'Rising = altcoins weakening, favor BTC', url: 'https://coinmarketcap.com/charts/', icon: '₿' },
            { label: 'Korea Trade Balance', desc: 'Deficit = KRW weakens, buy USD', url: 'https://www.bok.or.kr/eng/main/contents.do?menuNo=400069', icon: '🇰🇷' },
            { label: 'KOSPI', desc: 'Sharp drop often precedes KRW selloff', url: 'https://www.krx.co.kr/main/main.jsp', icon: '📉' },
            { label: 'DXY (Dollar Index)', desc: 'DXY rising = buy USD now before it strengthens', url: 'https://www.tradingview.com/chart/?symbol=TVC%3ADXY', icon: '💵' },
          ].map((sig) => (
            <a key={sig.label} href={sig.url} target="_blank" rel="noopener noreferrer" className="analyzer__ext-card">
              <span className="analyzer__ext-icon">{sig.icon}</span>
              <div className="analyzer__ext-body">
                <span className="analyzer__ext-label">{sig.label}</span>
                <span className="analyzer__ext-desc">{sig.desc}</span>
              </div>
              <span className="analyzer__ext-arrow">↗</span>
            </a>
          ))}
        </div>
      </section>

      {/* ═══════════ 8. FULL ANALYSIS (bottom, expandable) ═══════════ */}
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
