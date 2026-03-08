import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import './FinancialCalculator.css';

const fmt = (n, decimals = 0) =>
  Number(n).toLocaleString('ko-KR', { maximumFractionDigits: decimals });

const fmtDate = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
};

// ── Minimal SVG line chart ─────────────────────────────────────────────────
function MiniChart({ snapshots, metric }) {
  const W = 560, H = 160, PAD = { top: 14, right: 16, bottom: 36, left: 64 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = snapshots.map(s =>
    metric === 'profit_pct' ? Number(s.profit_pct) : Number(s.investable_krw)
  );

  if (values.length < 2) {
    return (
      <div className="fincalc__chart-empty">
        Save at least 2 snapshots to see a chart.
      </div>
    );
  }

  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const xOf = (i) => PAD.left + (i / (values.length - 1)) * plotW;
  const yOf = (v) => PAD.top + plotH - ((v - minV) / range) * plotH;
  const points = values.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ');

  const yTicks = Array.from({ length: 5 }, (_, i) => minV + (i / 4) * range);
  const maxXLabels = 6;
  const xStep = Math.max(1, Math.ceil(snapshots.length / maxXLabels));
  const xLabelIdxs = snapshots.map((_, i) => i)
    .filter(i => i % xStep === 0 || i === snapshots.length - 1);

  return (
    <svg className="fincalc__chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} y1={yOf(v)} x2={PAD.left + plotW} y2={yOf(v)} className="fincalc__chart-grid" />
          <text x={PAD.left - 6} y={yOf(v)} className="fincalc__chart-tick fincalc__chart-tick--y">
            {metric === 'profit_pct' ? `${v.toFixed(1)}%` : `₩${(v / 1000).toFixed(0)}k`}
          </text>
        </g>
      ))}
      {xLabelIdxs.map(i => (
        <text key={i} x={xOf(i)} y={H - 6} className="fincalc__chart-tick fincalc__chart-tick--x">
          {new Date(snapshots[i].created_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
        </text>
      ))}
      {minV < 0 && maxV > 0 && (
        <line x1={PAD.left} y1={yOf(0)} x2={PAD.left + plotW} y2={yOf(0)} className="fincalc__chart-zero" />
      )}
      <polyline points={points} fill="none" className="fincalc__chart-line" />
      {values.map((v, i) => (
        <g key={i}>
          <circle cx={xOf(i)} cy={yOf(v)} r={4}
            className={`fincalc__chart-dot ${v >= 0 ? 'fincalc__chart-dot--pos' : 'fincalc__chart-dot--neg'}`} />
          <title>
            {fmtDate(snapshots[i].created_at)}{'\n'}
            {metric === 'profit_pct' ? `Profit: ${v.toFixed(2)}%` : `Investable: ₩${fmt(v)}`}
          </title>
        </g>
      ))}
    </svg>
  );
}

