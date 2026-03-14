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

// Progress toward next profit-take level
function progressToNextLevel(gainPct) {
  if (gainPct == null) return null;
  const levels = [50, 100, 200];
  for (const lvl of levels) {
    if (gainPct < lvl) {
      return { next: lvl, progress: Math.max(0, gainPct) / lvl * 100 };
    }
  }
  return { next: null, progress: 100 };
}

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

  return (
    <div className="ct">
      {/* ═══ HEADER ═══ */}
      <header className="ct__header">
        <div>
          <h2 className="ct__title">Crypto Bot — Upbit Auto-Trader</h2>
          <p className="ct__subtitle">DCA weekly + signal boost + auto profit-take on BTC / ETH / SOL</p>
        </div>
        <div className="ct__badges">
          {killSwitch && <span className="ct__badge ct__badge--kill">KILL SWITCH ON</span>}
          <span className={`ct__badge ${piOnline ? 'ct__badge--on' : 'ct__badge--off'}`}>
            Pi {piOnline ? 'ONLINE' : 'OFFLINE'}
          </span>
          <span className={`ct__badge ${cfg.dca_enabled ? 'ct__badge--on' : 'ct__badge--off'}`}>
            DCA {cfg.dca_enabled ? 'ON' : 'OFF'}
          </span>
          {triggerPending && <span className="ct__badge ct__badge--signal">⏳ Pending…</span>}
          {signalScore != null && (
            <span className="ct__badge ct__badge--signal">Signal {signalScore}</span>
          )}
        </div>
        <div className="ct__actions">
          <button type="button" className="ct__btn" onClick={fetchStatus} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button type="button" className="ct__btn ct__btn--primary" onClick={() => execute(false)} disabled={executing}>
            {executing ? 'Running…' : 'Run Cycle'}
          </button>
          <button type="button" className="ct__btn ct__btn--warn" onClick={() => execute(true)} disabled={executing}>
            Force DCA Now
          </button>
          <button type="button" className={`ct__btn ct__btn--danger`} onClick={toggleKillSwitch}>
            {killSwitch ? 'Deactivate Kill Switch' : 'Kill Switch'}
          </button>
        </div>
      </header>

      {error && <div className="ct__error">{error}</div>}
      {msg && <div className="ct__success">{msg}</div>}

      {/* ═══ BALANCE HERO ═══ */}
      <div className="ct__balance-hero">
        <div className="ct__krw-block">
          <div className="ct__krw-label">Available KRW</div>
          <div className="ct__krw-value">₩{fmt(krwBalance)}</div>
          {usdKrw && <div style={{ fontSize: '0.78rem', color: '#888' }}>{fmtUsd(krwBalance / usdKrw)} · 1 USD = ₩{fmt(usdKrw)}</div>}
          <div className="ct__krw-sub">
            {cfg.weekly_budget_krw > 0 && krwBalance > 0
              ? `~${Math.floor(krwBalance / cfg.weekly_budget_krw)} weeks of DCA remaining`
              : 'Set weekly budget below'}
          </div>
        </div>
        {totalValueUsd != null && (
          <div style={{ padding: '0.6rem 1rem', borderRadius: '8px', textAlign: 'center', background: '#ffffff08', border: '1px solid #ffffff18' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#00e5ff' }}>{fmtUsd(totalValueUsd)}</div>
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block' }}>Total Portfolio (USD)</span>
            <div style={{ fontSize: '0.72rem', color: '#666' }}>₩{fmt(status?.totalValueKrw)} incl. KRW</div>
          </div>
        )}
        {signalScore != null && (
          <div className="ct__signal-block">
            <div className="ct__signal-score">{signalScore}</div>
            <span className="ct__signal-label">Macro Score / 10</span>
            <div className="ct__signal-decision">{signalDecision?.replace('_', ' ')}</div>
          </div>
        )}
        {fearGreed && (
          <div style={{
            padding: '0.6rem 1rem', borderRadius: '8px', textAlign: 'center',
            background: `${FNG_COLOR(fearGreed.value)}18`,
            border: `1px solid ${FNG_COLOR(fearGreed.value)}44`,
          }}>
            <div style={{ fontSize: '1.6rem', fontWeight: 700, color: FNG_COLOR(fearGreed.value) }}>
              {fearGreed.value}
            </div>
            <span style={{ fontSize: '0.75rem', color: '#888', display: 'block' }}>Fear & Greed</span>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: FNG_COLOR(fearGreed.value) }}>
              {fearGreed.label || FNG_LABEL(fearGreed.value)}
            </div>
            {fearGreed.value > 75 && (
              <div style={{ fontSize: '0.7rem', color: '#ef4444', marginTop: '0.2rem' }}>DCA paused</div>
            )}
            {fearGreed.value < 25 && (
              <div style={{ fontSize: '0.7rem', color: '#22c55e', marginTop: '0.2rem' }}>DCA ×2 active</div>
            )}
          </div>
        )}
        {status?.config?.last_dca_run && (
          <div style={{ fontSize: '0.8rem', color: '#666' }}>
            Last DCA: {new Date(status.config.last_dca_run).toLocaleDateString()}
          </div>
        )}
      </div>

      {/* ═══ POSITIONS ═══ */}
      <section className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem' }}>Live Positions (from Upbit)</h3>
        {positions.length > 0 ? (
          <div className="ct__positions">
            {positions.map((pos) => {
              const progress = progressToNextLevel(pos.gainPct);
              const gainClass = pos.gainPct == null ? '' : pos.gainPct > 0 ? 'ct__pos-gain--up' : pos.gainPct < 0 ? 'ct__pos-gain--down' : 'ct__pos-gain--flat';
              return (
                <div key={pos.coin} className="ct__pos-card">
                  <span className="ct__pos-coin">{pos.coin}</span>
                  <span className="ct__pos-balance">{fmtCoin(pos.balance)} {pos.coin}</span>
                  {pos.currentPrice && (
                    <span className="ct__pos-price">
                      ₩{fmt(pos.currentPrice)}{pos.currentValueUsd ? ` ≈ ${fmtUsd(pos.currentValueUsd, 0)}` : ''} · ₩{fmt(pos.currentValueKrw)}
                    </span>
                  )}
                  {pos.avgBuyKrw > 0 && (
                    <span className="ct__pos-price">
                      Avg ₩{fmt(pos.avgBuyKrw)}{pos.avgBuyUsd ? ` (${fmtUsd(pos.avgBuyUsd, 0)})` : ''}
                    </span>
                  )}
                  {pos.gainPct != null && (
                    <span className={`ct__pos-gain ${gainClass}`}>{pct(pos.gainPct)}</span>
                  )}
                  {progress && progress.next && (
                    <div className="ct__pos-progress">
                      <div className="ct__pos-progress-bar">
                        <div className="ct__pos-progress-fill" style={{ width: `${Math.min(100, progress.progress)}%` }} />
                      </div>
                      <div className="ct__pos-progress-label">
                        {progress.progress.toFixed(0)}% to +{progress.next}% sell trigger
                      </div>
                    </div>
                  )}
                  {pos.gainPct != null && progress?.next == null && (
                    <span className="ct__pos-next" style={{ color: '#22c55e' }}>All profit-take levels passed</span>
                  )}
                  {pos.dropFromHigh != null && pos.dropFromHigh > 10 && (
                    <span className="ct__pos-next" style={{ color: pos.dropFromHigh > 25 ? '#ef4444' : '#f59e0b' }}>
                      ↓{pos.dropFromHigh.toFixed(1)}% from 14d high{pos.dropFromHigh > 25 ? ' ⚠️' : ''}
                    </span>
                  )}
                  {pos.indicators && (
                    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                      {/* Combined signal score */}
                      {pos.indicators.scoreCombined != null && (() => {
                        const s = Number(pos.indicators.scoreCombined);
                        const c = s >= 3 ? '#22c55e' : s <= -3 ? '#ef4444' : s > 0 ? '#86efac' : s < 0 ? '#fca5a5' : '#888';
                        return <span style={{ fontSize: '0.72rem', padding: '0.15rem 0.4rem', borderRadius: '4px', background: `${c}20`, color: c, fontWeight: 700, border: `1px solid ${c}40` }}>Score {s > 0 ? '+' : ''}{s}</span>;
                      })()}
                      {/* RSI */}
                      {pos.indicators.rsi != null && (
                        <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${rsiColor(Number(pos.indicators.rsi))}20`, color: rsiColor(Number(pos.indicators.rsi)), fontWeight: 600 }}>
                          RSI {pos.indicators.rsi}
                        </span>
                      )}
                      {/* StochRSI */}
                      {pos.indicators.stochRsi != null && (
                        <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${rsiColor(Number(pos.indicators.stochRsi))}20`, color: rsiColor(Number(pos.indicators.stochRsi)) }}>
                          StochRSI {pos.indicators.stochRsi}
                        </span>
                      )}
                      {/* Williams %R */}
                      {pos.indicators.williamsR != null && (() => {
                        const w = Number(pos.indicators.williamsR);
                        const c = w > -20 ? '#ef4444' : w < -80 ? '#22c55e' : '#888';
                        return <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${c}18`, color: c }}>%R {pos.indicators.williamsR}</span>;
                      })()}
                      {/* CCI */}
                      {pos.indicators.cci != null && (() => {
                        const c2 = Number(pos.indicators.cci);
                        const col = c2 > 100 ? '#ef4444' : c2 < -100 ? '#22c55e' : '#888';
                        return <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${col}18`, color: col }}>CCI {pos.indicators.cci}</span>;
                      })()}
                      {/* VWAP deviation */}
                      {pos.indicators.vwapDev != null && (() => {
                        const v = Number(pos.indicators.vwapDev);
                        const col = v > 2 ? '#ef4444' : v < -2 ? '#22c55e' : '#888';
                        return <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${col}18`, color: col }}>VWAP {v >= 0 ? '+' : ''}{pos.indicators.vwapDev}%</span>;
                      })()}
                      {/* Bollinger */}
                      {pos.indicators.bb_pctB != null && (
                        <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: '#ffffff0d', color: '#888' }}>
                          BB {(Number(pos.indicators.bb_pctB) * 100).toFixed(0)}%
                        </span>
                      )}
                      {/* MACD */}
                      {pos.indicators.macdBull && <span style={{ fontSize: '0.72rem', color: '#22c55e', fontWeight: 700 }}>MACD↑</span>}
                      {pos.indicators.macdBear && <span style={{ fontSize: '0.72rem', color: '#ef4444', fontWeight: 700 }}>MACD↓</span>}
                      {/* Order book */}
                      {pos.indicators.obImbalance != null && (() => {
                        const ob = Number(pos.indicators.obImbalance);
                        const col = ob > 60 ? '#22c55e' : ob < 40 ? '#ef4444' : '#888';
                        return <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${col}18`, color: col }}>OB {ob}% bid</span>;
                      })()}
                      {/* Kimchi premium */}
                      {pos.indicators.kimchiPremium != null && (() => {
                        const k = Number(pos.indicators.kimchiPremium);
                        const col = k > 3 ? '#ef4444' : k < 0 ? '#22c55e' : '#f59e0b';
                        return <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${col}18`, color: col }}>Kimchi {k >= 0 ? '+' : ''}{pos.indicators.kimchiPremium}%</span>;
                      })()}
                      {/* ROC */}
                      {pos.indicators.roc != null && (() => {
                        const r = Number(pos.indicators.roc);
                        const col = r < -4 ? '#22c55e' : r > 4 ? '#ef4444' : '#888';
                        return <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.35rem', borderRadius: '3px', background: `${col}18`, color: col }}>ROC {r >= 0 ? '+' : ''}{pos.indicators.roc}%</span>;
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="ct__empty">No positions yet. Run DCA to start accumulating.</p>
        )}
      </section>

      {/* ═══ CONFIG ═══ */}
      <section className="card ct__config" style={{ padding: '1rem' }}>
        <h3>Bot Settings</h3>

        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">DCA Enabled</div>
            <div className="ct__toggle-sub">Buy weekly on schedule</div>
          </div>
          <Toggle checked={cfg.dca_enabled} onChange={(v) => setCfg((c) => ({ ...c, dca_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Signal Boost</div>
            <div className="ct__toggle-sub">Spend 50% extra when macro score ≥ 5</div>
          </div>
          <Toggle checked={cfg.signal_boost_enabled} onChange={(v) => setCfg((c) => ({ ...c, signal_boost_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Profit-Take</div>
            <div className="ct__toggle-sub">Sell 10/15/20/25% at +5/10/20/40%</div>
          </div>
          <Toggle checked={cfg.profit_take_enabled} onChange={(v) => setCfg((c) => ({ ...c, profit_take_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Signal Sells</div>
            <div className="ct__toggle-sub">RSI OB, BB upper, MACD bear, StochRSI OB, VWAP high, Williams OB, CCI OB, Kimchi high</div>
          </div>
          <Toggle checked={cfg.signal_sell_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, signal_sell_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Dip Buys</div>
            <div className="ct__toggle-sub">RSI/BB/VWAP/Williams/CCI/StochRSI/ROC dip signals — checked every hour</div>
          </div>
          <Toggle checked={cfg.dip_buy_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, dip_buy_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Trailing Stop</div>
            <div className="ct__toggle-sub">Sell 40% if price drops 30% from 14-day high (while profitable)</div>
          </div>
          <Toggle checked={cfg.trailing_stop_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, trailing_stop_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Fear & Greed Gate</div>
            <div className="ct__toggle-sub">Skip DCA on Extreme Greed (&gt;75) · Double on Extreme Fear (&lt;25)</div>
          </div>
          <Toggle checked={cfg.fear_greed_gate_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, fear_greed_gate_enabled: v }))} />
        </div>
        <div className="ct__toggle-row">
          <div>
            <div className="ct__toggle-label">Bear Market Pause</div>
            <div className="ct__toggle-sub">Halve DCA budget if BTC is 30%+ below 90-day high</div>
          </div>
          <Toggle checked={cfg.bear_market_pause_enabled ?? true} onChange={(v) => setCfg((c) => ({ ...c, bear_market_pause_enabled: v }))} />
        </div>

        <div className="ct__config-grid" style={{ marginTop: '0.75rem' }}>
          <div className="ct__field">
            <label>Weekly DCA Budget (₩)</label>
            <input
              type="number"
              min="5000"
              step="10000"
              value={cfg.weekly_budget_krw}
              onChange={(e) => setCfg((c) => ({ ...c, weekly_budget_krw: Number(e.target.value) }))}
            />
          </div>
          <div className="ct__field">
            <label>Dip Buy Reserve (₩)</label>
            <input type="number" min="5000" step="10000"
              value={cfg.dip_budget_krw ?? 100000}
              onChange={(e) => setCfg((c) => ({ ...c, dip_budget_krw: Number(e.target.value) }))}
            />
          </div>
        </div>

        <div className="ct__config-footer">
          <button type="button" className="ct__btn ct__btn--primary" onClick={saveConfig} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </div>
      </section>

      {/* ═══ RECENT TRADES ═══ */}
      <section className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem' }}>Recent Auto Trades</h3>
        {trades.length > 0 ? (
          <div className="ct__trades">
            <table className="ct__table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Coin</th>
                  <th>Side</th>
                  <th>KRW</th>
                  <th>Amount</th>
                  <th>Reason</th>
                </tr>
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
          <p className="ct__empty">No trades yet. Press "Run Cycle" to execute the first cycle.</p>
        )}
      </section>

      {/* ═══ PI STATUS ═══ */}
      <section className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>Raspberry Pi Trader</h3>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
                background: piOnline ? '#22c55e' : '#ef4444',
                boxShadow: piOnline ? '0 0 6px #22c55e' : 'none',
              }} />
              <span style={{ fontWeight: 700, color: piOnline ? '#22c55e' : '#ef4444' }}>
                {piOnline ? 'Online' : 'Offline'}
              </span>
            </div>
            {piLastSeen && (
              <div className="ct__muted" style={{ fontSize: '0.78rem' }}>
                Last seen: {new Date(piLastSeen).toLocaleString()}
              </div>
            )}
            {!piOnline && (
              <div style={{ fontSize: '0.78rem', color: '#f59e0b', marginTop: '0.3rem' }}>
                Pi must be running for trades to execute.
              </div>
            )}
          </div>
          {lastCycle && (
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: '0.78rem', color: '#888', marginBottom: '0.2rem' }}>Last cycle</div>
              <div style={{ fontSize: '0.82rem', color: lastCycle.ok ? '#22c55e' : '#ef4444' }}>
                {lastCycle.ok ? '✓ Success' : `✗ ${lastCycle.error}`}
              </div>
              {lastCycle.reason && (
                <div style={{ fontSize: '0.75rem', color: '#666' }}>
                  {lastCycle.reason} · {lastCycle.completedAt ? new Date(lastCycle.completedAt).toLocaleString() : ''}
                </div>
              )}
              {lastCycle.result?.dca?.length > 0 && (
                <div style={{ fontSize: '0.75rem', color: '#aaa', marginTop: '0.2rem' }}>
                  {lastCycle.result.dca.filter((t) => t.ok).length} buy(s) · {lastCycle.result.profitTake?.filter((t) => t.ok).length ?? 0} sell(s)
                </div>
              )}
            </div>
          )}
        </div>
        <p className="ct__muted" style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
          Trades execute on your Raspberry Pi (IP: 59.20.105.83 → Upbit allowlisted).
          Pi polls Supabase every 10s for triggers. Heartbeat updates every 5 min.
        </p>
      </section>

      {/* ═══ DANGER ZONE ═══ */}
      <section className="card ct__danger">
        <h4>Danger Zone</h4>
        <p>Kill switch immediately stops all automated trading. DCA and profit-take will not execute until deactivated.</p>
        <button type="button" className={`ct__btn ${killSwitch ? 'ct__btn--warn' : 'ct__btn--danger'}`} onClick={toggleKillSwitch}>
          {killSwitch ? '✓ Kill Switch Active — Click to Deactivate' : 'Activate Kill Switch'}
        </button>
      </section>
    </div>
  );
}
