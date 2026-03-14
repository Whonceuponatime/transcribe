import React, { useState, useEffect, useCallback } from 'react';
import './CryptoTraderDashboard.css';

const API = '';
const fmt = (n, d = 0) => n != null ? Number(n).toLocaleString('ko-KR', { maximumFractionDigits: d }) : '—';
const fmtCoin = (n) => n != null ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';
const pct = (n) => n != null ? `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(1)}%` : '—';

const REASON_LABELS = {
  DCA: '📅 DCA',
  DCA_SIGNAL_BOOST: '🚀 DCA + Signal Boost',
  PROFIT_TAKE_50PCT: '💰 Profit Take +50%',
  PROFIT_TAKE_100PCT: '💰 Profit Take +100%',
  PROFIT_TAKE_200PCT: '💰 Profit Take +200%',
};

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
  const [pingResult, setPingResult] = useState(null);

  // Config form state (synced from status)
  const [cfg, setCfg] = useState({
    dca_enabled: true,
    weekly_budget_krw: 100000,
    profit_take_enabled: true,
    signal_boost_enabled: true,
  });

  const fetchStatus = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API}/api/crypto-trader?action=status`);
      if (res.ok) {
        const d = await res.json();
        setStatus(d);
        setCfg({
          dca_enabled: d.config?.dca_enabled ?? true,
          weekly_budget_krw: d.config?.weekly_budget_krw ?? 100000,
          profit_take_enabled: d.config?.profit_take_enabled ?? true,
          signal_boost_enabled: d.config?.signal_boost_enabled ?? true,
        });
      } else {
        const e = await res.json();
        setError(e.error || 'Failed to load status');
      }
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const pingUpbit = useCallback(async () => {
    setPingResult(null);
    const res = await fetch(`${API}/api/crypto-trader?action=ping`);
    setPingResult(await res.json());
  }, []);

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
        const { dca, profitTake, skipped, errors } = j.result;
        const parts = [];
        if (dca.length) parts.push(`${dca.filter((t) => t.ok).length} DCA buy(s)`);
        if (profitTake.length) parts.push(`${profitTake.filter((t) => t.ok).length} profit-take sell(s)`);
        if (skipped.length) parts.push(skipped[0]);
        if (errors.length) setError(errors.join('; '));
        else setMsg(`Done — ${parts.join(', ') || 'nothing to do'}`);
        await fetchStatus();
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

  const killSwitch = status?.killSwitch ?? false;
  const positions = status?.positions ?? [];
  const trades = status?.recentTrades ?? [];
  const signalScore = status?.signalScore;
  const signalDecision = status?.signalDecision;
  const krwBalance = status?.krwBalance ?? 0;

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
          <span className={`ct__badge ${cfg.dca_enabled ? 'ct__badge--on' : 'ct__badge--off'}`}>
            DCA {cfg.dca_enabled ? 'ON' : 'OFF'}
          </span>
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
          <div className="ct__krw-sub">
            {cfg.weekly_budget_krw > 0 && krwBalance > 0
              ? `~${Math.floor(krwBalance / cfg.weekly_budget_krw)} weeks of DCA remaining`
              : 'Set weekly budget below'}
          </div>
        </div>
        {signalScore != null && (
          <div className="ct__signal-block">
            <div className="ct__signal-score">{signalScore}</div>
            <span className="ct__signal-label">Macro Score / 10</span>
            <div className="ct__signal-decision">{signalDecision?.replace('_', ' ')}</div>
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
                      ₩{fmt(pos.currentPrice)} · Value ₩{fmt(pos.currentValueKrw)}
                    </span>
                  )}
                  {pos.avgBuyKrw > 0 && (
                    <span className="ct__pos-price">Avg buy ₩{fmt(pos.avgBuyKrw)}</span>
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
            <div className="ct__toggle-sub">Auto-sell 20% at +50%, +100%, +200%</div>
          </div>
          <Toggle checked={cfg.profit_take_enabled} onChange={(v) => setCfg((c) => ({ ...c, profit_take_enabled: v }))} />
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
            <label>Split (BTC / ETH / SOL)</label>
            <div style={{ display: 'flex', gap: '0.4rem', fontSize: '0.82rem', color: '#aaa', alignItems: 'center', padding: '0.4rem 0' }}>
              BTC 50% · ETH 30% · SOL 20%
            </div>
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

      {/* ═══ UPBIT CONNECTION ═══ */}
      <section className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>Upbit Connection</h3>
        <p className="ct__muted" style={{ marginBottom: '0.5rem' }}>
          Test that your Upbit API key is working correctly.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="ct__btn" onClick={pingUpbit}>Test Connection</button>
          {pingResult && (
            <span style={{ fontSize: '0.88rem', color: pingResult.ok ? '#22c55e' : '#ef4444' }}>
              {pingResult.ok
                ? `✓ Connected — KRW balance: ₩${fmt(pingResult.krwBalance)}`
                : `✗ ${pingResult.error}`}
            </span>
          )}
        </div>
        <p className="ct__muted" style={{ marginTop: '0.5rem', fontSize: '0.78rem' }}>
          Ensure <code>UPBIT_ACCESS_KEY</code> and <code>UPBIT_SECRET_KEY</code> are set in Vercel environment variables.
          Disable withdrawal permission on the key — trading only.
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
