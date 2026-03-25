/**
 * Risk Engine — portfolio-level circuit breakers.
 *
 * All checks return { ok: boolean, reason?: string }.
 * The signal engine calls allows() before submitting any trade intent.
 *
 * Checks (in order):
 *   1. Max asset exposure (BTC ≤ 35%, ETH ≤ 25%, SOL ≤ 10% of NAV)
 *   2. Max new risk per signal (≤ 2% of NAV)
 *   3. Max entries per coin per 24h (≤ 3)
 *   4. Daily turnover cap (≤ 35% of NAV)
 *   5. Loss streak breaker (5 consecutive losing exits → pause 24h)
 *   6. Drawdown breaker (7-day realized drawdown < −4% → halve tactical size)
 */

// ─── In-process circuit-breaker state ────────────────────────────────────────
// These are persisted to Supabase but also kept in memory for fast access.
let _state = {
  lossStreak:        0,         // consecutive losing exit count
  streakPausedUntil: null,      // ISO timestamp — null means not paused
  drawdownHalved:    false,     // tactical size halved due to drawdown
  lastResetDay:      null,      // YYYY-MM-DD — for daily stats reset
  dailyTurnoverKrw:  0,         // KRW traded today
  entriesBy24h:      {},        // { 'BTC': [timestamp, ...] }
};

/** Persist circuit-breaker state to app_settings. */
async function persistState(supabase) {
  try {
    await supabase.from('app_settings').upsert({
      key:        'risk_engine_state',
      value:      _state,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}
}

/** Load state from DB on startup. */
async function loadState(supabase) {
  try {
    const { data } = await supabase.from('app_settings')
      .select('value').eq('key', 'risk_engine_state').single();
    if (data?.value) {
      _state = { ..._state, ...data.value };
    }
  } catch (_) {}
}

/** Reset daily counters if calendar day has changed. */
function maybeResetDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (_state.lastResetDay !== today) {
    _state.dailyTurnoverKrw = 0;
    _state.entriesBy24h     = {};
    _state.lastResetDay     = today;
  }
}

/** Remove entry timestamps older than 24h. */
function cleanEntries(asset) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  _state.entriesBy24h[asset] = (_state.entriesBy24h[asset] || [])
    .filter((ts) => ts > cutoff);
}

// ─── Exposure check ──────────────────────────────────────────────────────────
function checkExposure(asset, proposedKrw, portfolioState, cfg) {
  const limits = {
    BTC: cfg.max_btc_pct ?? 35,
    ETH: cfg.max_eth_pct ?? 25,
    SOL: cfg.max_sol_pct ?? 10,
  };
  const limit = limits[asset];
  if (limit == null) return { ok: true };

  const navKrw     = portfolioState.navKrw ?? 0;
  if (navKrw <= 0) return { ok: true };

  const currentKrw = portfolioState.holdingsByAsset?.[asset] ?? 0;
  const afterKrw   = currentKrw + proposedKrw;
  const afterPct   = (afterKrw / navKrw) * 100;

  if (afterPct > limit) {
    return {
      ok:     false,
      reason: `${asset} exposure ${afterPct.toFixed(1)}% would exceed ${limit}% cap`,
    };
  }
  return { ok: true };
}

// ─── Risk per signal check ───────────────────────────────────────────────────
function checkRiskPerSignal(proposedKrw, portfolioState, cfg) {
  const navKrw  = portfolioState.navKrw ?? 0;
  if (navKrw <= 0) return { ok: true };
  const maxPct  = cfg.max_risk_per_signal_pct ?? 2;
  const maxKrw  = navKrw * maxPct / 100;
  if (proposedKrw > maxKrw) {
    return {
      ok:     false,
      reason: `Order ₩${Math.round(proposedKrw).toLocaleString()} exceeds 2% NAV cap ₩${Math.round(maxKrw).toLocaleString()}`,
      cappedKrw: maxKrw,  // caller may use this to resize rather than block
    };
  }
  return { ok: true };
}