// ── Input field ────────────────────────────────────────────────────────────
function Field({ id, label, hint, prefix, suffix, value, onChange, placeholder, step = 'any' }) {
  return (
    <div className="fincalc__field">
      <label className="fincalc__label" htmlFor={id}>{label}</label>
      <div className="fincalc__input-wrap">
        {prefix && <span className="fincalc__adorn fincalc__adorn--left">{prefix}</span>}
        <input
          id={id}
          className={`fincalc__input${prefix ? ' fincalc__input--pl' : ''}${suffix ? ' fincalc__input--pr' : ''}`}
          type="number"
          min="0"
          step={step}
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
        />
        {suffix && <span className="fincalc__adorn fincalc__adorn--right">{suffix}</span>}
      </div>
      {hint && <span className="fincalc__hint">{hint}</span>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function FinancialCalculator() {
  const { user } = useAuth();

  const [usdAmount, setUsdAmount]   = useState('');
  const [buyRate,   setBuyRate]     = useState('');
  const [sellRate,  setSellRate]    = useState('');
  const [exchangeFee, setExchangeFee] = useState('1.0');
  const [upbitFee,    setUpbitFee]    = useState('0.05');
  const [note, setNote] = useState('');

  const [saving,  setSaving]  = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  const [snapshots,      setSnapshots]      = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chartMetric,    setChartMetric]    = useState('investable_krw');
  const [showHistory,    setShowHistory]    = useState(false);

  const result = useMemo(() => {
    const usd        = parseFloat(usdAmount);
    const buy        = parseFloat(buyRate);
    const sell       = parseFloat(sellRate);
    const fxFeeRate  = parseFloat(exchangeFee) / 100;
    const upbitRate  = parseFloat(upbitFee)    / 100;

    if (!usd || usd <= 0 || !buy || buy <= 0 || !sell || sell <= 0) return null;
    if (isNaN(fxFeeRate) || isNaN(upbitRate)) return null;

    const costKRW       = usd * buy;
    const grossValueKRW = usd * sell;
    const fxFeeAmount   = grossValueKRW * fxFeeRate;
    const netValueKRW   = grossValueKRW - fxFeeAmount;
    const grossProfit   = netValueKRW - costKRW;
    const profitPct     = (grossProfit / costKRW) * 100;
    const upbitFeeAmt   = grossProfit > 0 ? grossProfit * upbitRate : 0;
    const investable    = grossProfit > 0 ? grossProfit - upbitFeeAmt : 0;

    return { costKRW, grossValueKRW, fxFeeAmount, netValueKRW, grossProfit, profitPct, upbitFeeAmt, investable };
  }, [usdAmount, buyRate, sellRate, exchangeFee, upbitFee]);

  const loadSnapshots = useCallback(async () => {
    if (!supabase || !user) return;
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from('forex_snapshots')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    setHistoryLoading(false);
    if (!error && data) setSnapshots(data);
  }, [user]);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const handleSave = async () => {
    if (!result || !supabase || !user) return;
    setSaving(true); setSaveMsg(null);
    const { error } = await supabase.from('forex_snapshots').insert({
      user_id:        user.id,
      usd_amount:     parseFloat(usdAmount),
      buy_rate:       parseFloat(buyRate),
      sell_rate:      parseFloat(sellRate),
      fx_fee_pct:     parseFloat(exchangeFee),
      upbit_fee_pct:  parseFloat(upbitFee),
      cost_krw:       result.costKRW,
      gross_value_krw: result.grossValueKRW,
      fx_fee_amount:  result.fxFeeAmount,
      net_value_krw:  result.netValueKRW,
      gross_profit:   result.grossProfit,
      profit_pct:     result.profitPct,
      upbit_fee_amount: result.upbitFeeAmt,
      investable_krw: result.investable,
      note: note.trim() || null,
    });
    setSaving(false);
    if (error) {
      setSaveMsg({ ok: false, text: error.message });
    } else {
      setSaveMsg({ ok: true, text: 'Snapshot saved.' });
      setNote('');
      await loadSnapshots();
      setShowHistory(true);
    }
  };

  const handleDelete = async (id) => {
    if (!supabase) return;
    await supabase.from('forex_snapshots').delete().eq('id', id);
    setSnapshots(prev => prev.filter(s => s.id !== id));
  };

  const allFilled = usdAmount && buyRate && sellRate;

  return (
    <div className="fincalc">
      <div className="fincalc__header">
        <h2 className="fincalc__title">Forex → Crypto Calculator</h2>
        <p className="fincalc__subtitle">
          Enter how many dollars you bought, the rate you paid, and today's rate — then see your investable crypto budget on Upbit.
        </p>
      </div>

      <div className="fincalc__body">

        {/* ── Step 1: What you bought ───────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">What I bought</h3>
          <div className="fincalc__row2">
            <Field
              id="fc-usd" label="USD amount I bought"
              prefix="$" placeholder="1000"
              value={usdAmount} onChange={setUsdAmount}
              hint="Total dollars purchased"
            />
            <Field
              id="fc-buy" label="Rate I paid"
              suffix="KRW / $1" placeholder="1300"
              value={buyRate} onChange={setBuyRate}
              hint="KRW you spent per dollar"
            />
          </div>
        </section>

        {/* ── Step 2: Today's rate ──────────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">Today's exchange rate</h3>
          <div className="fincalc__row1">
            <Field
              id="fc-sell" label="Current selling rate"
              suffix="KRW / $1" placeholder="1400"
              value={sellRate} onChange={setSellRate}
              hint="How many KRW you get per dollar today"
            />
          </div>
        </section>

        {/* ── Step 3: Fees ──────────────────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">Fees</h3>
          <div className="fincalc__row2">
            <Field
              id="fc-fxfee" label="FX conversion fee"
              suffix="%" placeholder="1.0" step="0.1"
              value={exchangeFee} onChange={setExchangeFee}
              hint="Bank / exchange spread when converting USD → KRW"
            />
            <Field
              id="fc-upbit" label="Upbit commission"
              suffix="%" placeholder="0.05" step="0.01"
              value={upbitFee} onChange={setUpbitFee}
              hint="Upbit trading fee (standard: 0.05%)"
            />
          </div>
        </section>

        {/* ── Incomplete notice ─────────────────────────── */}
        {!result && allFilled === false && (usdAmount || buyRate || sellRate) && (
          <div className="fincalc__notice">
            Fill in all three fields above to see results.
          </div>
        )}

        {/* ── Results ───────────────────────────────────── */}
        {result && (
          <section className="fincalc__section fincalc__results card">
            <h3 className="fincalc__section-title">Breakdown</h3>

            <div className="fincalc__table">
              <div className="fincalc__trow">
                <span>What you paid for your USD</span>
                <span>₩ {fmt(result.costKRW)}</span>
              </div>
              <div className="fincalc__trow">
                <span>USD value at today's rate</span>
                <span>₩ {fmt(result.grossValueKRW)}</span>
              </div>
              <div className="fincalc__trow fincalc__trow--fee">
                <span>FX conversion fee ({exchangeFee}%)</span>
                <span className="neg">− ₩ {fmt(result.fxFeeAmount)}</span>
              </div>
              <div className="fincalc__trow fincalc__trow--sub">
                <span>Net KRW after conversion</span>
                <span>₩ {fmt(result.netValueKRW)}</span>
              </div>

              <div className="fincalc__divider" />

              <div className="fincalc__trow fincalc__trow--profit">
                <span>Gross profit</span>
                <span className={result.grossProfit >= 0 ? 'pos' : 'neg'}>
                  {result.grossProfit >= 0 ? '+' : '−'} ₩ {fmt(Math.abs(result.grossProfit))}
                  <span className="fincalc__pct"> ({result.profitPct >= 0 ? '+' : ''}{result.profitPct.toFixed(2)}%)</span>
                </span>
              </div>

              {result.grossProfit > 0 && (
                <>
                  <div className="fincalc__trow fincalc__trow--fee">
                    <span>Upbit commission ({upbitFee}%)</span>
                    <span className="neg">− ₩ {fmt(result.upbitFeeAmt)}</span>
                  </div>
                  <div className="fincalc__divider" />
                  <div className="fincalc__trow fincalc__trow--final">
                    <span>Investable in crypto</span>
                    <span className="highlight">₩ {fmt(result.investable)}</span>
                  </div>
                </>
              )}

              {result.grossProfit <= 0 && (
                <div className="fincalc__notice fincalc__notice--loss">
                  Position is at a loss — no profit to invest in crypto yet.
                </div>
              )}
            </div>

            {/* Save snapshot */}
            <div className="fincalc__save-row">
              <input
                className="fincalc__note-input"
                type="text"
                placeholder="Optional note (e.g. sold half position)"
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={120}
              />
              <button
                className="fincalc__save-btn"
                onClick={handleSave}
                disabled={saving || !supabase}
                title={!supabase ? 'Supabase not configured' : ''}
              >
                {saving ? 'Saving…' : 'Save Snapshot'}
              </button>
            </div>
            {saveMsg && (
              <p className={`fincalc__save-msg ${saveMsg.ok ? 'ok' : 'err'}`}>{saveMsg.text}</p>
            )}
          </section>
        )}

        {/* ── History & Chart ────────────────────────────── */}
        {supabase && (
          <section className="fincalc__section card">
            <div className="fincalc__history-hdr">
              <h3 className="fincalc__section-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                History
                {snapshots.length > 0 && <span className="fincalc__badge">{snapshots.length}</span>}
              </h3>
              <button className="fincalc__toggle-btn" onClick={() => setShowHistory(v => !v)}>
                {showHistory ? 'Hide' : 'Show'}
              </button>
            </div>

            {showHistory && (
              <>
                {historyLoading && <p className="fincalc__hint">Loading…</p>}

                {!historyLoading && snapshots.length === 0 && (
                  <p className="fincalc__hint">No snapshots yet. Calculate a position and hit Save Snapshot.</p>
                )}

                {snapshots.length >= 2 && (
                  <div className="fincalc__chart-wrap">
                    <div className="fincalc__chart-controls">
                      <button
                        className={`fincalc__metric-btn${chartMetric === 'investable_krw' ? ' active' : ''}`}
                        onClick={() => setChartMetric('investable_krw')}
                      >Investable KRW</button>
                      <button
                        className={`fincalc__metric-btn${chartMetric === 'profit_pct' ? ' active' : ''}`}
                        onClick={() => setChartMetric('profit_pct')}
                      >Profit %</button>
                    </div>
                    <MiniChart snapshots={snapshots} metric={chartMetric} />
                  </div>
                )}

                {snapshots.length > 0 && (
                  <div className="fincalc__history-wrap">
                    <table className="fincalc__history-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>$ Amount</th>
                          <th>Bought at</th>
                          <th>Sold at</th>
                          <th>Profit %</th>
                          <th>Investable</th>
                          <th>Note</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...snapshots].reverse().map(s => (
                          <tr key={s.id}>
                            <td className="muted">{fmtDate(s.created_at)}</td>
                            <td>${fmt(s.usd_amount, 2)}</td>
                            <td>{fmt(s.buy_rate)}</td>
                            <td>{fmt(s.sell_rate)}</td>
                            <td className={Number(s.profit_pct) >= 0 ? 'pos' : 'neg'}>
                              {Number(s.profit_pct) >= 0 ? '+' : ''}{Number(s.profit_pct).toFixed(2)}%
                            </td>
                            <td>₩ {fmt(s.investable_krw)}</td>
                            <td className="muted note-cell">{s.note || '—'}</td>
                            <td>
                              <button className="fincalc__del-btn" onClick={() => handleDelete(s.id)} title="Delete">×</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
