import React, { useState, useEffect, useCallback, useRef } from 'react';
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
const regStyle  = (r) => ({
  background: r === 'UPTREND' ? 'rgba(34,197,94,0.12)' : r === 'DOWNTREND' ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.10)',
  color:      r === 'UPTREND' ? '#22c55e'               : r === 'DOWNTREND' ? '#ef4444'               : '#f59e0b',
});

const FNG_COLOR = (v) => v > 75 ? '#ef4444' : v > 55 ? '#f59e0b' : v > 45 ? '#888' : v > 25 ? '#22c55e' : '#00e5ff';
const FNG_LABEL = (v) => v > 75 ? 'Extreme Greed' : v > 55 ? 'Greed' : v > 45 ? 'Neutral' : v > 25 ? 'Fear' : 'Extreme Fear';

// Toggle component removed — was used only by the retired V1 Bot Settings panel.

export default function CryptoTraderDashboard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  // saving/cfg removed — V1 Bot Settings panel retired
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [triggerPending, setTriggerPending] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  // V2 state
  const [v2Regime, setV2Regime]               = useState(null);
  const [v2Positions, setV2Positions]         = useState([]);
  const [v2CircuitBreakers, setV2CircuitBreakers] = useState(null);
  // Live-only controls (replaces mode toggle)
  const [v2TradingEnabled, setV2TradingEnabled] = useState(true);
  const [v2BuysEnabled, setV2BuysEnabled]       = useState(true);
  const [v2SellsEnabled, setV2SellsEnabled]     = useState(true);
  const [v2SavingControl, setV2SavingControl]   = useState(false);

  // Adoption + reconciliation state
  const [adoption, setAdoption]           = useState(null);
  const [systemFreeze, setSystemFreeze]   = useState(null);
  const [reconStatus, setReconStatus]     = useState(null);
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [clearingFreeze, setClearingFreeze] = useState(false);

  // Operator classification state
  const [classifyingId, setClassifyingId] = useState(null);   // position_id currently being classified
  const [classifyForm, setClassifyForm]   = useState({});     // { [position_id]: { costBasis, note } }

  // V1 cfg state removed. V2 controls are in v2TradingEnabled/v2BuysEnabled/v2SellsEnabled.

  // silent=true skips the loading spinner and error state — used for background auto-refresh.
  const fetchStatus = useCallback(async ({ silent = false } = {}) => {
    if (!silent) { setLoading(true); setError(null); }
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=status`);
      if (res.ok) {
        const d = await res.json();
        setStatus(d);
        setTriggerPending(d.triggerPending ?? false);
        // Sync V2 trading controls from status
        if (d.tradingEnabled !== undefined) setV2TradingEnabled(d.tradingEnabled);
        if (d.buysEnabled    !== undefined) setV2BuysEnabled(d.buysEnabled);
        if (d.sellsEnabled   !== undefined) setV2SellsEnabled(d.sellsEnabled);
        setLastUpdated(new Date());
      } else {
        const e = await res.json();
        if (!silent) setError(e.error || 'Failed to load status');
      }
    } catch (e) { if (!silent) setError(e.message); }
    if (!silent) setLoading(false);
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
      // Trading controls (trading_enabled, buys_enabled, sells_enabled) are read
      // from the adoption endpoint's systemState — no separate fetch needed here.
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

  const classifyPosition = useCallback(async (positionId, classification, avgCostKrw, note) => {
    setClassifyingId(positionId); setError(null); setMsg(null);
    try {
      const body = { position_id: positionId, classification };
      if (avgCostKrw && Number(avgCostKrw) > 0) body.avg_cost_krw = Number(avgCostKrw);
      if (note) body.operator_note = note;
      const res = await fetch(`${API}/api/crypto-trader?action=classify-position`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (j.ok) {
        setMsg(`${j.asset} classified as ${j.classification}${j.avg_cost_krw ? ` with cost ₩${Math.round(j.avg_cost_krw).toLocaleString()}` : ''}`);
        setClassifyForm((f) => { const n = { ...f }; delete n[positionId]; return n; });
        await fetchV2Data();
      } else { setError(j.error); }
    } catch (e) { setError(e.message); }
    setClassifyingId(null);
  }, [fetchV2Data]);

  useEffect(() => {
    fetchStatus();
    fetchV2Data();
  }, [fetchStatus, fetchV2Data]);


  // Save live trading controls (replaces mode toggle)
  const saveV2Control = useCallback(async (patch) => {
    setV2SavingControl(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=v2-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await res.json();
      if (j.ok) {
        if (patch.trading_enabled !== undefined) setV2TradingEnabled(patch.trading_enabled);
        if (patch.buys_enabled    !== undefined) setV2BuysEnabled(patch.buys_enabled);
        if (patch.sells_enabled   !== undefined) setV2SellsEnabled(patch.sells_enabled);
        setMsg('Trading control updated');
        await fetchV2Data();
      } else setError(j.error);
    } catch (e) { setError(e.message); }
    setV2SavingControl(false);
  }, [fetchV2Data]);

  // Trigger a V2 cycle manually (replaces V1 execute/forceDca logic)
  const execute = useCallback(async () => {
    if (!window.confirm('Trigger a V2 evaluation cycle now? The bot will check all positions for exits and entries.')) return;
    setExecuting(true); setError(null); setMsg(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=execute`, { method: 'POST' });
      const j = await res.json();
      if (j.ok) {
        setTriggerPending(true);
        setMsg('V2 cycle triggered — Pi will execute within 10 seconds.');
        let polls = 0;
        const poll = setInterval(async () => {
          polls++;
          await fetchStatus();
          if (polls >= 6) clearInterval(poll);
        }, 5000);
      } else setError(j.error);
    } catch (e) { setError(e.message); }
    setExecuting(false);
  }, [fetchStatus]);

  // saveConfig removed — V1 config endpoint retired.
  // V2 controls are saved via saveV2Control (trading_enabled/buys_enabled/sells_enabled).

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

  // Refs track panel open state without causing interval re-registration on open/close.
  // Placed after fetchDiag/fetchLogs/diagOpen/logsOpen are all defined.
  const diagOpenRef = useRef(false);
  const logsOpenRef = useRef(false);
  useEffect(() => { diagOpenRef.current = diagOpen; }, [diagOpen]);
  useEffect(() => { logsOpenRef.current = logsOpen; }, [logsOpen]);

  // Auto-refresh every 15 seconds — silent so no loading flash.
  // Decision Feed and Bot Logs also refresh when their panel is open.
  useEffect(() => {
    const id = setInterval(() => {
      fetchStatus({ silent: true });
      fetchV2Data();
      if (diagOpenRef.current) fetchDiag();
      if (logsOpenRef.current) fetchLogs();
    }, 15000);
    return () => clearInterval(id);
  }, [fetchStatus, fetchV2Data, fetchDiag, fetchLogs]);

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

  /** Canonical structured export (bot DB source-of-truth). Falls back to crypto-trader action if /api/diagnostics/export is unavailable. */
  const [exportingStructured, setExportingStructured] = useState(false);
  const downloadStructuredDiagnostic = useCallback(async (hours = 24) => {
    setExportingStructured(true); setError(null);
    try {
      let res = await fetch(`${API}/api/diagnostics/export?hours=${hours}`);
      if (res.status === 404) {
        res = await fetch(`${API}/api/crypto-trader?action=structured-export&hours=${hours}`);
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      const j = await res.json();
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `diagnostics-${hours}h.json`; a.click();
      URL.revokeObjectURL(url);
      setMsg(`Diagnostics JSON (${hours}h) downloaded — diagnostics-${hours}h.json`);
    } catch (e) { setError(e.message); }
    setExportingStructured(false);
  }, []);

  const [exportingDiag, setExportingDiag] = useState(false);
  const exportDiagnostic = useCallback(async (hours = 24) => {
    setExportingDiag(true); setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=diagnostic-export&hours=${hours}`);
      const j = await res.json();
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `diagnostic-${hours}h.json`; a.click();
      URL.revokeObjectURL(url);
      setMsg(`Diagnostic export (${hours}h) downloaded — share diagnostic-${hours}h.json for missed-trade analysis.`);
    } catch (e) { setError(e.message); }
    setExportingDiag(false);
  }, []);

  const [exportingTuning, setExportingTuning] = useState(false);
  const exportTuning = useCallback(async (hours = 24) => {
    setExportingTuning(true); setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=tuning-export&hours=${hours}`);
      const j = await res.json();
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `tuning-export-${hours}h.json`; a.click();
      URL.revokeObjectURL(url);
      const cycles = j.summary?.total_decision_cycles ?? 0;
      const sells  = j.summary?.total_sells_filled ?? 0;
      setMsg(`Tuning export (${hours}h): ${cycles} decision cycles, ${sells} fills. File: tuning-export-${hours}h.json`);
    } catch (e) { setError(e.message); }
    setExportingTuning(false);
  }, []);

  const [exportingVerification, setExportingVerification] = useState(false);
  const exportTradeVerification = useCallback(async (hours = 24) => {
    setExportingVerification(true); setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=trade-verification&hours=${hours}`);
      const j = await res.json();
      const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `trade-verification-${hours}h.json`; a.click();
      URL.revokeObjectURL(url);
      const total = j.summary?.total_exchange_fills ?? 0;
      const matched = j.summary?.total_matched_fills ?? 0;
      setMsg(`Trade verification (${hours}h): ${total} fills, ${matched} matched. File: trade-verification-${hours}h.json`);
    } catch (e) { setError(e.message); }
    setExportingVerification(false);
  }, []);

  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState(null);
  const pollDeployStatus = useCallback(async (retries = 8, delayMs = 3000) => {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const res = await fetch(`${API}/api/crypto-trader?action=deploy-status`);
        const j = await res.json();
        if (j.ok && j.result) {
          const age = Date.now() - new Date(j.result.completedAt).getTime();
          if (age < 120_000) { setDeployResult(j.result); return; }
        }
      } catch (_) {}
    }
  }, []);
  const deployPi = useCallback(async () => {
    if (!window.confirm('Pull latest code and restart the Pi trader? It will be offline for ~15 seconds.')) return;
    setDeploying(true); setError(null); setMsg(null); setDeployResult(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=deploy`, { method: 'POST' });
      const j = await res.json();
      if (j.ok) {
        setMsg('Deploy triggered — waiting for result…');
        pollDeployStatus();
        setTimeout(fetchStatus, 20000);
      } else { setError(j.error); }
    } catch (e) { setError(e.message); }
    setDeploying(false);
  }, [fetchStatus, pollDeployStatus]);

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
  // lastCycle and fearGreed are V1 fields — retired, always null from V2 status
  const lastCycle      = null;
  const fearGreed      = null;

  // Total cost basis across all coins
  const totalCostKrw = positions.reduce((s, p) => s + (p.avgBuyKrw > 0 ? p.avgBuyKrw * p.balance : 0), 0);
  const totalHoldingsKrw = positions.reduce((s, p) => s + (p.currentValueKrw ?? 0), 0);
  const totalPnlKrw = totalHoldingsKrw - totalCostKrw;
  // totalPnlUsd removed — USD P&L no longer displayed

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
          {/* FROZEN takes priority over all other status badges — driven by status.systemFrozen
              which reads system_freeze.frozen from app_settings (the live reconciliation source). */}
          {status?.systemFrozen && (
            <span className="ct__badge ct__badge--kill" title={`Freeze reasons: ${(status.freezeReasons ?? []).join(', ') || 'unknown'}`}>
              ⛔ SYSTEM FROZEN
            </span>
          )}
          {/* Unresolved orders badge — shown even when not frozen, so the operator
              can see stuck accepted/submitted orders before reconciliation fires. */}
          {!status?.systemFrozen && (status?.liveUnresolvedOrders ?? 0) > 0 && (
            <span className="ct__badge ct__badge--kill"
              title={`${status.liveUnresolvedOrders} order(s) in non-terminal state (accepted/submitted/partially_filled). Reconciliation will freeze if these persist past next startup.`}>
              ⚠ {status.liveUnresolvedOrders} UNRESOLVED ORDER{status.liveUnresolvedOrders > 1 ? 'S' : ''}
            </span>
          )}
          <span className="ct__badge ct__badge--on">V2 LIVE</span>
          {!v2TradingEnabled && !status?.systemFrozen && (
            <span className="ct__badge ct__badge--off">TRADING PAUSED</span>
          )}
          {triggerPending && <span className="ct__badge ct__badge--signal">Pending…</span>}
        </div>
        <div className="ct__actions">
          <button className="ct__btn" onClick={() => fetchStatus()} disabled={loading}>{loading ? '…' : 'Refresh'}</button>
          {lastUpdated && <span className="ct__last-updated" title="Auto-refreshes every 15s">↻ {lastUpdated.toLocaleTimeString()}</span>}
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
            {status?.totalValueKrw != null ? `₩${fmt(status.totalValueKrw)}` : '—'}
          </div>
          <div className="ct__portfolio-krw">
            total incl. cash{totalValueUsd != null ? ` · ${fmtUsd(totalValueUsd, 0)}` : ''}
          </div>
          {totalCostKrw > 0 && (
            <div className="ct__portfolio-pnl" style={{ color: totalPnlKrw >= 0 ? '#22c55e' : '#ef4444' }}>
              P&L {totalPnlKrw >= 0 ? '+' : ''}₩{fmt(Math.abs(totalPnlKrw))}
              {' '}unrealised
            </div>
          )}
          {/* Snapshot freshness — source: status.snapshotAt from v2_portfolio_snapshot.
              Warn if data is older than 10 minutes (600s) so stale state is visible. */}
          {status?.snapshotAt && (
            <div style={{ fontSize: '0.68rem', color: status.snapshotAge > 600 ? '#f59e0b' : '#555', marginTop: '0.3rem' }}>
              {status.snapshotAge > 600
                ? `⚠ Portfolio data ${Math.round(status.snapshotAge / 60)}min old`
                : `Data as of ${new Date(status.snapshotAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
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
          {/* Last DCA field removed — V1 crypto_trader_config retired */}
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
            {v2TradingEnabled ? 'V2 live — signal-driven entries' : 'Trading paused'}
          </div>
        </div>

        {/* Crypto coin cards */}
        {positions.map((pos) => {
          const g       = pos.gainPct;
          const cardMod = pos.balance <= 0 ? 'flat' : g == null ? 'flat' : g > 0 ? 'up' : g < 0 ? 'down' : 'flat';
          const pnlKrw  = pos.avgBuyKrw > 0 && pos.currentValueKrw != null
            ? pos.currentValueKrw - pos.avgBuyKrw * pos.balance : null;
          // pnlUsd removed — USD P&L no longer displayed
          const ind     = pos.indicators ?? {};

          return (
            <div key={pos.coin} className={`ct__coin-card ct__coin-card--${cardMod}`}>
              <div className="ct__coin-header">
                <span className="ct__coin-ticker">{pos.coin}</span>
                {g != null && pos.balance > 0 && (
                  <span className={`ct__coin-pnl-badge ct__coin-pnl-badge--${cardMod}`}>{pct(g)}</span>
                )}
              </div>

              <div className="ct__coin-price">
                {pos.balance > 0 && pos.currentValueKrw != null
                  ? `₩${fmt(pos.currentValueKrw)}`
                  : '—'}
              </div>
              {pos.currentPrice != null && (
                <div className="ct__coin-price-usd" style={{ color: '#555' }}>
                  Spot ₩{fmt(pos.currentPrice)}
                </div>
              )}

              <div className="ct__coin-divider" />

              <div className="ct__coin-row">
                <span className="ct__coin-label">Holdings</span>
                <span className="ct__coin-value">{fmtCoin(pos.balance)} {pos.coin}</span>
              </div>
              {pos.balance > 0 && pos.currentValueKrw != null && (
                <div className="ct__coin-row">
                  <span className="ct__coin-label">Holding value</span>
                  <span className="ct__coin-value">₩{fmt(pos.currentValueKrw)}</span>
                </div>
              )}
              {pos.avgBuyKrw > 0 && (
                <div className="ct__coin-row">
                  <span className="ct__coin-label">Avg buy</span>
                  <span className="ct__coin-value" style={{ color: '#666' }}>₩{fmt(pos.avgBuyKrw)}</span>
                </div>
              )}

              {pnlKrw != null && pos.balance > 0 && (
                <div className={`ct__coin-pnl-abs ct__coin-pnl-abs--${cardMod}`}>
                  P&L {pnlKrw >= 0 ? '+' : ''}₩{fmt(Math.abs(pnlKrw))}
                  {g != null && <span style={{ opacity: 0.75 }}> · {pct(g)}</span>}
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

      {/* ═══ PI + LAST CYCLE ═══ */}
      <div className="ct__section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <h3 className="ct__section-title" style={{ margin: 0 }}>Pi Trader</h3>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem' }}
              onClick={deployPi} disabled={deploying || !piOnline}
              title={piOnline ? 'Pull latest code from GitHub and restart the bot' : 'Pi must be online to deploy'}>
              {deploying ? 'Deploying…' : '↓ Pull & Restart'}
            </button>
            <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(99,102,241,0.12)', color: '#a5b4fc' }}
              onClick={async () => {
                try {
                  const r = await fetch(`${API}/api/crypto-trader?action=deploy-status`);
                  const j = await r.json();
                  if (j.ok && j.result) setDeployResult(j.result);
                  else setError('No deploy result found');
                } catch (e) { setError(e.message); }
              }}
              title="Fetch last deploy result: git log + pm2 logs">
              View Deploy Log
            </button>
            {deployResult && (
              <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(16,185,129,0.12)', color: '#34d399' }}
                onClick={() => setDeployResult(null)} title="Dismiss deploy result">
                {deployResult.status === 'success' ? 'Deploy OK' : 'Deploy FAILED'} — dismiss
              </button>
            )}
            <button className="ct__btn ct__btn--primary" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem' }}
              onClick={() => downloadStructuredDiagnostic(24)} disabled={exportingStructured}
              title="Canonical structured export (bot_config, positions, decisions, fills, blockers) — diagnostics-24h.json">
              {exportingStructured ? 'Downloading…' : '⬇ Download diagnostic JSON (24h)'}
            </button>
            <details style={{ fontSize: '0.72rem' }}>
              <summary style={{ cursor: 'pointer', color: '#94a3b8', userSelect: 'none' }}>Advanced / legacy tools</summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.4rem' }}>
                <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
                  type="button"
                  onClick={exportLogs} disabled={exporting}
                  title="Download last 7 days of bot logs as JSON for AI analysis">
                  {exporting ? 'Exporting…' : '⬇ Export Logs'}
                </button>
                <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(234,179,8,0.12)', color: '#facc15' }}
                  type="button"
                  onClick={() => exportDiagnostic(24)} disabled={exportingDiag}
                  title="Legacy 24h missed-trade decision audit (BTC/ETH)">
                  {exportingDiag ? 'Exporting…' : '🔍 Diagnostic (24h)'}
                </button>
                <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(34,197,94,0.1)', color: '#4ade80' }}
                  type="button"
                  onClick={() => exportTradeVerification(24)} disabled={exportingVerification}
                  title="Trade verification report — matches Upbit fills to decision trail">
                  {exportingVerification ? 'Exporting…' : '✓ Verify Trades (24h)'}
                </button>
                <button className="ct__btn" style={{ fontSize: '0.72rem', padding: '0.25rem 0.7rem', background: 'rgba(251,146,60,0.12)', color: '#fb923c' }}
                  type="button"
                  onClick={() => exportTuning(24)} disabled={exportingTuning}
                  title="Strategy tuning validation export">
                  {exportingTuning ? 'Exporting…' : '📊 Tuning Audit (24h)'}
                </button>
              </div>
            </details>
          </div>
        </div>
        {deployResult && (
          <div style={{ background: deployResult.status === 'success' ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${deployResult.status === 'success' ? '#065f46' : '#7f1d1d'}`,
            borderRadius: '6px', padding: '0.6rem 0.8rem', marginBottom: '0.6rem', fontSize: '0.75rem' }}>
            <div style={{ fontWeight: 700, marginBottom: '0.3rem', color: deployResult.status === 'success' ? '#34d399' : '#f87171' }}>
              Deploy {deployResult.status === 'success' ? 'Succeeded' : 'Failed'}
              <span style={{ fontWeight: 400, color: '#94a3b8', marginLeft: '0.6rem' }}>{deployResult.completedAt ? new Date(deployResult.completedAt).toLocaleString() : ''}</span>
            </div>
            {deployResult.error && <div style={{ color: '#f87171', marginBottom: '0.3rem' }}>Error: {deployResult.error}</div>}
            {deployResult.pull_output && (
              <div style={{ marginBottom: '0.3rem' }}>
                <span style={{ color: '#94a3b8' }}>git pull: </span>
                <span style={{ color: '#e2e8f0' }}>{deployResult.pull_output}</span>
              </div>
            )}
            {deployResult.git_log && (
              <div style={{ marginBottom: '0.4rem' }}>
                <div style={{ color: '#94a3b8', marginBottom: '0.15rem' }}>git log --oneline -5:</div>
                <pre style={{ margin: 0, padding: '0.4rem 0.6rem', background: 'rgba(0,0,0,0.3)', borderRadius: '4px',
                  color: '#e2e8f0', fontSize: '0.72rem', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{deployResult.git_log}</pre>
              </div>
            )}
            {deployResult.pm2_logs && (
              <div>
                <div style={{ color: '#94a3b8', marginBottom: '0.15rem' }}>pm2 logs crypto-trader --lines 20:</div>
                <pre style={{ margin: 0, padding: '0.4rem 0.6rem', background: 'rgba(0,0,0,0.3)', borderRadius: '4px',
                  color: '#e2e8f0', fontSize: '0.72rem', whiteSpace: 'pre-wrap', lineHeight: 1.5, maxHeight: '220px', overflowY: 'auto' }}>{deployResult.pm2_logs}</pre>
              </div>
            )}
          </div>
        )}
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
            {/* Trading enabled badge — source of truth:
                effectiveTradingEnabled = NOT frozen (system_freeze) AND bot_config.trading_enabled.
                A frozen system blocks trading regardless of bot_config. */}
            {(() => {
              const effectiveTrading = tradingEnabled && v2TradingEnabled;
              const frozenOnly = !tradingEnabled && v2TradingEnabled;
              return (
                <span style={{
                  padding: '0.2rem 0.7rem', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700,
                  background: effectiveTrading ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                  color:      effectiveTrading ? '#22c55e' : '#f87171',
                }}
                  title={frozenOnly ? 'bot_config.trading_enabled=true but system is frozen' : undefined}>
                  {effectiveTrading ? '✓ Trading Enabled' : frozenOnly ? '⛔ Frozen (config=ON)' : '⛔ Trading Blocked'}
                </span>
              );
            })()}
            {/* Reconciliation badge — source of truth: status.latestReconciliation.
                If system is frozen, ALWAYS show Frozen regardless of reconStatus.passed —
                a freeze written after the last reconciliation overrides the cached result. */}
            {reconStatus && (() => {
              const isFrozen = systemFreeze?.frozen || status?.systemFrozen;
              const reconPassed = reconStatus.passed && !isFrozen;
              return (
                <span style={{
                  padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.7rem',
                  background: reconPassed ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.1)',
                  color:      reconPassed ? '#22c55e' : '#f59e0b',
                }}
                  title={reconStatus.runAt ? `Last recon: ${new Date(reconStatus.runAt).toLocaleString()}` : undefined}>
                  Recon: {reconPassed ? 'Passed' : 'Frozen'}
                </span>
              );
            })()}
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
                <span style={{ fontSize: '0.7rem', color: '#777' }}>— at adoption time (not current)</span>
              </div>
            )}

            {/* Adopted supported holdings — read from positions table (authoritative source).
                adoption.adoptedAssets only contains what the LATEST adoption run imported,
                so BTC (adopted in an earlier run) would be missing. v2Positions has all three.
                Filter: only show positions with qty_open > 0 — a zero-qty record means the
                position was fully sold and should not appear as an active holding here. */}
            {(() => {
              const adoptedFromPositions = v2Positions.filter((p) => p.origin === 'adopted_at_startup' && Number(p.qty_open ?? 0) > 0);
              if (adoptedFromPositions.length === 0) return null;
              return (
                <div style={{ marginBottom: '0.6rem' }}>
                  <div style={{ color: '#a78bfa', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>Adopted Holdings — Managed</div>
                  {adoptedFromPositions.map((p, i) => (
                    <div key={i} style={{ display: 'flex', gap: '0.75rem', padding: '0.3rem 0', borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontWeight: 700, minWidth: '3rem', color: '#a78bfa' }}>{p.asset ?? p.coin}</span>
                      <span className="ct__muted" style={{ fontSize: '0.75rem' }}>qty: {Number(p.balance ?? p.qty_open ?? 0).toFixed(6)}</span>
                      {(p.avgBuyKrw ?? p.avg_cost_krw)
                        ? <span className="ct__muted" style={{ fontSize: '0.75rem' }}>avg: ₩{Math.round(p.avgBuyKrw ?? p.avg_cost_krw).toLocaleString()}</span>
                        : <span style={{ color: '#555', fontSize: '0.72rem' }}>avg: unknown</span>}
                      {p.currentPrice && <span className="ct__muted" style={{ fontSize: '0.75rem' }}>mark: ₩{Math.round(p.currentPrice).toLocaleString()}</span>}
                      {p.currentValueKrw && <span className="ct__muted" style={{ fontSize: '0.75rem' }}>≈₩{Math.round(p.currentValueKrw).toLocaleString()}</span>}
                      <span style={{ fontSize: '0.68rem', background: 'rgba(167,139,250,0.1)', color: '#a78bfa', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>
                        {p.strategy_tag ?? 'unassigned'}
                      </span>
                      <span style={{ fontSize: '0.68rem', color: '#22c55e' }}>managed</span>
                    </div>
                  ))}
                </div>
              );
            })()}

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

            {v2Positions.filter((p) => p.origin === 'adopted_at_startup').length === 0 && (adoption.unsupportedAssets ?? []).length === 0 && (
              <div className="ct__muted" style={{ fontSize: '0.8rem' }}>No pre-existing holdings found at adoption time — account was empty or all dust.</div>
            )}

            <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: '#555' }}>
              Adoption completed: {adoption.completedAt ? new Date(adoption.completedAt).toLocaleString() : '—'}
              {adoption.mode && <span style={{ marginLeft: '0.5rem' }}>mode={adoption.mode}</span>}
            </div>
          </div>
        )}
      </div>

      {/* ═══ OPERATOR ACTION REQUIRED ═══ */}
      {(() => {
        const protectedPositions = v2Positions.filter((p) => p.is_protected || p.needs_classification);
        if (protectedPositions.length === 0) return null;
        return (
          <div className="ct__section" style={{ border: '1px solid rgba(245,158,11,0.3)', background: 'rgba(245,158,11,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
              <h3 className="ct__section-title" style={{ margin: 0 }}>Operator Action Required</h3>
              <span style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', fontSize: '0.7rem', fontWeight: 700, padding: '0.15rem 0.6rem', borderRadius: '4px' }}>
                {protectedPositions.length} position{protectedPositions.length > 1 ? 's' : ''} need classification
              </span>
            </div>

            <div style={{ fontSize: '0.78rem', color: '#888', marginBottom: '0.75rem' }}>
              These holdings were imported at startup (<code style={{ color: '#a78bfa' }}>origin=adopted_at_startup</code>) and have not been classified into a strategy sleeve. The bot will not buy, sell, or apply any exit logic to them until you classify each one. Choose <strong style={{ color: '#22c55e' }}>Core</strong> to retain it as a long-term holding, or <strong style={{ color: '#ef4444' }}>Unmanaged</strong> to exclude it permanently.
            </div>

            {protectedPositions.map((p) => {
              const formKey = p.position_id;
              const form    = classifyForm[formKey] ?? {};
              const busy    = classifyingId === formKey;
              return (
                <div key={formKey} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '6px', padding: '0.75rem', marginBottom: '0.6rem', border: '1px solid rgba(255,255,255,0.06)' }}>
                  {/* Position header */}
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.9rem', color: '#a78bfa', minWidth: '3rem' }}>{p.asset}</span>
                    <span className="ct__muted">qty: {Number(p.qty_open).toFixed(6)}</span>
                    {p.current_price_krw && <span className="ct__muted">mark: ₩{Math.round(p.current_price_krw).toLocaleString()}</span>}
                    {p.estimated_market_value && <span className="ct__muted">≈₩{Math.round(p.estimated_market_value).toLocaleString()}</span>}
                    {p.cost_basis_missing
                      ? <span style={{ color: '#f87171', fontSize: '0.7rem', background: 'rgba(239,68,68,0.1)', padding: '0.1rem 0.45rem', borderRadius: '3px' }}>⚠ Cost basis missing</span>
                      : <span className="ct__muted" style={{ fontSize: '0.75rem' }}>avg: ₩{Math.round(p.avg_cost_krw).toLocaleString()}</span>
                    }
                    <span style={{ fontSize: '0.68rem', color: '#f59e0b', background: 'rgba(245,158,11,0.08)', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>protected — no exits active</span>
                  </div>

                  {/* Classification inputs */}
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    {p.cost_basis_missing && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        <label style={{ fontSize: '0.68rem', color: '#555' }}>Cost basis ₩ (optional)</label>
                        <input
                          type="number" min="0" step="1000"
                          placeholder="e.g. 108000000"
                          value={form.costBasis ?? ''}
                          onChange={(e) => setClassifyForm((f) => ({ ...f, [formKey]: { ...f[formKey], costBasis: e.target.value } }))}
                          style={{ width: '120px', padding: '0.25rem 0.4rem', fontSize: '0.75rem', background: '#111', border: '1px solid #333', color: '#fff', borderRadius: '3px' }}
                        />
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <label style={{ fontSize: '0.68rem', color: '#555' }}>Note (optional)</label>
                      <input
                        type="text"
                        placeholder="e.g. pre-deploy holding"
                        value={form.note ?? ''}
                        onChange={(e) => setClassifyForm((f) => ({ ...f, [formKey]: { ...f[formKey], note: e.target.value } }))}
                        style={{ width: '160px', padding: '0.25rem 0.4rem', fontSize: '0.75rem', background: '#111', border: '1px solid #333', color: '#fff', borderRadius: '3px' }}
                      />
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => classifyPosition(formKey, 'core', form.costBasis, form.note)}
                      style={{ padding: '0.3rem 0.75rem', fontSize: '0.75rem', background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '4px', cursor: 'pointer' }}>
                      {busy ? '…' : 'Classify as Core'}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => { if (!window.confirm(`Mark ${p.asset} as unmanaged? The bot will never trade this position.`)) return; classifyPosition(formKey, 'unmanaged', null, form.note); }}
                      style={{ padding: '0.3rem 0.75rem', fontSize: '0.75rem', background: 'rgba(239,68,68,0.1)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '4px', cursor: 'pointer' }}>
                      {busy ? '…' : 'Mark Unmanaged'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* ═══ V2 ENGINE STATUS ═══ */}
      <div className="ct__section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.8rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <h3 className="ct__section-title" style={{ margin: 0 }}>Engine v2</h3>
            <span style={{ fontSize: '0.7rem', background: 'rgba(239,68,68,0.15)', color: '#f87171', padding: '0.15rem 0.55rem', borderRadius: '4px', fontWeight: 700 }}>
              LIVE
            </span>
          </div>
          {/* Granular trading controls */}
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
            {[
              { key: 'trading_enabled', label: 'Trading', val: v2TradingEnabled, set: setV2TradingEnabled, danger: true },
              { key: 'buys_enabled',    label: 'Buys',    val: v2BuysEnabled,    set: setV2BuysEnabled },
              { key: 'sells_enabled',   label: 'Sells',   val: v2SellsEnabled,   set: setV2SellsEnabled },
            ].map(({ key, label, val, danger }) => (
              <button key={key}
                disabled={v2SavingControl}
                onClick={() => {
                  if (!val && danger && !window.confirm(`Enable ${label}? This will resume live trading.`)) return;
                  if (val && danger && !window.confirm(`Disable ${label}? This will stop all V2 trading immediately.`)) return;
                  saveV2Control({ [key]: !val });
                }}
                title={val ? `Click to disable ${label}` : `Click to enable ${label}`}
                style={{
                  padding: '0.25rem 0.65rem', fontSize: '0.7rem', borderRadius: '4px',
                  cursor: 'pointer', border: 'none',
                  background: val ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)',
                  color:      val ? '#22c55e'              : '#f87171',
                  fontWeight: 700,
                }}>
                {label}: {val ? 'ON' : 'OFF'}
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

        {/* Open tactical positions — table, filtered to strategy_tag=tactical */}
        {(() => {
          const tactical = v2Positions.filter((p) => p.strategy_tag === 'tactical');
          return (
            <>
              <div className="ct__panel-label">
                Open Tactical Positions{tactical.length > 0 ? ` (${tactical.length})` : ''}
              </div>
              {tactical.length === 0 ? (
                <div className="ct__muted" style={{ fontSize: '0.8rem' }}>No open tactical positions</div>
              ) : (
                <div className="ct__pos-table-wrap">
                  <table className="ct__pos-table">
                    <thead>
                      <tr>
                        <th>Asset</th><th>Qty</th><th>Avg Cost</th><th>Mark</th>
                        <th>P&amp;L</th><th>Regime</th><th>Trims</th><th>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tactical.map((p) => {
                        const pnl = p.unrealized_pnl_pct;
                        const pnlColor = pnl == null ? '#666' : pnl >= 0 ? '#22c55e' : '#ef4444';
                        const ageMs  = p.opened_at ? Date.now() - new Date(p.opened_at).getTime() : null;
                        const ageStr = ageMs == null ? '—' : ageMs > 86400000
                          ? `${Math.floor(ageMs / 86400000)}d ${Math.floor((ageMs % 86400000) / 3600000)}h`
                          : `${Math.floor(ageMs / 3600000)}h ${Math.floor((ageMs % 3600000) / 60000)}m`;
                        const rc = p.entry_regime ? regStyle(p.entry_regime) : null;
                        return (
                          <React.Fragment key={p.position_id}>
                            <tr className="ct__pos-row">
                              <td style={{ fontWeight: 700, color: '#e2e8f0' }}>{p.asset}</td>
                              <td>{Number(p.qty_open).toFixed(6)}</td>
                              <td>₩{Math.round(p.avg_cost_krw ?? 0).toLocaleString()}</td>
                              <td>{p.current_price_krw ? `₩${Math.round(p.current_price_krw).toLocaleString()}` : '—'}</td>
                              <td style={{ color: pnlColor, fontWeight: 700 }}>
                                {pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—'}
                              </td>
                              <td>
                                {rc ? (
                                  <span className="ct__regime-chip" style={rc}>{p.entry_regime}</span>
                                ) : '—'}
                              </td>
                              <td>
                                {(p.fired_trims ?? []).map((t) => (
                                  <span key={t} className="ct__trim-chip">{t}</span>
                                ))}
                              </td>
                              <td style={{ color: '#555', fontSize: '0.72rem' }}>{ageStr}</td>
                            </tr>
                            {p.entry_reason && (
                              <tr className="ct__pos-reason-row">
                                <td colSpan={8}>↳ {p.entry_reason}</td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* ═══ TELEMETRY STRIP ═══ */}
      {(() => {
        const tactical = v2Positions.filter((p) => p.strategy_tag === 'tactical');
        const pnlPositions = tactical.filter((p) => p.current_price_krw && p.avg_cost_krw && p.qty_open > 0);
        const totalPnlKrw = pnlPositions.length > 0
          ? pnlPositions.reduce((s, p) => s + (Number(p.current_price_krw) - Number(p.avg_cost_krw)) * Number(p.qty_open), 0)
          : null;
        const blockedRows   = diagLogs.filter((d) => d.buy_blocker);
        const starterAtt    = diagLogs.filter((d) => d.starter_into_existing_attempted).length;
        const starterPass   = diagLogs.filter((d) => d.starter_into_existing_passed).length;
        const recentBuys    = trades.filter((t) => t.side === 'buy').length;
        const recentSells   = trades.filter((t) => t.side === 'sell').length;
        const blockerCounts = {};
        blockedRows.forEach((d) => {
          const k = (d.buy_blocker ?? '').split(':')[0];
          blockerCounts[k] = (blockerCounts[k] ?? 0) + 1;
        });
        const topBlocker = Object.entries(blockerCounts).sort((a, b) => b[1] - a[1])[0];
        const frozen = status?.systemFrozen;
        return (
          <div className="ct__telem-strip">
            <div className="ct__telem-card">
              <div className="ct__telem-label">Positions</div>
              <div className="ct__telem-val">{tactical.length}</div>
            </div>
            {totalPnlKrw != null && (
              <div className="ct__telem-card">
                <div className="ct__telem-label">Unrealized P&amp;L</div>
                <div className="ct__telem-val" style={{ color: totalPnlKrw >= 0 ? '#22c55e' : '#ef4444' }}>
                  {totalPnlKrw >= 0 ? '+' : ''}₩{Math.round(totalPnlKrw).toLocaleString()}
                </div>
              </div>
            )}
            <div className="ct__telem-card">
              <div className="ct__telem-label">Decision Rows</div>
              <div className="ct__telem-val">{diagLogs.length}</div>
            </div>
            <div className="ct__telem-card">
              <div className="ct__telem-label">Buys Blocked</div>
              <div className="ct__telem-val" style={{ color: blockedRows.length > 0 ? '#f59e0b' : '#555' }}>
                {blockedRows.length}
              </div>
            </div>
            <div className="ct__telem-card">
              <div className="ct__telem-label">Starter→Existing</div>
              <div className="ct__telem-val">
                <span style={{ color: '#666' }}>{starterAtt} tried</span>
                {starterPass > 0 && <span style={{ color: '#22c55e', marginLeft: '0.35rem' }}>✓{starterPass}</span>}
              </div>
            </div>
            <div className="ct__telem-card">
              <div className="ct__telem-label">Fills (30)</div>
              <div className="ct__telem-val">
                <span style={{ color: '#22c55e' }}>{recentBuys}B</span>
                <span style={{ color: '#3a3a3a', margin: '0 0.2rem' }}>/</span>
                <span style={{ color: '#f59e0b' }}>{recentSells}S</span>
              </div>
            </div>
            {topBlocker && (
              <div className="ct__telem-card">
                <div className="ct__telem-label">Top Blocker</div>
                <div className="ct__telem-val" style={{ fontSize: '0.7rem', color: '#f87171' }}>
                  {topBlocker[0]} ×{topBlocker[1]}
                </div>
              </div>
            )}
            <div className="ct__telem-card">
              <div className="ct__telem-label">System</div>
              <div className="ct__telem-val" style={{ color: frozen ? '#f87171' : '#22c55e' }}>
                {frozen ? '⛔ FROZEN' : '✓ LIVE'}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══ DECISION FEED — primary diagnostic panel ═══ */}
      <div className="ct__section">
        <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: diagOpen ? '0.6rem' : 0 }}
          onClick={toggleDiag}>
          <div>
            <h3 className="ct__section-title" style={{ margin: 0 }}>Decision Feed</h3>
            <div style={{ fontSize: '0.68rem', color: '#3a3a3a', marginTop: '0.18rem' }}>
              {diagLogs.length > 0 ? `${diagLogs.length} rows · auto-refresh 15s` : 'Live V2 evaluations — one row per coin per cycle'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {diagOpen && (
              <button className="ct__btn" style={{ padding: '0.2rem 0.55rem', fontSize: '0.68rem' }}
                onClick={(e) => { e.stopPropagation(); fetchDiag(); }}>
                {diagLoading ? '…' : '↻'}
              </button>
            )}
            <span style={{ color: '#3a3a3a', fontSize: '0.78rem' }}>{diagOpen ? '▲' : '▼'}</span>
          </div>
        </div>
        {diagOpen && (
          <div className="ct__logs-panel" style={{ maxHeight: '520px', fontFamily: 'inherit' }}>
            {diagLoading && <div className="ct__logs-empty">Loading…</div>}
            {!diagLoading && diagLogs.length === 0 && (
              <div className="ct__logs-empty">No decisions yet — they appear every 5 min once the bot is running.</div>
            )}
            {!diagLoading && diagLogs.length > 0 && (
              <div className="ct__diag-cards">
                {diagLogs.map((d) => {
                  const isSubmitted = ['BUY_SUBMITTED', 'ADD_ON_SUBMITTED', 'STARTER_SUBMITTED'].includes(d.final_action);
                  const isSell      = d.final_action === 'SELL_TRIGGERED';
                  const isElig      = ['BUY_ELIGIBLE', 'ADD_ON_ELIGIBLE', 'STARTER_ELIGIBLE'].includes(d.final_action);
                  const chipBg    = isSubmitted ? 'rgba(34,197,94,0.15)' : isSell ? 'rgba(245,158,11,0.13)' : isElig ? 'rgba(96,165,250,0.1)' : 'rgba(255,255,255,0.04)';
                  const chipColor = isSubmitted ? '#22c55e' : isSell ? '#f59e0b' : isElig ? '#60a5fa' : '#444';
                  const obBlocked = d.ob_imbalance != null && d.effective_ob_threshold != null && d.ob_imbalance < d.effective_ob_threshold;
                  const bbBlocked = d.bb_pctB != null && d.effective_bb_threshold != null && d.bb_pctB >= d.effective_bb_threshold;
                  const dr = d.regime ? regStyle(d.regime) : null;
                  return (
                    <div key={d.id} className="ct__diag-card">
                      {/* Row 1: identity + action */}
                      <div className="ct__diag-header">
                        <span className="ct__diag-time">
                          {new Date(d.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span className="ct__diag-coin">{d.symbol}</span>
                        {dr && <span className="ct__diag-regime-badge" style={dr}>{d.regime}</span>}
                        <span className="ct__diag-action-chip" style={{ background: chipBg, color: chipColor }}>
                          {d.final_action || '—'}
                        </span>
                        {d.pnl_percent != null && (
                          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: d.pnl_percent >= 0 ? '#4ade80' : '#f87171' }}>
                            P&amp;L {d.pnl_percent > 0 ? '+' : ''}{d.pnl_percent.toFixed(2)}%
                          </span>
                        )}
                        {d.price != null && (
                          <span className="ct__diag-price">₩{Math.round(d.price).toLocaleString()}</span>
                        )}
                      </div>
                      {/* Row 2: indicators + chips */}
                      <div className="ct__diag-indicators">
                        {d.rsi != null && (
                          <span className="ct__diag-ind">RSI <strong>{d.rsi}</strong></span>
                        )}
                        {d.bb_pctB != null && (
                          <span className="ct__diag-ind" style={{ color: bbBlocked ? '#7f1d1d' : undefined }}>
                            %B <strong style={{ color: bbBlocked ? '#f87171' : undefined }}>{d.bb_pctB}</strong>
                            {d.effective_bb_threshold != null && <span className="ct__diag-cap">/{d.effective_bb_threshold}</span>}
                          </span>
                        )}
                        {d.ob_imbalance != null && (
                          <span className="ct__diag-ind" style={{ color: obBlocked ? '#7f1d1d' : undefined }}>
                            OB <strong style={{ color: obBlocked ? '#f87171' : undefined }}>{d.ob_imbalance}</strong>
                            {d.effective_ob_threshold != null && <span className="ct__diag-cap">/{d.effective_ob_threshold}</span>}
                          </span>
                        )}
                        {d.adaptive_signals?.length > 0 && (
                          <span className="ct__diag-ind" style={{ color: '#2d3748' }}>[{d.adaptive_signals.join(',')}]</span>
                        )}
                        {d.micro_bypassed && (
                          <span className="ct__diag-chip ct__diag-chip--purple" title={`Notional ₩${d.pos_notional_krw?.toLocaleString()} below bypass`}>μ-bypass</span>
                        )}
                        {d.route_to_existing_position && (
                          <span className="ct__diag-chip ct__diag-chip--blue">→existing</span>
                        )}
                        {d.risk_blocker && (
                          <span className="ct__diag-chip ct__diag-chip--red">{d.risk_blocker}</span>
                        )}
                        {d.sell_blocker && d.sell_blocker !== 'no_position' && (
                          <span className="ct__diag-chip ct__diag-chip--amber">sell:{d.sell_blocker}</span>
                        )}
                      </div>
                      {/* Row 3: full reason */}
                      {d.final_reason && (
                        <div className="ct__diag-reason">{d.final_reason}</div>
                      )}
                      {/* Row 4: starter-into-existing detail */}
                      {d.starter_into_existing_attempted && (
                        <div className="ct__diag-starter" style={{ color: d.starter_into_existing_passed ? '#166534' : '#78350f' }}>
                          starter→existing:{' '}
                          {d.starter_into_existing_passed
                            ? `✓ passed${d.starter_addon_size_mult_effective != null ? ` (mult=${d.starter_addon_size_mult_effective})` : ''}`
                            : `✗ ${d.starter_into_existing_blocker ?? 'blocked'}`}
                          {d.existing_position_strategy_tag && (
                            <span style={{ color: '#2d3748', marginLeft: '0.4rem' }}>pos={d.existing_position_strategy_tag}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ═══ RECENT TRADES — blotter ═══ */}
      <div className="ct__section">
        <h3 className="ct__section-title" style={{ marginBottom: trades.length > 0 ? '0.5rem' : '0.75rem' }}>
          Recent Trades{trades.length > 0 ? ` (${trades.length})` : ''}
        </h3>
        {trades.length > 0 ? (
          <div className="ct__blotter-wrap">
            <table className="ct__blotter">
              <thead>
                <tr>
                  <th>Time</th><th>Coin</th><th>Side</th>
                  <th>Gross</th><th>Fee</th><th>Net</th>
                  <th>Qty</th><th>Price</th><th>Regime</th><th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, tIdx) => {
                  const rc = t.entry_regime ? regStyle(t.entry_regime) : null;
                  return (
                    <tr key={`${t.executed_at ?? tIdx}-${t.coin}-${t.side}`}
                      className={t.side === 'buy' ? 'ct__blotter-buy' : 'ct__blotter-sell'}>
                      <td style={{ color: '#444', fontSize: '0.72rem' }}>
                        {t.executed_at ? new Date(t.executed_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td style={{ fontWeight: 700, color: '#ddd' }}>{t.coin}</td>
                      <td>
                        <span className={`ct__side-pill ct__side-pill--${t.side}`}>
                          {t.side === 'buy' ? '↑ BUY' : '↓ SELL'}
                        </span>
                      </td>
                      <td>{t.gross_krw ? `₩${fmt(t.gross_krw)}` : '—'}</td>
                      <td className="ct__bl-fee">{t.fee_krw ? `₩${fmt(t.fee_krw)}` : '—'}</td>
                      <td style={{ fontWeight: 600, color: t.side === 'sell' ? '#4ade80' : '#60a5fa' }}>
                        {t.net_krw != null ? `₩${fmt(t.net_krw)}` : '—'}
                      </td>
                      <td>{t.coin_amount ? fmtCoin(t.coin_amount) : '—'}</td>
                      <td className="ct__bl-price">{t.price_krw ? `₩${fmt(t.price_krw)}` : '—'}</td>
                      <td>
                        {rc ? (
                          <span style={{ ...rc, padding: '0.08rem 0.32rem', borderRadius: '3px', fontSize: '0.6rem', fontWeight: 700 }}>
                            {t.entry_regime}
                          </span>
                        ) : <span style={{ color: '#333' }}>—</span>}
                      </td>
                      <td>
                        <span className="ct__reason" title={t.order_id ? `order: ${t.order_id}` : undefined}>
                          {REASON_LABELS[t.reason] || t.reason || '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="ct__empty">No trades yet — bot is watching for signals.</p>
        )}
      </div>

      {/* ═══ BOT LOGS — secondary, collapsed by default ═══ */}
      <div className="ct__section" style={{ background: '#060606', borderColor: '#111' }}>
        <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
          onClick={toggleLogs}>
          <div style={{ display: 'flex', align: 'center', gap: '0.6rem' }}>
            <h3 className="ct__section-title" style={{ margin: 0, color: '#333' }}>Bot Logs</h3>
            <span style={{ fontSize: '0.65rem', color: '#2a2a2a', marginLeft: '0.5rem', alignSelf: 'center' }}>
              mode=live · auto-refresh 15s
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {logsOpen && (
              <button className="ct__btn" style={{ padding: '0.18rem 0.5rem', fontSize: '0.67rem', borderColor: '#1e1e1e', color: '#444' }}
                onClick={(e) => { e.stopPropagation(); fetchLogs(); }}>
                {logsLoading ? '…' : '↻'}
              </button>
            )}
            <span style={{ color: '#2a2a2a', fontSize: '0.75rem' }}>{logsOpen ? '▲' : '▼'}</span>
          </div>
        </div>
        {logsOpen && (
          <div className="ct__logs-panel-secondary">
            {logsLoading && <div className="ct__logs-empty">Loading…</div>}
            {!logsLoading && logs.length === 0 && (
              <div className="ct__logs-empty" style={{ color: '#2a2a2a' }}>No live events yet.</div>
            )}
            {!logsLoading && logs.length > 0 && logs.map((log) => {
              const sevColor = log.severity === 'error' ? '#7f1d1d' : log.severity === 'warn' ? '#78350f' : '#1e3a2e';
              const cx = log.context_json ?? {};
              const execDetail = log.event_type === 'EXECUTION' && cx.reason
                ? `${cx.reason}${cx.fills != null ? ` · ${cx.fills} fill${cx.fills !== 1 ? 's' : ''}` : ''}`
                : null;
              return (
                <div key={log.id} className={`ct__log-row-v3 ct__log-row-v3--${log.severity || 'info'}`}>
                  <span className="ct__log-time" style={{ color: '#252525' }}>
                    {new Date(log.created_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className="ct__log-sev" style={{ color: sevColor }}>{log.severity?.toUpperCase()}</span>
                  <span className="ct__log-sub">{log.subsystem || log.event_type || '—'}</span>
                  <span className="ct__log-msg-v3">
                    {log.message}
                    {execDetail && <span style={{ color: '#252525', marginLeft: '0.35rem' }}> · {execDetail}</span>}
                  </span>
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
