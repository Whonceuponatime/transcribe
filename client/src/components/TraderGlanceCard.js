import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';

const POLL_MS = 30000;
const STALE_SNAPSHOT_S = 600;

function fmtKrw(n) {
  if (n == null) return '—';
  return `₩${Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default function TraderGlanceCard() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/crypto-trader?action=status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch (err) {
        console.warn('[TraderGlanceCard] fetch failed', err);
      }
    };

    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(fetchStatus, POLL_MS);
    };
    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    fetchStatus();
    if (!document.hidden) start();

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchStatus();
        start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const totalValueKrw = status?.totalValueKrw ?? null;
  const krwBalance    = status?.krwBalance    ?? null;
  const piOnline      = status?.piOnline      ?? false;
  const piLastSeen    = status?.piLastSeen    ?? null;
  const systemFrozen  = status?.systemFrozen  ?? false;
  const killSwitch    = status?.killSwitch    ?? false;
  const snapshotAt    = status?.snapshotAt    ?? null;
  const snapshotAge   = status?.snapshotAge   ?? null;
  const positions     = status?.positions     ?? [];
  const recentTrades  = status?.recentTrades  ?? [];
  const lastTrade     = recentTrades[0] || null;

  const positionsLine =
    status == null
      ? '— open positions'
      : `${positions.length} open ${positions.length === 1 ? 'position' : 'positions'}`;

  const updatedLine = snapshotAt
    ? `${snapshotAge != null && snapshotAge > STALE_SNAPSHOT_S ? '⚠ ' : ''}Updated ${fmtTime(snapshotAt)}`
    : '—';

  return (
    <article className="card home-glance" aria-label="Upbit bot at-a-glance">
      <div className="home-glance__header">
        <h3 className="home-glance__title">
          <Bot size={20} className="home-glance__title-icon" />
          <span>Upbit Bot</span>
        </h3>
        <div className="home-glance__pills">
          {killSwitch && (
            <span className="home-glance__pill home-glance__pill--kill" title="Kill switch active">
              KILL
            </span>
          )}
          {systemFrozen && (
            <span className="home-glance__pill home-glance__pill--frozen" title="System frozen by reconciliation">
              FROZEN
            </span>
          )}
          {status && (
            <span
              className={`home-glance__pill home-glance__pill--status ${piOnline ? 'is-online' : 'is-offline'}`}
              title={piLastSeen ? `Last heartbeat ${fmtTime(piLastSeen)}` : 'No heartbeat received'}
            >
              <span className="home-glance__dot" aria-hidden />
              {piOnline ? 'Online' : 'Offline'}
            </span>
          )}
        </div>
      </div>

      <div className="home-glance__hero">{fmtKrw(totalValueKrw)}</div>

      <div className="home-glance__sub">
        Cash {fmtKrw(krwBalance)} · {positionsLine}
      </div>

      {lastTrade && (
        <div className="home-glance__recent">
          Last: {String(lastTrade.side || '').toUpperCase()} {lastTrade.coin} · {timeAgo(lastTrade.executed_at)}
        </div>
      )}

      <div className="home-glance__footer">
        <span className="home-glance__updated">{updatedLine}</span>
        <Link to="/trader" className="home-glance__link">Open trader →</Link>
      </div>
    </article>
  );
}