// ─── Entries per 24h check ───────────────────────────────────────────────────
function checkEntries24h(asset, cfg) {
  cleanEntries(asset);
  const count = (_state.entriesBy24h[asset] || []).length;
  const limit = cfg.max_entries_per_coin_24h ?? 3;
  if (count >= limit) {
    return {
      ok:     false,
      reason: `${asset} has ${count} entries in last 24h (limit ${limit})`,
    };
  }
  return { ok: true };
}

// ─── Daily turnover check ────────────────────────────────────────────────────
function checkDailyTurnover(proposedKrw, portfolioState, cfg) {
  maybeResetDaily();
  const navKrw = portfolioState.navKrw ?? 0;
  if (navKrw <= 0) return { ok: true };
  const capPct   = cfg.daily_turnover_cap_pct ?? 35;
  const capKrw   = navKrw * capPct / 100;
  const afterKrw = _state.dailyTurnoverKrw + proposedKrw;
  if (afterKrw > capKrw) {
    return {
      ok:     false,
      reason: `Daily turnover ₩${Math.round(afterKrw).toLocaleString()} would exceed ${capPct}% cap (₩${Math.round(capKrw).toLocaleString()})`,
    };
  }
  return { ok: true };
}

// ─── Loss streak check ───────────────────────────────────────────────────────
function checkLossStreak(cfg) {
  const limit = cfg.loss_streak_limit ?? 5;
  if (_state.streakPausedUntil) {
    const until = new Date(_state.streakPausedUntil).getTime();
    if (Date.now() < until) {
      const remainMin = Math.ceil((until - Date.now()) / 60000);
      return {
        ok:     false,
        reason: `Loss streak breaker active — ${_state.lossStreak} consecutive losses. Tactical buys paused for ${remainMin}min`,
      };
    }
    // Pause expired — reset
    _state.streakPausedUntil = null;
    _state.lossStreak        = 0;
  }
  return { ok: true };
}

// ─── Drawdown check (returns sizeMult) ───────────────────────────────────────
function checkDrawdown() {
  return {
    ok:       true,
    sizeMult: _state.drawdownHalved ? 0.5 : 1.0,
  };
}

// ─── Compute 7-day realized drawdown and update state ────────────────────────
async function updateDrawdownState(supabase, cfg) {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: snaps } = await supabase.from('portfolio_snapshots_v2')
      .select('nav_krw, created_at')
      .gte('created_at', since7d)
      .order('created_at', { ascending: true })
      .limit(500);

    if (!snaps || snaps.length < 2) return;

    const startNav = snaps[0].nav_krw;
    const endNav   = snaps[snaps.length - 1].nav_krw;
    const drawdownPct = startNav > 0 ? ((endNav - startNav) / startNav) * 100 : 0;

    const threshold = cfg.drawdown_7d_threshold ?? -4;
    const wasHalved = _state.drawdownHalved;
    _state.drawdownHalved = drawdownPct < threshold;

    if (_state.drawdownHalved !== wasHalved) {
      console.log(`[risk] Drawdown breaker ${_state.drawdownHalved ? 'ACTIVATED' : 'CLEARED'}: 7d P&L ${drawdownPct.toFixed(2)}% (threshold ${threshold}%)`);
    }
  } catch (_) {}
}

// ─── Record a fill outcome to update streak counters ─────────────────────────
async function recordFillOutcome(supabase, { asset, side, gainPct, krwAmount, cfg }) {
  if (side !== 'sell') return;

  maybeResetDaily();
  _state.dailyTurnoverKrw += (krwAmount ?? 0);

  const limit = cfg?.loss_streak_limit ?? 5;
  if (gainPct != null && gainPct < 0) {
    _state.lossStreak++;
    if (_state.lossStreak >= limit && !_state.streakPausedUntil) {
      _state.streakPausedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      console.log(`[risk] ★ Loss streak breaker triggered (${_state.lossStreak} losses). Tactical buys paused 24h.`);
    }
  } else if (gainPct != null && gainPct > 0) {
    _state.lossStreak = 0;
  }

  await persistState(supabase);
}

