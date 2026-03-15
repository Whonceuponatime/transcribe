import React, { useState, useEffect, useCallback } from 'react';
import './CryptoTraderDashboard.css';

const API = '';
const fmt    = (n, d = 0) => n != null ? Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d }) : '—';
const fmtUsd = (n, d = 0) => n != null ? `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: d })}` : '—';
const fmtCoin = (n) => n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';
const pct    = (n) => n != null ? `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(1)}%` : '—';

const REASON_LABELS = {
  // DCA buys
  DCA: 'DCA', 'DCA_1.0x': 'DCA', 'DCA_1.5x': 'DCA x1.5', 'DCA_2.0x': 'DCA x2', 'DCA_3.0x': 'DCA x3',
  // Profit-take sells
  PROFIT_TAKE_5PCT: '+5% Take', PROFIT_TAKE_10PCT: '+10% Take', PROFIT_TAKE_20PCT: '+20% Take', PROFIT_TAKE_40PCT: '+40% Take',
  // Signal sells
  SIGNAL_RSI_OVERBOUGHT: 'RSI OB', SIGNAL_RSI_OB_STRONG: 'RSI OB!',
  SIGNAL_BB_UPPER: 'BB Upper', SIGNAL_MACD_BEAR: 'MACD Bear', SIGNAL_STOCHRSI_OB: 'StochRSI OB',
  SIGNAL_VWAP_ABOVE: 'VWAP High', SIGNAL_WILLIAMS_OB: 'Williams OB', SIGNAL_CCI_OB: 'CCI OB',
  SIGNAL_KIMCHI_HIGH: 'Kimchi High',
  TRAILING_STOP: 'Trail Stop',
  // Dip buys
  DIP_RSI_EXTREME_OS: 'RSI Dip!!', DIP_RSI_OVERSOLD: 'RSI Dip',
  DIP_BB_BELOW_LOWER: 'BB Dip', DIP_VWAP_DEEP_BELOW: 'VWAP Dip',
  DIP_WILLIAMS_DEEP_OS: 'Williams Dip', DIP_CCI_DEEP_OS: 'CCI Dip',
  DIP_STOCHRSI_OS: 'StochRSI Dip', DIP_MACD_BULL_CROSS: 'MACD Bull',
  DIP_ROC_SHARP_DIP: 'ROC Dip', DIP_EMERGENCY_24H: 'Emergency Dip',
};

const rsiColor = (v) => v == null ? '#666' : v > 70 ? '#ef4444' : v < 30 ? '#22c55e' : '#f59e0b';

const FNG_COLOR = (v) => v > 75 ? '#ef4444' : v > 55 ? '#f59e0b' : v > 45 ? '#888' : v > 25 ? '#22c55e' : '#00e5ff';
const FNG_LABEL = (v) => v > 75 ? 'Extreme Greed' : v > 55 ? 'Greed' : v > 45 ? 'Neutral' : v > 25 ? 'Fear' : 'Extreme Fear';

function Toggle({ checked, onChange }) {
  return (
    <label className="ct__toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ct__toggle-slider" />
    </label>
  );
}

