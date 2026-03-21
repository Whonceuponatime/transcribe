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
  const [logs, setLogs] = useState([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  // V2 state
  const [v2Regime, setV2Regime]               = useState(null);
  const [v2Positions, setV2Positions]         = useState([]);
  const [v2CircuitBreakers, setV2CircuitBreakers] = useState(null);
  const [v2Mode, setV2Mode]                   = useState('paper');
  const [v2SavingMode, setV2SavingMode]       = useState(false);

  // Adoption + reconciliation state
  const [adoption, setAdoption]           = useState(null);
  const [systemFreeze, setSystemFreeze]   = useState(null);
  const [reconStatus, setReconStatus]     = useState(null);
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [clearingFreeze, setClearingFreeze] = useState(false);

  // Config form state (synced from status)
  const [cfg, setCfg] = useState({
    dca_enabled: true,
    profit_take_enabled: true,
    signal_boost_enabled: true,
    fear_greed_gate_enabled: true,
    trailing_stop_enabled: true,
    bear_market_pause_enabled: true,
    min_signal_score: 0,
    capital_pct_mode: true,
    dca_pct_of_krw: 20,
    dca_cooldown_days: 1,
    dip_pct_of_krw: 10,
    max_dca_krw: 0,
    max_dip_krw: 0,
    stop_loss_pct: 0,
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
          dca_enabled:              d.config?.dca_enabled ?? true,
          profit_take_enabled:      d.config?.profit_take_enabled ?? true,
          signal_boost_enabled:     d.config?.signal_boost_enabled ?? true,
          fear_greed_gate_enabled:  d.config?.fear_greed_gate_enabled ?? true,
          trailing_stop_enabled:    d.config?.trailing_stop_enabled ?? true,
          bear_market_pause_enabled:d.config?.bear_market_pause_enabled ?? true,
          min_signal_score:         d.config?.min_signal_score ?? 0,
          capital_pct_mode:         true, // always % mode — budget = live Upbit balance
          dca_pct_of_krw:           d.config?.dca_pct_of_krw ?? 20,
          dca_cooldown_days:        d.config?.dca_cooldown_days ?? 1,
          dip_pct_of_krw:           d.config?.dip_pct_of_krw ?? 10,
          max_dca_krw:              d.config?.max_dca_krw ?? 0,
          max_dip_krw:              d.config?.max_dip_krw ?? 0,
          stop_loss_pct:            d.config?.stop_loss_pct ?? 0,
        });
      } else {
        const e = await res.json();
        setError(e.error || 'Failed to load status');
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  // Fetch v2 data (regime, positions, circuit breakers, mode, adoption)
  const fetchV2Data = useCallback(async () => {
    try {
      const [regimeRes, posRes, cbRes, adoptionRes] = await Promise.all([
        fetch(`${API}/api/crypto-trader?action=regime`),
        fetch(`${API}/api/crypto-trader?action=positions`),
        fetch(`${API}/api/crypto-trader?action=circuit-breakers`),
        fetch(`${API}/api/crypto-trader?action=adoption`),
      ]);
      if (regimeRes.ok)   { const d = await regimeRes.json();   setV2Regime(d.regime); }
      if (posRes.ok)      { const d = await posRes.json();      setV2Positions(d.positions || []); }
      if (cbRes.ok)       { const d = await cbRes.json();       setV2CircuitBreakers(d.circuitBreakers); }
      if (adoptionRes.ok) {
        const d = await adoptionRes.json();
        setAdoption(d.adoption);
        setSystemFreeze(d.systemFreeze);
        setReconStatus(d.reconciliation);
        setTradingEnabled(d.tradingEnabled ?? false);
      }
    } catch (_) {}
  }, []);

  const clearFreeze = useCallback(async () => {
    if (!window.confirm('Manually clear the system freeze? Only do this after verifying that the account state is correct.')) return;
    setClearingFreeze(true);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=clear-freeze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'dashboard_manual_clear' }),
      });
      const j = await res.json();
      if (j.ok) { setMsg('Freeze cleared. Reconciliation will verify on next cycle.'); await fetchV2Data(); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
    setClearingFreeze(false);
  }, [fetchV2Data]);

  const triggerReconcile = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=reconcile`, { method: 'POST' });
      const j = await res.json();
      if (j.ok) { setMsg('Reconciliation triggered — check logs in ~15s'); setTimeout(fetchV2Data, 15000); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
  }, [fetchV2Data]);

  useEffect(() => {
    fetchStatus();
    fetchV2Data();
  }, [fetchStatus, fetchV2Data]);

  // Save v2 mode
  const saveV2Mode = useCallback(async (newMode) => {
    setV2SavingMode(true);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=v2-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      });
      const j = await res.json();
      if (j.ok) { setV2Mode(newMode); setMsg(`V2 mode set to ${newMode.toUpperCase()}`); await fetchV2Data(); }
      else setError(j.error);
    } catch (e) { setError(e.message); }
    setV2SavingMode(false);
  }, [fetchV2Data]);

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

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=logs&limit=100`);
      if (res.ok) { const d = await res.json(); setLogs(d.logs || []); }
    } catch (_) {}
    setLogsLoading(false);
  }, []);

  const toggleLogs = useCallback(async () => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next && logs.length === 0) await fetchLogs();
  }, [logsOpen, logs.length, fetchLogs]);

  const [diagOpen, setDiagOpen] = useState(false);
  const [diagLogs, setDiagLogs] = useState([]);
  const [diagLoading, setDiagLoading] = useState(false);

  const fetchDiag = useCallback(async () => {
    setDiagLoading(true);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=diagnostics`);
      if (res.ok) { const d = await res.json(); setDiagLogs(d.diagnostics || []); }
    } catch (_) {}
    setDiagLoading(false);
  }, []);

  const toggleDiag = useCallback(async () => {
    const next = !diagOpen;
    setDiagOpen(next);
    if (next) await fetchDiag();
  }, [diagOpen, fetchDiag]);

  const [exporting, setExporting] = useState(false);
  const exportLogs = useCallback(async () => {
    setExporting(true); setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=export&days=7`);
      const j = await res.json();
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `bot-logs-7d.json`; a.click();
      URL.revokeObjectURL(url);
      setMsg('Logs exported — share bot-logs-7d.json with me for analysis.');
    } catch (e) { setError(e.message); }
    setExporting(false);
  }, []);

  const [deploying, setDeploying] = useState(false);
  const deployPi = useCallback(async () => {
    if (!window.confirm('Pull latest code and restart the Pi trader? It will be offline for ~15 seconds.')) return;
    setDeploying(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=deploy`, { method: 'POST' });
      const j = await res.json();
      if (j.ok) {
        setMsg('Deploy triggered — Pi is pulling code and restarting. Check logs in ~15s.');
        setTimeout(fetchStatus, 20000); // auto-refresh after 20s
      } else { setError(j.error); }
    } catch (e) { setError(e.message); }
    setDeploying(false);
  }, [fetchStatus]);

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
          <div><div className="ct__toggle-label">Profit-Take</div><div className="ct__toggle-sub">Sell 10/15/20/25% at +10/20/40/80% gain (12/24/48/96h cooldown)</div></div>
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

        {/* Budget — always % of live Upbit KRW balance */}
        <div style={{ marginTop: '0.85rem', padding: '0.85rem 1rem', borderRadius: '8px', background: 'rgba(34,197,94,0.04)', border: '1px solid #22c55e22' }}>
          <div style={{ marginBottom: '0.5rem' }}>
            <div className="ct__toggle-label" style={{ color: '#22c55e' }}>Budget — % of your Upbit KRW balance</div>
            <div className="ct__toggle-sub">The bot automatically uses whatever KRW you have. Add more funds to Upbit and the bot scales up.</div>
          </div>
          <div className="ct__config-grid">
            <div className="ct__field">
              <label>DCA frequency (days between buys)</label>
              <input type="number" min="0.25" max="30" step="0.25" value={cfg.dca_cooldown_days}
                onChange={(e) => setCfg((c) => ({ ...c, dca_cooldown_days: Number(e.target.value) }))} />
              <span style={{ fontSize: '0.7rem', color: '#22c55e' }}>
                {cfg.dca_cooldown_days < 1
                  ? `Every ${Math.round(cfg.dca_cooldown_days * 24)}h`
                  : cfg.dca_cooldown_days === 1 ? 'Daily DCA (recommended)'
                  : `Every ${cfg.dca_cooldown_days} days`}
              </span>
            </div>
            <div className="ct__field">
              <label>DCA % per buy cycle</label>
              <input type="number" min="1" max="100" step="1" value={cfg.dca_pct_of_krw}
                onChange={(e) => setCfg((c) => ({ ...c, dca_pct_of_krw: Number(e.target.value) }))} />
              <span style={{ fontSize: '0.7rem', color: '#22c55e' }}>
                {status?.krwBalance > 0
                  ? `≈ ₩${fmt(Math.round(status.krwBalance * cfg.dca_pct_of_krw / 100))} at current balance`
                  : 'e.g. 20% of ₩500,000 = ₩100,000'}
              </span>
            </div>
            <div className="ct__field">
              <label>Dip buy % per signal</label>
              <input type="number" min="1" max="100" step="1" value={cfg.dip_pct_of_krw}
                onChange={(e) => setCfg((c) => ({ ...c, dip_pct_of_krw: Number(e.target.value) }))} />
              <span style={{ fontSize: '0.7rem', color: '#22c55e' }}>
                {status?.krwBalance > 0
                  ? `≈ ₩${fmt(Math.round(status.krwBalance * cfg.dip_pct_of_krw / 100))} at current balance`
                  : 'e.g. 10% of ₩500,000 = ₩50,000'}
              </span>
            </div>
            <div className="ct__field">
              <label>Max DCA cap (₩, 0 = no cap)</label>
              <input type="number" min="0" step="10000" value={cfg.max_dca_krw}
                onChange={(e) => setCfg((c) => ({ ...c, max_dca_krw: Number(e.target.value) }))} />
            </div>
            <div className="ct__field">
              <label>Max dip-buy cap (₩, 0 = no cap)</label>
              <input type="number" min="0" step="10000" value={cfg.max_dip_krw}
                onChange={(e) => setCfg((c) => ({ ...c, max_dip_krw: Number(e.target.value) }))} />
            </div>
            <div className="ct__field" style={{ gridColumn: '1 / -1', borderTop: '1px solid #1a1a2e', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
              <label style={{ color: '#f87171' }}>⛔ Stop-Loss % (0 = disabled)</label>
              <input type="number" min="0" max="20" step="0.5" value={cfg.stop_loss_pct}
                onChange={(e) => setCfg((c) => ({ ...c, stop_loss_pct: Number(e.target.value) }))} />
              <span style={{ fontSize: '0.7rem', color: cfg.stop_loss_pct > 0 ? '#f87171' : '#555' }}>
                {cfg.stop_loss_pct > 0
                  ? `Sell 50% if any position drops >${cfg.stop_loss_pct}% and held >24h`
                  : 'Disabled — bot holds losing positions until recovery'}
              </span>
            </div>
          </div>
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
      <div className="ct__section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <h3 className="ct__section-title" style={{ margin: 0 }}>Pi Trader</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem' }}
              onClick={deployPi} disabled={deploying || !piOnline}
              title={piOnline ? 'Pull latest code from GitHub and restart the bot' : 'Pi must be online to deploy'}>
              {deploying ? 'Deploying…' : '↓ Pull & Restart'}
            </button>
            <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
              onClick={exportLogs} disabled={exporting}
              title="Download last 7 days of bot logs as JSON for AI analysis">
              {exporting ? 'Exporting…' : '⬇ Export Logs'}
            </button>
          </div>
        </div>
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

      {/* ═══ PORTFOLIO ADOPTION & RECONCILIATION ═══ */}
      <div className="ct__section">
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <h3 className="ct__section-title" style={{ margin: 0 }}>Portfolio Adoption</h3>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Trading enabled badge */}
            <span style={{
              padding: '0.2rem 0.7rem', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700,
              background: tradingEnabled ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              color:      tradingEnabled ? '#22c55e' : '#f87171',
            }}>
              {tradingEnabled ? '✓ Trading Enabled' : '⛔ Trading Blocked'}
            </span>
            {/* Reconciliation status */}
            {reconStatus && (
              <span style={{
                padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.7rem',
                background: reconStatus.passed ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.1)',
                color:      reconStatus.passed ? '#22c55e' : '#f59e0b',
              }}>
                Recon: {reconStatus.passed ? 'Passed' : 'Frozen'}
              </span>
            )}
            {/* Actions */}
            <button className="ct__btn" style={{ fontSize: '0.68rem', padding: '0.2rem 0.55rem' }} onClick={triggerReconcile} title="Re-run reconciliation now">
              ↻ Reconcile
            </button>
            {systemFreeze?.frozen && (
              <button className="ct__btn" style={{ fontSize: '0.68rem', padding: '0.2rem 0.55rem', color: '#f87171', background: 'rgba(239,68,68,0.08)' }}
                onClick={clearFreeze} disabled={clearingFreeze}>
                {clearingFreeze ? 'Clearing…' : 'Clear Freeze'}
              </button>
            )}
          </div>
        </div>

        {/* Freeze alert */}
        {systemFreeze?.frozen && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '6px', padding: '0.6rem 0.8rem', marginBottom: '0.75rem' }}>
            <div style={{ color: '#f87171', fontWeight: 700, fontSize: '0.82rem', marginBottom: '0.25rem' }}>⛔ System Frozen — All v2 Orders Blocked</div>
            {(systemFreeze.reasons ?? []).map((r, i) => (
              <div key={i} style={{ color: '#fca5a5', fontSize: '0.75rem', marginLeft: '0.5rem' }}>• {r}</div>
            ))}
            <div style={{ color: '#f59e0b', fontSize: '0.7rem', marginTop: '0.3rem' }}>
              Resolve the issue above, then click "Clear Freeze" or "↻ Reconcile" to restore trading.
            </div>
          </div>
        )}

        {/* Reconciliation check results */}
        {reconStatus && !tradingEnabled && reconStatus.freezeReasons?.length > 0 && (
          <div style={{ marginBottom: '0.6rem' }}>
            <div style={{ fontSize: '0.72rem', color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>Reconciliation Freeze Reasons</div>
            {reconStatus.freezeReasons.map((r, i) => (
              <div key={i} style={{ fontSize: '0.75rem', color: '#fca5a5', padding: '0.15rem 0' }}>• {r}</div>
            ))}
          </div>
        )}

        {/* No adoption yet */}
        {!adoption && !systemFreeze?.frozen && (
          <div style={{ fontSize: '0.82rem', color: '#888' }}>
            Adoption runs automatically on first Pi startup. It discovers your existing holdings, imports supported assets as managed positions, and records unsupported assets for visibility. Pull &amp; Restart the Pi to trigger it.
          </div>
        )}

        {adoption?.complete && (
          <div style={{ fontSize: '0.82rem' }}>
            {/* KRW cash */}
            {adoption.krwBalance != null && (
              <div style={{ display: 'flex', gap: '1rem', padding: '0.3rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', marginBottom: '0.3rem' }}>
                <span style={{ fontWeight: 700, minWidth: '3rem', color: '#22c55e' }}>KRW</span>
                <span className="ct__muted">₩{Math.round(adoption.krwBalance).toLocaleString()}</span>
                <span style={{ fontSize: '0.7rem', color: '#555' }}>— execution cash</span>
              </div>
            )}

            {/* Adopted supported holdings */}
            {(adoption.adoptedAssets ?? []).length > 0 && (
              <div style={{ marginBottom: '0.6rem' }}>
                <div style={{ color: '#a78bfa', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Adopted Holdings — Managed</div>
                {(adoption.adoptedAssets ?? []).map((a, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.75rem', padding: '0.3rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, minWidth: '3rem', color: '#a78bfa' }}>{a.currency}</span>
                    <span className="ct__muted" style={{ fontSize: '0.75rem' }}>qty: {Number(a.qty ?? 0).toFixed(6)}</span>
                    {a.avg_cost_krw ? <span className="ct__muted" style={{ fontSize: '0.75rem' }}>avg: ₩{Math.round(a.avg_cost_krw).toLocaleString()}</span>
                      : <span style={{ color: '#555', fontSize: '0.72rem' }}>avg: unknown</span>}
                    {a.mark_price && <span className="ct__muted" style={{ fontSize: '0.75rem' }}>mark: ₩{Math.round(a.mark_price).toLocaleString()}</span>}
                    {a.estimated_market_value && <span className="ct__muted" style={{ fontSize: '0.75rem' }}>≈₩{Math.round(a.estimated_market_value).toLocaleString()}</span>}
                    <span style={{ fontSize: '0.68rem', background: 'rgba(167,139,250,0.1)', color: '#a78bfa', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
                      {a.strategy_tag ?? 'unassigned'}
                    </span>
                    <span style={{ fontSize: '0.68rem', color: '#22c55e' }}>managed</span>
                  </div>
                ))}
              </div>
            )}

            {/* Unsupported / excluded holdings */}
            {(adoption.unsupportedAssets ?? []).length > 0 && (
              <div style={{ marginBottom: '0.6rem' }}>
                <div style={{ color: '#f59e0b', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Excluded Holdings — Not Managed</div>
                {(adoption.unsupportedAssets ?? []).map((u, i) => (
                  <div key={i} style={{ display: 'flex', gap: '0.75rem', padding: '0.3rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, minWidth: '3rem', color: '#f59e0b' }}>{u.currency}</span>
                    <span className="ct__muted" style={{ fontSize: '0.75rem' }}>qty: {Number(u.balance ?? u.qty ?? 0).toFixed(6)}</span>
                    {u.approx_value_krw != null && <span className="ct__muted" style={{ fontSize: '0.75rem' }}>≈₩{Math.round(u.approx_value_krw).toLocaleString()}</span>}
                    <span style={{ fontSize: '0.68rem', background: 'rgba(245,158,11,0.08)', color: '#f59e0b', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>excluded</span>
                    <span style={{ fontSize: '0.68rem', color: '#555' }}>bot will not buy, sell, or size against this</span>
                  </div>
                ))}
              </div>
            )}

            {(adoption.adoptedAssets ?? []).length === 0 && (adoption.unsupportedAssets ?? []).length === 0 && (
              <div className="ct__muted" style={{ fontSize: '0.8rem' }}>No pre-existing holdings found at adoption time — account was empty or all dust.</div>
            )}

            <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: '#555' }}>
              Adoption completed: {adoption.completedAt ? new Date(adoption.completedAt).toLocaleString() : '—'}
              {adoption.mode && <span style={{ marginLeft: '0.5rem' }}>mode={adoption.mode}</span>}
            </div>
          </div>
        )}
      </div>

      {/* ═══ V2 ENGINE STATUS ═══ */}
      <div className="ct__section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <h3 className="ct__section-title" style={{ margin: 0 }}>Engine v2</h3>
          {/* Mode toggle */}
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {['paper','shadow','live'].map((m) => (
              <button key={m}
                disabled={v2SavingMode}
                onClick={() => { if (m === 'live' && !window.confirm('Switch to LIVE mode? Real money will be traded by the v2 engine.')) return; saveV2Mode(m); }}
                style={{
                  padding: '0.25rem 0.65rem', fontSize: '0.7rem', borderRadius: '4px', cursor: 'pointer', border: 'none',
                  background: v2Mode === m
                    ? m === 'live' ? '#ef4444' : m === 'shadow' ? '#f59e0b' : '#22c55e'
                    : 'rgba(255,255,255,0.06)',
                  color: v2Mode === m ? '#fff' : '#888',
                  fontWeight: v2Mode === m ? 700 : 400,
                }}>
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Regime badge */}
        {v2Regime && (
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.8rem', alignItems: 'center' }}>
            <span style={{
              padding: '0.3rem 0.8rem', borderRadius: '6px', fontWeight: 700, fontSize: '0.85rem',
              background: v2Regime.regime === 'UPTREND' ? 'rgba(34,197,94,0.15)' : v2Regime.regime === 'DOWNTREND' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
              color:      v2Regime.regime === 'UPTREND' ? '#22c55e'              : v2Regime.regime === 'DOWNTREND' ? '#ef4444'              : '#f59e0b',
            }}>
              {v2Regime.regime === 'UPTREND' ? '▲' : v2Regime.regime === 'DOWNTREND' ? '▼' : '◆'} {v2Regime.regime ?? '—'}
            </span>
            <span className="ct__muted" style={{ fontSize: '0.78rem' }}>
              EMA50: {v2Regime.ema50 ? `₩${Number(v2Regime.ema50).toLocaleString()}` : '—'}
            </span>
            <span className="ct__muted" style={{ fontSize: '0.78rem' }}>
              EMA200: {v2Regime.ema200 ? `₩${Number(v2Regime.ema200).toLocaleString()}` : '—'}
            </span>
            <span className="ct__muted" style={{ fontSize: '0.78rem' }}>
              ADX: {v2Regime.adxVal ?? '—'}
            </span>
            {v2Regime.fromCache && <span className="ct__muted" style={{ fontSize: '0.7rem' }}>(cached)</span>}
          </div>
        )}

        {/* Circuit breakers */}
        {v2CircuitBreakers?.anyActive && (
          <div style={{ marginBottom: '0.8rem' }}>
            {v2CircuitBreakers.breakers.map((b, i) => (
              <div key={i} style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171', borderRadius: '4px', padding: '0.4rem 0.7rem', fontSize: '0.78rem', marginBottom: '0.3rem' }}>
                ⛔ {b.type}: {b.detail}
              </div>
            ))}
          </div>
        )}
        {v2CircuitBreakers && !v2CircuitBreakers.anyActive && (
          <div style={{ fontSize: '0.78rem', color: '#22c55e', marginBottom: '0.6rem' }}>✓ No circuit breakers active</div>
        )}

        {/* Open tactical positions */}
        {v2Positions.length > 0 && (
          <div>
            <div style={{ fontSize: '0.75rem', color: '#555', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Open Tactical Positions</div>
            {v2Positions.map((p) => (
              <div key={p.position_id} style={{ display: 'flex', gap: '1rem', fontSize: '0.82rem', padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, minWidth: '3rem' }}>{p.asset}</span>
                <span className="ct__muted">qty: {Number(p.qty_open).toFixed(6)}</span>
                <span className="ct__muted">avg: ₩{Math.round(p.avg_cost_krw).toLocaleString()}</span>
                {p.unrealized_pnl_pct != null && (
                  <span style={{ color: p.unrealized_pnl_pct >= 0 ? '#22c55e' : '#ef4444' }}>
                    {p.unrealized_pnl_pct >= 0 ? '+' : ''}{p.unrealized_pnl_pct.toFixed(2)}%
                  </span>
                )}
                <span className="ct__muted" style={{ fontSize: '0.72rem' }}>regime@entry: {p.entry_regime ?? '—'}</span>
                <span className="ct__muted" style={{ fontSize: '0.72rem' }}>{p.entry_reason ?? ''}</span>
              </div>
            ))}
          </div>
        )}
        {v2Positions.length === 0 && (
          <div className="ct__muted" style={{ fontSize: '0.8rem' }}>No open tactical positions</div>
        )}
      </div>

      {/* ═══ BOT LOGS ═══ */}
      <div className="ct__section">
        <div className="ct__logs-header" onClick={toggleLogs} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 className="ct__section-title" style={{ margin: 0 }}>Bot Logs</h3>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {logsOpen && (
              <button className="ct__btn" style={{ padding: '0.2rem 0.6rem', fontSize: '0.7rem' }}
                onClick={(e) => { e.stopPropagation(); fetchLogs(); }}>
                {logsLoading ? '…' : 'Refresh'}
              </button>
            )}
            <span style={{ color: '#555', fontSize: '0.8rem' }}>{logsOpen ? '▲ hide' : '▼ show'}</span>
          </div>
        </div>
        {logsOpen && (
          <div className="ct__logs-panel">
            {logsLoading && <div className="ct__logs-empty">Loading…</div>}
            {!logsLoading && logs.length === 0 && (
              <div className="ct__logs-empty">No logs yet — the bot will write entries here after its next cycle.</div>
            )}
            {!logsLoading && logs.length > 0 && logs.map((log) => (
              <div key={log.id} className={`ct__log-row ct__log-row--${log.level}`}>
                <span className="ct__log-time">
                  {new Date(log.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="ct__log-tag">{log.tag || '—'}</span>
                <span className="ct__log-msg">{log.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══ SELL DIAGNOSTICS ═══ */}
      <div className="ct__section">
        <div className="ct__logs-header" onClick={toggleDiag} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 className="ct__section-title" style={{ margin: 0 }}>Sell Diagnostics</h3>
            <div style={{ fontSize: '0.72rem', color: '#888', marginTop: '0.2rem' }}>Per-coin sell block reasons logged every ~15 min — use this to review why sells aren't firing</div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {diagOpen && <button className="ct__btn ct__btn--sm" onClick={(e) => { e.stopPropagation(); fetchDiag(); }}>↻ Refresh</button>}
            <span style={{ color: '#555', fontSize: '0.8rem' }}>{diagOpen ? '▲ hide' : '▼ show'}</span>
          </div>
        </div>
        {diagOpen && (
          <div className="ct__logs-panel">
            {diagLoading && <div className="ct__logs-empty">Loading…</div>}
            {!diagLoading && diagLogs.length === 0 && (
              <div className="ct__logs-empty">No diagnostics yet — they appear every ~15 min once the bot is running.</div>
            )}
            {!diagLoading && diagLogs.length > 0 && diagLogs.map((log) => {
              const coins = log.meta?.sellDiag || [];
              return (
                <div key={log.id} className="ct__log-row ct__log-row--debug" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '0.25rem' }}>
                  <div style={{ display: 'flex', gap: '0.75rem', opacity: 0.7, fontSize: '0.72rem' }}>
                    <span>{new Date(log.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    <span>{log.meta?.cycleLabel || log.tag}</span>
                  </div>
                  {coins.length > 0 ? coins.map((d) => (
                    <div key={d.coin} style={{ paddingLeft: '0.5rem', borderLeft: `3px solid ${d.atProfit ? '#22c55e' : '#ef4444'}`, marginLeft: '0.25rem' }}>
                      <strong style={{ color: d.atProfit ? '#22c55e' : '#f87171' }}>{d.coin}</strong>
                      <span style={{ margin: '0 0.4rem', color: '#ccc' }}>gain {d.gainPct}% net {d.netGainPct}%</span>
                      {d.blockedBy
                        ? <span style={{ color: '#fbbf24' }}>⛔ {d.blockedBy}</span>
                        : d.signalsMet?.length
                          ? <span style={{ color: '#22c55e' }}>✓ signals: {d.signalsMet.join(', ')}</span>
                          : <span style={{ color: '#888' }}>no signals met</span>}
                      <span style={{ color: '#666', fontSize: '0.7rem', marginLeft: '0.5rem' }}>
                        RSI={d.indicators?.rsi} StochRSI={d.indicators?.stochRsi} VWAP={d.indicators?.vwapDev}% WR={d.indicators?.williamsR}
                      </span>
                    </div>
                  )) : <span style={{ color: '#888', fontSize: '0.8rem' }}>{log.message}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
