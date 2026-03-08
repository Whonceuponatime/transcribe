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

// ── Minimal SVG line chart ──────────────────────────────────────────────────
function MiniChart({ snapshots, metric }) {
  const W = 560, H = 160, PAD = { top: 12, right: 16, bottom: 36, left: 60 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const values = snapshots.map(s =>
    metric === 'profit_pct' ? s.profit_pct : s.investable_krw
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

  // Y-axis ticks
  const yTicks = 4;
  const yTickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
    minV + (i / yTicks) * range
  );

  // X-axis labels (show up to 6 evenly spaced)
  const maxXLabels = 6;
  const xStep = Math.max(1, Math.ceil(snapshots.length / maxXLabels));
  const xLabelIdxs = snapshots
    .map((_, i) => i)
    .filter(i => i % xStep === 0 || i === snapshots.length - 1);

  return (
    <svg
      className="fincalc__chart-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Grid lines */}
      {yTickVals.map((v, i) => (
        <g key={i}>
          <line
            x1={PAD.left} y1={yOf(v)}
            x2={PAD.left + plotW} y2={yOf(v)}
            className="fincalc__chart-grid"
          />
          <text
            x={PAD.left - 6} y={yOf(v)}
            className="fincalc__chart-tick fincalc__chart-tick--y"
          >
            {metric === 'profit_pct'
              ? `${v.toFixed(1)}%`
              : `₩${(v / 1000).toFixed(0)}k`}
          </text>
        </g>
      ))}

      {/* X-axis labels */}
      {xLabelIdxs.map(i => (
        <text
          key={i}
          x={xOf(i)} y={H - 6}
          className="fincalc__chart-tick fincalc__chart-tick--x"
        >
          {new Date(snapshots[i].created_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
        </text>
      ))}

      {/* Zero line */}
      {minV < 0 && maxV > 0 && (
        <line
          x1={PAD.left} y1={yOf(0)}
          x2={PAD.left + plotW} y2={yOf(0)}
          className="fincalc__chart-zero"
        />
      )}

      {/* Line */}
      <polyline
        points={points}
        fill="none"
        className="fincalc__chart-line"
      />

      {/* Dots + tooltips */}
      {values.map((v, i) => (
        <g key={i} className="fincalc__chart-dot-group">
          <circle
            cx={xOf(i)} cy={yOf(v)} r={4}
            className={`fincalc__chart-dot ${v >= 0 ? 'fincalc__chart-dot--pos' : 'fincalc__chart-dot--neg'}`}
          />
          <title>
            {fmtDate(snapshots[i].created_at)}{'\n'}
            {metric === 'profit_pct'
              ? `Profit: ${v.toFixed(2)}%`
              : `Investable: ₩${fmt(v)}`}
          </title>
        </g>
      ))}
    </svg>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function FinancialCalculator() {
  const { user } = useAuth();

  const [usdAmount, setUsdAmount] = useState('');
  const [buyRate, setBuyRate] = useState('');
  const [sellRate, setSellRate] = useState('');
  const [exchangeFee, setExchangeFee] = useState('1.0');
  const [upbitFee, setUpbitFee] = useState('0.05');
  const [note, setNote] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  const [snapshots, setSnapshots] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [chartMetric, setChartMetric] = useState('investable_krw');
  const [showHistory, setShowHistory] = useState(false);

  const result = useMemo(() => {
    const usd = parseFloat(usdAmount);
    const buy = parseFloat(buyRate);
    const sell = parseFloat(sellRate);
    const fxFeeRate = parseFloat(exchangeFee) / 100;
    const upbitFeeRate = parseFloat(upbitFee) / 100;

    if (!usd || usd <= 0 || !buy || buy <= 0 || !sell || sell <= 0) return null;
    if (isNaN(fxFeeRate) || isNaN(upbitFeeRate)) return null;

    const costKRW = usd * buy;
    const grossValueKRW = usd * sell;
    const fxFeeAmount = grossValueKRW * fxFeeRate;
    const netValueKRW = grossValueKRW - fxFeeAmount;
    const grossProfit = netValueKRW - costKRW;
    const profitPct = (grossProfit / costKRW) * 100;
    const upbitFeeAmount = grossProfit > 0 ? grossProfit * upbitFeeRate : 0;
    const investable = grossProfit > 0 ? grossProfit - upbitFeeAmount : 0;

    return {
      costKRW, grossValueKRW, fxFeeAmount, netValueKRW,
      grossProfit, profitPct, upbitFeeAmount, investable,
    };
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

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  const handleSave = async () => {
    if (!result || !supabase || !user) return;
    setSaving(true);
    setSaveMsg(null);

    const { error } = await supabase.from('forex_snapshots').insert({
      user_id: user.id,
      usd_amount: parseFloat(usdAmount),
      buy_rate: parseFloat(buyRate),
      sell_rate: parseFloat(sellRate),
      fx_fee_pct: parseFloat(exchangeFee),
      upbit_fee_pct: parseFloat(upbitFee),
      cost_krw: result.costKRW,
      gross_value_krw: result.grossValueKRW,
      fx_fee_amount: result.fxFeeAmount,
      net_value_krw: result.netValueKRW,
      gross_profit: result.grossProfit,
      profit_pct: result.profitPct,
      upbit_fee_amount: result.upbitFeeAmount,
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

  return (
    <div className="fincalc">
      <div className="fincalc__header">
        <h2 className="fincalc__title">Forex → Crypto Calculator</h2>
        <p className="fincalc__subtitle">
          Enter your USD position and exchange rate to see how much KRW you can invest in crypto on Upbit.
        </p>
      </div>

      <div className="fincalc__body">
        {/* ── Inputs ────────────────────────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">Position</h3>
          <div className="fincalc__grid">
            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-usd">USD Amount</label>
              <div className="fincalc__input-wrap">
                <span className="fincalc__adornment fincalc__adornment--left">$</span>
                <input
                  id="fc-usd"
                  className="fincalc__input fincalc__input--left-adorn"
                  type="number" min="0" step="any" placeholder="1000"
                  value={usdAmount} onChange={e => setUsdAmount(e.target.value)}
                />
              </div>
              <span className="fincalc__hint">How many dollars you currently hold</span>
            </div>

            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-buy">Buy Rate</label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-buy"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number" min="0" step="any" placeholder="1,300"
                  value={buyRate} onChange={e => setBuyRate(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">KRW</span>
              </div>
              <span className="fincalc__hint">Rate (KRW per $1) when you bought USD</span>
            </div>

            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-sell">Current Rate</label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-sell"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number" min="0" step="any" placeholder="1,400"
                  value={sellRate} onChange={e => setSellRate(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">KRW</span>
              </div>
              <span className="fincalc__hint">Today's selling rate (KRW per $1)</span>
            </div>
          </div>
        </section>

        {/* ── Fees ────────────────────────────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">Fees</h3>
          <div className="fincalc__grid fincalc__grid--fees">
            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-fxfee">FX Conversion Fee</label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-fxfee"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number" min="0" step="0.1" placeholder="1.0"
                  value={exchangeFee} onChange={e => setExchangeFee(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">%</span>
              </div>
              <span className="fincalc__hint">Bank or exchange spread when converting USD → KRW</span>
            </div>

            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-upbit">Upbit Commission</label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-upbit"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number" min="0" step="0.01" placeholder="0.05"
                  value={upbitFee} onChange={e => setUpbitFee(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">%</span>
              </div>
              <span className="fincalc__hint">Upbit trading fee (default: 0.05%)</span>
            </div>
          </div>
        </section>

        {/* ── Results ─────────────────────────────────────── */}
        {result && (
          <section className="fincalc__section fincalc__results card">
            <h3 className="fincalc__section-title">Breakdown</h3>

            <div className="fincalc__table">
              <div className="fincalc__row">
                <span className="fincalc__row-label">USD purchase cost</span>
                <span className="fincalc__row-value">₩ {fmt(result.costKRW)}</span>
              </div>
              <div className="fincalc__row">
                <span className="fincalc__row-label">USD value at current rate</span>
                <span className="fincalc__row-value">₩ {fmt(result.grossValueKRW)}</span>
              </div>
              <div className="fincalc__row fincalc__row--fee">
                <span className="fincalc__row-label">FX conversion fee ({exchangeFee}%)</span>
                <span className="fincalc__row-value fincalc__row-value--neg">− ₩ {fmt(result.fxFeeAmount)}</span>
              </div>
              <div className="fincalc__row fincalc__row--sub">
                <span className="fincalc__row-label">Net KRW received</span>
                <span className="fincalc__row-value">₩ {fmt(result.netValueKRW)}</span>
              </div>
              <div className="fincalc__divider" />
              <div className={`fincalc__row fincalc__row--profit`}>
                <span className="fincalc__row-label">Gross profit</span>
                <span className={`fincalc__row-value ${result.grossProfit >= 0 ? 'fincalc__row-value--pos' : 'fincalc__row-value--neg'}`}>
                  {result.grossProfit >= 0 ? '+ ' : '− '}
                  ₩ {fmt(Math.abs(result.grossProfit))}&ensp;
                  <span className="fincalc__pct">({result.profitPct >= 0 ? '+' : ''}{result.profitPct.toFixed(2)}%)</span>
                </span>
              </div>

              {result.grossProfit > 0 && (
                <>
                  <div className="fincalc__row fincalc__row--fee">
                    <span className="fincalc__row-label">Upbit commission ({upbitFee}%)</span>
                    <span className="fincalc__row-value fincalc__row-value--neg">− ₩ {fmt(result.upbitFeeAmount)}</span>
                  </div>
                  <div className="fincalc__divider" />
                  <div className="fincalc__row fincalc__row--final">
                    <span className="fincalc__row-label">Investable in crypto</span>
                    <span className="fincalc__row-value fincalc__row-value--highlight">₩ {fmt(result.investable)}</span>
                  </div>
                </>
              )}

              {result.grossProfit <= 0 && (
                <div className="fincalc__notice fincalc__notice--loss">
                  Position is currently at a loss — no profit to invest.
                </div>
              )}
            </div>

            {/* ── Save snapshot ── */}
            <div className="fincalc__save-row">
              <input
                className="fincalc__note-input"
                type="text"
                placeholder="Optional note (e.g. 'sold half position')"
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={120}
              />
              <button
                className="btn btn--primary fincalc__save-btn"
                onClick={handleSave}
                disabled={saving || !supabase}
                title={!supabase ? 'Supabase not configured' : ''}
              >
                {saving ? 'Saving…' : 'Save Snapshot'}
              </button>
            </div>
            {saveMsg && (
              <p className={`fincalc__save-msg ${saveMsg.ok ? 'fincalc__save-msg--ok' : 'fincalc__save-msg--err'}`}>
                {saveMsg.text}
              </p>
            )}
          </section>
        )}

        {!result && (usdAmount || buyRate || sellRate) && (
          <div className="fincalc__notice">
            Fill in all three position fields to see results.
          </div>
        )}

        {/* ── History & Chart ─────────────────────────────── */}
        {supabase && (
          <section className="fincalc__section card">
            <div className="fincalc__history-header">
              <h3 className="fincalc__section-title" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                History {snapshots.length > 0 && <span className="fincalc__badge">{snapshots.length}</span>}
              </h3>
              <button
                className="fincalc__toggle-btn"
                onClick={() => setShowHistory(v => !v)}
              >
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
                        className={`fincalc__metric-btn ${chartMetric === 'investable_krw' ? 'active' : ''}`}
                        onClick={() => setChartMetric('investable_krw')}
                      >
                        Investable KRW
                      </button>
                      <button
                        className={`fincalc__metric-btn ${chartMetric === 'profit_pct' ? 'active' : ''}`}
                        onClick={() => setChartMetric('profit_pct')}
                      >
                        Profit %
                      </button>
                    </div>
                    <MiniChart snapshots={snapshots} metric={chartMetric} />
                  </div>
                )}

                {snapshots.length > 0 && (
                  <div className="fincalc__history-table-wrap">
                    <table className="fincalc__history-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>$ Amount</th>
                          <th>Buy</th>
                          <th>Sell</th>
                          <th>Profit %</th>
                          <th>Investable</th>
                          <th>Note</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...snapshots].reverse().map(s => (
                          <tr key={s.id}>
                            <td className="fincalc__td--date">{fmtDate(s.created_at)}</td>
                            <td>${fmt(s.usd_amount, 2)}</td>
                            <td>{fmt(s.buy_rate)}</td>
                            <td>{fmt(s.sell_rate)}</td>
                            <td className={s.profit_pct >= 0 ? 'fincalc__td--pos' : 'fincalc__td--neg'}>
                              {s.profit_pct >= 0 ? '+' : ''}{Number(s.profit_pct).toFixed(2)}%
                            </td>
                            <td>₩ {fmt(s.investable_krw)}</td>
                            <td className="fincalc__td--note">{s.note || '—'}</td>
                            <td>
                              <button
                                className="fincalc__del-btn"
                                onClick={() => handleDelete(s.id)}
                                title="Delete"
                              >
                                ×
                              </button>
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