export default function CryptoTraderDashboard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [triggerPending, setTriggerPending] = useState(false);

  // Config form state (synced from status)
  const [cfg, setCfg] = useState({
    dca_enabled: true,
    weekly_budget_krw: 100000,
    profit_take_enabled: true,
    signal_boost_enabled: true,
    fear_greed_gate_enabled: true,
    trailing_stop_enabled: true,
    bear_market_pause_enabled: true,
    min_signal_score: 0,
    capital_pct_mode: false,
    dca_pct_of_krw: 20,
    dip_pct_of_krw: 10,
    max_dca_krw: 0,
    max_dip_krw: 0,
  });

  const fetchStatus = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=status`);
      if (res.ok) {
        const d = await res.json();
        setStatus(d);
        setTriggerPending(d.triggerPending ?? false);
        setCfg({
          dca_enabled: d.config?.dca_enabled ?? true,
          weekly_budget_krw: d.config?.weekly_budget_krw ?? 100000,
          profit_take_enabled: d.config?.profit_take_enabled ?? true,
          signal_boost_enabled: d.config?.signal_boost_enabled ?? true,
          fear_greed_gate_enabled: d.config?.fear_greed_gate_enabled ?? true,
          trailing_stop_enabled: d.config?.trailing_stop_enabled ?? true,
          bear_market_pause_enabled: d.config?.bear_market_pause_enabled ?? true,
          min_signal_score: d.config?.min_signal_score ?? 0,
          capital_pct_mode: d.config?.capital_pct_mode ?? false,
          dca_pct_of_krw: d.config?.dca_pct_of_krw ?? 20,
          dip_pct_of_krw: d.config?.dip_pct_of_krw ?? 10,
          max_dca_krw: d.config?.max_dca_krw ?? 0,
          max_dip_krw: d.config?.max_dip_krw ?? 0,
        });
      } else {
        const e = await res.json();
        setError(e.error || 'Failed to load status');
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const execute = useCallback(async (forceDca = false) => {
    if (!window.confirm(forceDca
      ? 'Force a DCA buy NOW regardless of schedule? Real money will be spent.'
      : 'Run one trade cycle (profit-take check + DCA if due)?')) return;
    setExecuting(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceDca }),
      });
      const j = await res.json();
      if (j.ok) {
        setTriggerPending(true);
        setMsg('Trigger sent — Pi trader will execute within 10 seconds. Refresh to see results.');
        // Poll for result: refresh every 5s for up to 30s
        let polls = 0;
        const poll = setInterval(async () => {
          polls++;
          await fetchStatus();
          if (polls >= 6) clearInterval(poll);
        }, 5000);
      } else {
        setError(j.error);
      }
    } catch (e) { setError(e.message); }
    setExecuting(false);
  }, [fetchStatus]);

  const saveConfig = useCallback(async () => {
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const j = await res.json();
      if (j.ok) { setMsg('Config saved'); await fetchStatus(); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }, [cfg, fetchStatus]);

  const toggleKillSwitch = useCallback(async () => {
    const isOn = !!(status?.killSwitch);
    if (!isOn && !window.confirm('Activate kill switch? All automated trading will stop immediately.')) return;
    setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=kill-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !isOn }),
      });
      const j = await res.json();
      if (j.ok) { setMsg(`Kill switch ${j.killSwitch ? 'activated' : 'deactivated'}`); await fetchStatus(); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
  }, [status, fetchStatus]);

  const killSwitch     = status?.killSwitch ?? false;
  const positions      = status?.positions ?? [];
  const trades         = status?.recentTrades ?? [];
  const signalScore    = status?.signalScore;
  const signalDecision = status?.signalDecision;
  const krwBalance     = status?.krwBalance ?? 0;
  const usdKrw         = status?.usdKrw ?? null;
  const totalValueUsd  = status?.totalValueUsd ?? null;
  const piOnline       = status?.piOnline ?? false;
  const piLastSeen     = status?.piLastSeen ?? null;
  const lastCycle      = status?.lastCycle ?? null;
  const fearGreed      = status?.fearGreed ?? null;

  // Total cost basis across all coins
  const totalCostKrw = positions.reduce((s, p) => s + (p.avgBuyKrw > 0 ? p.avgBuyKrw * p.balance : 0), 0);
  const totalHoldingsKrw = positions.reduce((s, p) => s + (p.currentValueKrw ?? 0), 0);
  const totalPnlKrw = totalHoldingsKrw - totalCostKrw;
  const totalPnlUsd = usdKrw && totalPnlKrw ? totalPnlKrw / usdKrw : null;

  const pill = (key, label, val, col) => (
    <span key={key} className="ct__ind-pill"
      style={{ background: `${col}18`, color: col, border: `1px solid ${col}28` }}>
      {label} {val}
    </span>
  );

  return (
    <div className="ct">
      {/* ═══ HEADER ═══ */}
      <header className="ct__header">
        <div>
          <h2 className="ct__title">Upbit Auto-Trader</h2>
          <p className="ct__subtitle">BTC · ETH · SOL — signal-driven, runs 24/7 on Pi</p>
        </div>
        <div className="ct__badges">
          {killSwitch && <span className="ct__badge ct__badge--kill">KILL SWITCH ON</span>}
          <span className={`ct__badge ${cfg.dca_enabled ? 'ct__badge--on' : 'ct__badge--off'}`}>DCA {cfg.dca_enabled ? 'ON' : 'OFF'}</span>
          {triggerPending && <span className="ct__badge ct__badge--signal">Pending…</span>}
        </div>
        <div className="ct__actions">
          <button className="ct__btn" onClick={fetchStatus} disabled={loading}>{loading ? '…' : 'Refresh'}</button>
          <button className="ct__btn ct__btn--primary" onClick={() => execute(false)} disabled={executing}>{executing ? 'Running…' : 'Run Cycle'}</button>
          <button className="ct__btn ct__btn--warn" onClick={() => execute(true)} disabled={executing}>Force DCA</button>
          <button className={`ct__btn ct__btn--danger`} onClick={toggleKillSwitch}>
            {killSwitch ? 'Deactivate Kill' : 'Kill Switch'}
          </button>
        </div>
      </header>

      {error && <div className="ct__error">{error}</div>}
      {msg   && <div className="ct__success">{msg}</div>}

      {/* ═══ PORTFOLIO TOTAL ═══ */}
      <div className="ct__portfolio-hero">
        <div className="ct__portfolio-total">
          <div className="ct__portfolio-label">Total Portfolio</div>
          <div className="ct__portfolio-value">
            {totalValueUsd != null ? fmtUsd(totalValueUsd, 0) : '—'}
          </div>
          {status?.totalValueKrw != null && (
            <div className="ct__portfolio-krw">₩{fmt(status.totalValueKrw)} total incl. cash</div>
          )}
          {totalCostKrw > 0 && (
            <div className="ct__portfolio-pnl" style={{ color: totalPnlKrw >= 0 ? '#22c55e' : '#ef4444' }}>
              {totalPnlKrw >= 0 ? '+' : ''}₩{fmt(Math.abs(totalPnlKrw))}
              {totalPnlUsd != null && ` / ${totalPnlKrw >= 0 ? '+' : ''}${fmtUsd(Math.abs(totalPnlUsd), 0)}`}
              {' '}unrealised P&L
            </div>
          )}
        </div>
        <div className="ct__portfolio-meta">
          {fearGreed && (
            <>
              <div className="ct__meta-item" style={{ textAlign: 'center' }}>
                <span className="ct__meta-label">Fear & Greed</span>
                <span className="ct__meta-val" style={{ color: FNG_COLOR(fearGreed.value) }}>{fearGreed.value}</span>
                <span className="ct__meta-sub" style={{ color: FNG_COLOR(fearGreed.value) }}>
                  {FNG_LABEL(fearGreed.value)}{fearGreed.value > 75 ? ' · DCA off' : fearGreed.value < 25 ? ' · DCA ×2' : ''}
                </span>
              </div>
              <div className="ct__meta-sep" />
            </>
          )}
          {signalScore != null && (
            <>
              <div className="ct__meta-item" style={{ textAlign: 'center' }}>
                <span className="ct__meta-label">Macro</span>
                <span className="ct__meta-val" style={{ color: '#f59e0b' }}>{signalScore}/10</span>
                <span className="ct__meta-sub">{signalDecision?.replace(/_/g, ' ')}</span>
              </div>
              <div className="ct__meta-sep" />
            </>
          )}
          {usdKrw && (
            <div className="ct__meta-item">
              <span className="ct__meta-label">USD/KRW</span>
              <span className="ct__meta-val">₩{fmt(usdKrw)}</span>
            </div>
          )}
          {status?.config?.last_dca_run && (
            <>
              <div className="ct__meta-sep" />
              <div className="ct__meta-item">
                <span className="ct__meta-label">Last DCA</span>
                <span className="ct__meta-sub">{new Date(status.config.last_dca_run).toLocaleDateString()}</span>
              </div>
            </>
          )}
          <div className="ct__meta-sep" />
          <div className="ct__meta-item">
            <span className="ct__meta-label">Pi Status</span>
            <span className="ct__meta-val" style={{ color: piOnline ? '#22c55e' : '#ef4444', display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: piOnline ? '#22c55e' : '#ef4444', display: 'inline-block', boxShadow: piOnline ? '0 0 5px #22c55e' : 'none' }} />
              {piOnline ? 'Online' : 'Offline'}
            </span>
            {piLastSeen && <span className="ct__meta-sub">{new Date(piLastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        </div>
      </div>

      {/* ═══ ALL ASSETS ═══ */}
      <div className="ct__asset-grid">
        {/* KRW Cash card */}
        <div className="ct__krw-card">
          <div className="ct__krw-card-label">KRW Cash</div>
          <div className="ct__krw-card-value">₩{fmt(krwBalance)}</div>
          {usdKrw && <div className="ct__krw-card-usd">{fmtUsd(krwBalance / usdKrw, 0)}</div>}
          <div className="ct__krw-card-sub" style={{ marginTop: '0.4rem' }}>
            {status?.effectiveDcaBudget != null
              ? `Next DCA: ₩${fmt(status.effectiveDcaBudget)}`
              : cfg.weekly_budget_krw > 0 && krwBalance > 0
                ? `~${Math.floor(krwBalance / cfg.weekly_budget_krw)}w DCA remaining`
                : 'Set budget in settings'}
          </div>
          {status?.effectiveDipBudget != null && (
            <div className="ct__krw-card-sub">Dip budget: ₩{fmt(status.effectiveDipBudget)}</div>
          )}
        </div>

        {/* Crypto coin cards */}
        {positions.map((pos) => {
          const g       = pos.gainPct;
          const cardMod = pos.balance <= 0 ? 'flat' : g == null ? 'flat' : g > 0 ? 'up' : g < 0 ? 'down' : 'flat';
          const pnlKrw  = pos.avgBuyKrw > 0 && pos.currentValueKrw != null
            ? pos.currentValueKrw - pos.avgBuyKrw * pos.balance : null;
          const pnlUsd  = pnlKrw != null && usdKrw ? pnlKrw / usdKrw : null;
          const ind     = pos.indicators ?? {};

          return (
            <div key={pos.coin} className={`ct__coin-card ct__coin-card--${cardMod}`}>
              <div className="ct__coin-header">
                <span className="ct__coin-ticker">{pos.coin}</span>
                {g != null && pos.balance > 0 && (
                  <span className={`ct__coin-pnl-badge ct__coin-pnl-badge--${cardMod}`}>{pct(g)}</span>
                )}
              </div>

              <div className="ct__coin-price">₩{fmt(pos.currentPrice)}</div>
              {pos.currentPrice && usdKrw && (
                <div className="ct__coin-price-usd">{fmtUsd(pos.currentPrice / usdKrw, 2)}</div>
              )}

              <div className="ct__coin-divider" />

              <div className="ct__coin-row">
                <span className="ct__coin-label">Holdings</span>
                <span className="ct__coin-value">{fmtCoin(pos.balance)} {pos.coin}</span>
              </div>
              <div className="ct__coin-row">
                <span className="ct__coin-label">Value</span>
                <span className="ct__coin-value">
                  ₩{fmt(pos.currentValueKrw)}
                  {pos.currentValueUsd != null && <span className="ct__coin-value--dim"> · {fmtUsd(pos.currentValueUsd, 0)}</span>}
                </span>
              </div>
              <div className="ct__coin-row">
                <span className="ct__coin-label">Avg buy</span>
                <span className="ct__coin-value" style={{ color: '#666' }}>
                  ₩{fmt(pos.avgBuyKrw)}
                  {pos.avgBuyUsd != null && <span className="ct__coin-value--dim"> · {fmtUsd(pos.avgBuyUsd, 0)}</span>}
                </span>
              </div>

              {pnlKrw != null && pos.balance > 0 && (
                <div className={`ct__coin-pnl-abs ct__coin-pnl-abs--${cardMod}`}>
                  {pnlKrw >= 0 ? '+' : ''}₩{fmt(Math.abs(pnlKrw))}
                  {pnlUsd != null && ` / ${pnlKrw >= 0 ? '+' : ''}${fmtUsd(Math.abs(pnlUsd), 0)}`}
                </div>
              )}
              {pos.balance <= 0 && <div style={{ fontSize: '0.72rem', color: '#444', marginTop: '0.2rem' }}>No position</div>}

              {pos.dropFromHigh != null && pos.dropFromHigh > 10 && (
                <div style={{ fontSize: '0.68rem', color: pos.dropFromHigh > 25 ? '#ef4444' : '#f59e0b', marginTop: '0.1rem' }}>
                  ↓{pos.dropFromHigh.toFixed(1)}% from 14d high{pos.dropFromHigh > 25 ? ' ⚠' : ''}
                </div>
              )}
              {pos.nextProfitTakeLevel && pos.balance > 0 && (
                <div style={{ fontSize: '0.66rem', color: '#444', marginTop: '0.05rem' }}>Next: {pos.nextProfitTakeLevel}</div>
              )}

              {/* Indicator pills */}
              {Object.keys(ind).length > 0 && (
                <div className="ct__coin-indicators">
                  {(() => {
                    const pills = [];
                    const sc = ind.scoreCombined != null ? Number(ind.scoreCombined) : null;
                    if (sc != null) {
                      const c = sc >= 3 ? '#22c55e' : sc <= -3 ? '#ef4444' : sc > 0 ? '#86efac' : sc < 0 ? '#fca5a5' : '#555';
                      pills.push(pill('sc', 'Score', `${sc > 0 ? '+' : ''}${sc}`, c));
                    }
                    if (ind.rsi != null) pills.push(pill('rsi', 'RSI', ind.rsi, rsiColor(Number(ind.rsi))));
                    if (ind.williamsR != null) {
                      const w = Number(ind.williamsR);
                      pills.push(pill('wr', '%R', ind.williamsR, w > -20 ? '#ef4444' : w < -80 ? '#22c55e' : '#555'));
                    }
                    if (ind.cci != null) {
                      const c2 = Number(ind.cci);
                      pills.push(pill('cci', 'CCI', ind.cci, c2 > 100 ? '#ef4444' : c2 < -100 ? '#22c55e' : '#555'));
                    }
                    if (ind.vwapDev != null) {
                      const v = Number(ind.vwapDev);
                      pills.push(pill('vw', 'VWAP', `${v >= 0 ? '+' : ''}${ind.vwapDev}%`, v > 2 ? '#ef4444' : v < -2 ? '#22c55e' : '#555'));
                    }
                    if (ind.obImbalance != null) {
                      const ob = Number(ind.obImbalance);
                      pills.push(pill('ob', 'OB', `${ob}%`, ob > 60 ? '#22c55e' : ob < 40 ? '#ef4444' : '#555'));
                    }
                    if (ind.kimchiPremium != null) {
                      const k = Number(ind.kimchiPremium);
                      pills.push(pill('ki', 'Kimchi', `${k >= 0 ? '+' : ''}${ind.kimchiPremium}%`, k > 3 ? '#ef4444' : k < 0 ? '#22c55e' : '#f59e0b'));
                    }
                    if (ind.macdBull) pills.push(pill('mb', 'MACD', '↑', '#22c55e'));
                    if (ind.macdBear) pills.push(pill('md', 'MACD', '↓', '#ef4444'));
                    return pills;
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ═══ RECENT TRADES ═══ */}
      <div className="ct__section">
        <h3 className="ct__section-title">Recent Trades</h3>
        {trades.length > 0 ? (
          <div className="ct__trades">
            <table className="ct__table">
              <thead>
                <tr><th>Time</th><th>Coin</th><th>Side</th><th>KRW</th><th>Coins</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td>{t.executed_at ? new Date(t.executed_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    <td style={{ fontWeight: 700 }}>{t.coin}</td>
                    <td className={`ct__side--${t.side}`}>{t.side === 'buy' ? '↑ BUY' : '↓ SELL'}</td>
                    <td>{t.krw_amount ? `₩${fmt(t.krw_amount)}` : '—'}</td>
                    <td>{t.coin_amount ? fmtCoin(t.coin_amount) : '—'}</td>
                    <td><span className="ct__reason">{REASON_LABELS[t.reason] || t.reason}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="ct__empty">No trades yet — bot is watching for signals every 5 minutes.</p>
        )}
      </div>

      {/* ═══ BOT SETTINGS ═══ */}
      <div className="ct__section">
        <h3 className="ct__section-title">Bot Settings</h3>

        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">DCA Enabled</div><div className="ct__toggle-sub">Buy weekly on schedule</div></div>
          <Toggle checked={cfg.dca_enabled} onChange={(v) => setCfg((c) => ({ ...c, dca_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Signal Boost</div><div className="ct__toggle-sub">Spend 50% extra when macro score ≥ 5</div></div>
          <Toggle checked={cfg.signal_boost_enabled} onChange={(v) => setCfg((c) => ({ ...c, signal_boost_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Profit-Take</div><div className="ct__toggle-sub">Sell 10/15/20/25% at +5/10/20/40% gain</div></div>
          <Toggle checked={cfg.profit_take_enabled} onChange={(v) => setCfg((c) => ({ ...c, profit_take_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Signal Sells</div><div className="ct__toggle-sub">RSI OB, VWAP high, Williams OB, CCI OB, Kimchi high, MACD bear…</div></div>
          <Toggle checked={cfg.signal_sell_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, signal_sell_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Dip Buys</div><div className="ct__toggle-sub">RSI/BB/VWAP/Williams/CCI/StochRSI/ROC oversold signals — hourly</div></div>
          <Toggle checked={cfg.dip_buy_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, dip_buy_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Trailing Stop</div><div className="ct__toggle-sub">Sell 40% if price drops 30% from 14-day high (only while profitable)</div></div>
          <Toggle checked={cfg.trailing_stop_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, trailing_stop_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Fear & Greed Gate</div><div className="ct__toggle-sub">Skip DCA on Extreme Greed · Double on Extreme Fear</div></div>
          <Toggle checked={cfg.fear_greed_gate_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, fear_greed_gate_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div><div className="ct__toggle-label">Bear Market Pause</div><div className="ct__toggle-sub">Halve budget if BTC is 30%+ below 90-day high</div></div>
          <Toggle checked={cfg.bear_market_pause_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, bear_market_pause_enabled: v }))} />
        </div>

        {/* Budget mode */}
        <div style={{ marginTop: '0.85rem', padding: '0.85rem 1rem', borderRadius: '8px', background: cfg.capital_pct_mode ? 'rgba(34,197,94,0.05)' : '#0a0a0a', border: `1px solid ${cfg.capital_pct_mode ? '#22c55e33' : '#1a1a1a'}` }}>
          <div className="ct__toggle-row" style={{ borderBottom: 'none', padding: 0 }}>
            <div>
              <div className="ct__toggle-label" style={{ color: cfg.capital_pct_mode ? '#22c55e' : '#bbb' }}>Auto-Scale Budget (% of KRW)</div>
              <div className="ct__toggle-sub">{cfg.capital_pct_mode ? `DCA ${cfg.dca_pct_of_krw}% · Dip buys ${cfg.dip_pct_of_krw}% — scales as you deposit more` : 'Fixed amounts below'}</div>
            </div>
            <Toggle checked={cfg.capital_pct_mode} onChange={(v) => setCfg((c) => ({ ...c, capital_pct_mode: v }))} />
          </div>

          {cfg.capital_pct_mode ? (
            <div className="ct__config-grid" style={{ marginTop: '0.65rem' }}>
              <div className="ct__field">
                <label>DCA % of KRW per week</label>
                <input type="number" min="1" max="100" step="1" value={cfg.dca_pct_of_krw}
                  onChange={(e) => setCfg((c) => ({ ...c, dca_pct_of_krw: Number(e.target.value) }))} />
                {status?.krwBalance > 0 && <span style={{ fontSize: '0.7rem', color: '#22c55e' }}>= ₩{fmt(Math.round(status.krwBalance * cfg.dca_pct_of_krw / 100))} now</span>}
              </div>
              <div className="ct__field">
                <label>Dip Buy % of KRW per signal</label>
                <input type="number" min="1" max="100" step="1" value={cfg.dip_pct_of_krw}
                  onChange={(e) => setCfg((c) => ({ ...c, dip_pct_of_krw: Number(e.target.value) }))} />
                {status?.krwBalance > 0 && <span style={{ fontSize: '0.7rem', color: '#22c55e' }}>= ₩{fmt(Math.round(status.krwBalance * cfg.dip_pct_of_krw / 100))} now</span>}
              </div>
              <div className="ct__field">
                <label>Max DCA cap (₩, 0 = none)</label>
                <input type="number" min="0" step="10000" value={cfg.max_dca_krw}
                  onChange={(e) => setCfg((c) => ({ ...c, max_dca_krw: Number(e.target.value) }))} />
              </div>
              <div className="ct__field">
                <label>Max dip-buy cap (₩, 0 = none)</label>
                <input type="number" min="0" step="10000" value={cfg.max_dip_krw}
                  onChange={(e) => setCfg((c) => ({ ...c, max_dip_krw: Number(e.target.value) }))} />
              </div>
            </div>
          ) : (
            <div className="ct__config-grid" style={{ marginTop: '0.65rem' }}>
              <div className="ct__field">
                <label>Weekly DCA Budget (₩)</label>
                <input type="number" min="5000" step="10000" value={cfg.weekly_budget_krw}
                  onChange={(e) => setCfg((c) => ({ ...c, weekly_budget_krw: Number(e.target.value) }))} />
              </div>
              <div className="ct__field">
                <label>Dip Buy Reserve (₩)</label>
                <input type="number" min="5000" step="10000" value={cfg.dip_budget_krw ?? 100000}
                  onChange={(e) => setCfg((c) => ({ ...c, dip_budget_krw: Number(e.target.value) }))} />
              </div>
            </div>
          )}

          {status?.effectiveDcaBudget != null && (
            <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#555', display: 'flex', gap: '1rem' }}>
              <span>Next DCA: <strong style={{ color: '#22c55e' }}>₩{fmt(status.effectiveDcaBudget)}</strong></span>
              <span>Next dip: <strong style={{ color: '#22c55e' }}>₩{fmt(status.effectiveDipBudget)}</strong></span>
            </div>
          )}
        </div>

        <div className="ct__config-footer">
          <button className="ct__btn ct__btn--primary" onClick={saveConfig} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* ═══ PI + LAST CYCLE ═══ */}
      {(lastCycle || !piOnline) && (
        <div className="ct__section">
          <h3 className="ct__section-title">Pi Trader Status</h3>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', fontSize: '0.82rem' }}>
            <div>
              <div style={{ color: piOnline ? '#22c55e' : '#ef4444', fontWeight: 700, marginBottom: '0.2rem' }}>
                {piOnline ? '● Online' : '○ Offline'}
              </div>
              {piLastSeen && <div className="ct__muted">Last seen {new Date(piLastSeen).toLocaleString()}</div>}
              {!piOnline && <div style={{ color: '#f59e0b', marginTop: '0.2rem', fontSize: '0.75rem' }}>Pi must be running for trades to execute.</div>}
            </div>
            {lastCycle && (
              <div>
                <div style={{ color: lastCycle.ok ? '#22c55e' : '#ef4444', marginBottom: '0.15rem' }}>
                  {lastCycle.ok ? '✓ Last cycle OK' : `✗ ${lastCycle.error}`}
                </div>
                {lastCycle.label && <div className="ct__muted">{lastCycle.label} · {lastCycle.completedAt ? new Date(lastCycle.completedAt).toLocaleString() : ''}</div>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ DANGER ZONE ═══ */}
      <div className="ct__section ct__danger">
        <h4>Danger Zone</h4>
        <p>Kill switch immediately stops all automated trading.</p>
        <button className={`ct__btn ${killSwitch ? 'ct__btn--warn' : 'ct__btn--danger'}`} onClick={toggleKillSwitch}>
          {killSwitch ? '✓ Kill Switch Active — Click to Deactivate' : 'Activate Kill Switch'}
        </button>
      </div>
    </div>
  );
}