/** Record a buy entry (for 24h entry count and daily turnover). */
async function recordEntry(supabase, { asset, krwAmount }) {
  maybeResetDaily();
  cleanEntries(asset);
  if (!_state.entriesBy24h[asset]) _state.entriesBy24h[asset] = [];
  _state.entriesBy24h[asset].push(Date.now());
  _state.dailyTurnoverKrw += (krwAmount ?? 0);
  await persistState(supabase);
}

// ─── Main gate ───────────────────────────────────────────────────────────────
/**
 * Check whether a trade intent is permitted.
 *
 * @param {object} intent          — { asset, side, krwAmount, strategy_tag }
 * @param {object} portfolioState  — { navKrw, holdingsByAsset: { BTC: krw, ... } }
 * @param {object} cfg             — bot_config row
 * @returns {{ ok, reason?, sizeMult?, cappedKrw? }}
 */
function allows(intent, portfolioState, cfg) {
  const { asset, side, krwAmount } = intent;

  // Sells are always allowed through risk engine (exits are protective)
  if (side === 'sell') return { ok: true, sizeMult: 1.0 };

  // 1. Loss streak breaker
  const streak = checkLossStreak(cfg);
  if (!streak.ok) return streak;

  // 2. Asset exposure cap
  const exposure = checkExposure(asset, krwAmount, portfolioState, cfg);
  if (!exposure.ok) return exposure;

  // 3. Risk per signal (returns cappedKrw suggestion if over, but doesn't hard-block)
  const riskCheck = checkRiskPerSignal(krwAmount, portfolioState, cfg);
  // If over cap, we cap the order rather than block it entirely
  const effectiveKrw = riskCheck.cappedKrw ?? krwAmount;

  // 4. Entries per 24h
  const entriesCheck = checkEntries24h(asset, cfg);
  if (!entriesCheck.ok) return entriesCheck;

  // 5. Daily turnover cap
  const turnover = checkDailyTurnover(effectiveKrw, portfolioState, cfg);
  if (!turnover.ok) return turnover;

  // 6. Drawdown size multiplier
  const { sizeMult } = checkDrawdown();

  return {
    ok:        true,
    sizeMult,
    cappedKrw: riskCheck.cappedKrw ?? null,
  };
}

/**
 * Returns the timestamp of the most recent buy across all tracked assets.
 * Used by the adaptive threshold engine to compute inactivity duration.
 * Returns null if no buys have been recorded in the current state.
 */
function getLastBuyTimestamp() {
  const allTimestamps = Object.values(_state.entriesBy24h).flat();
  if (allTimestamps.length === 0) return null;
  return Math.max(...allTimestamps);
}

/**
 * Returns a snapshot of the current risk state for read-only consumption.
 * Callers must not mutate the returned object.
 */
function getRiskState() {
  return {
    lossStreak:        _state.lossStreak,
    streakPausedUntil: _state.streakPausedUntil,
    drawdownHalved:    _state.drawdownHalved,
    dailyTurnoverKrw:  _state.dailyTurnoverKrw,
  };
}

/**
 * Get a summary of currently active circuit breakers for dashboard display.
 */
function getCircuitBreakerStatus() {
  const active = [];
  if (_state.streakPausedUntil && Date.now() < new Date(_state.streakPausedUntil).getTime()) {
    active.push({ type: 'LOSS_STREAK', detail: `${_state.lossStreak} consecutive losses`, until: _state.streakPausedUntil });
  }
  if (_state.drawdownHalved) {
    active.push({ type: 'DRAWDOWN', detail: '7-day drawdown exceeded threshold — tactical size halved' });
  }
  return {
    anyActive:   active.length > 0,
    breakers:    active,
    lossStreak:  _state.lossStreak,
    dailyTurnoverKrw: _state.dailyTurnoverKrw,
  };
}

module.exports = {
  loadState,
  allows,
  recordFillOutcome,
  recordEntry,
  updateDrawdownState,
  getCircuitBreakerStatus,
  getLastBuyTimestamp,
  getRiskState,
};
