/**
 * Adaptive Entry Thresholds
 *
 * Computes bounded adaptive offsets for two entry thresholds:
 *   - BB %B (per regime)
 *   - Order-book imbalance minimum
 *
 * This is a thin stateless layer on top of bot_config base values.
 * It does NOT replace entry signal logic — it adjusts how tight or
 * loose the thresholds are, within hard absolute clamps.
 *
 * RSI thresholds are intentionally left fixed.
 *
 * Adaptation signals (applied as additive offsets to the base):
 *   +offset (loosen) when:
 *     • No buys in last 12h  (inactive_12h)
 *     • No buys in last 24h  (inactive_24h, replaces 12h — not stacked)
 *     • No open positions    (flat_portfolio)
 *   −offset (tighten) when:
 *     • ATR% above threshold (high_volatility)
 *     • Loss streak paused or drawdown halved (risk_active)
 *
 * Hard absolute clamps are applied after all offsets so the result
 * can never become reckless or meaninglessly tight.
 *
 * All offset and clamp values have defaults that can be overridden
 * via bot_config if desired, or left at their defaults.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

// ATR% above this value is considered elevated volatility.
const DEFAULT_ATR_HIGH_PCT = 3.0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ─── Main computation ────────────────────────────────────────────────────────

/**
 * Compute effective entry thresholds for the current cycle.
 *
 * @param {object} cfg - bot_config row
 * @param {object} ctx
 * @param {string}  ctx.regime            - 'UPTREND' | 'RANGE' | 'DOWNTREND'
 * @param {number|null} ctx.atrPct        - current ATR as % of price (BTC representative)
 * @param {number}  ctx.openPositionsCount
 * @param {number}  ctx.inactivityHours   - hours since last buy across all assets (Infinity if never)
 * @param {boolean} ctx.lossStreakActive  - streakPausedUntil is in the future
 * @param {boolean} ctx.drawdownHalved
 *
 * @returns {{
 *   effectiveBbUptrend:   number,
 *   effectiveBbRange:     number,
 *   effectiveBbDowntrend: number,
 *   effectiveObMin:       number,
 *   baseBbThreshold:      number,   // base for the current regime
 *   baseObMin:            number,
 *   offsets: { bb: number, ob: number, signals: string[] }
 * }}
 */
function computeAdaptiveThresholds(cfg, ctx) {
  const {
    regime            = 'RANGE',
    atrPct            = null,
    openPositionsCount = 0,
    inactivityHours   = 0,
    lossStreakActive  = false,
    drawdownHalved    = false,
  } = ctx;

  // Base thresholds from config
  const baseBbUptrend   = cfg.entry_bb_pct_uptrend   ?? 0.45;
  const baseBbRange     = cfg.entry_bb_pct_range      ?? 0.30;
  const baseBbDowntrend = cfg.entry_bb_pct_downtrend  ?? 0.05;
  const baseObMin       = cfg.ob_imbalance_min        ?? -0.45;

  // Shortcut: if adaptive system is disabled, return raw config values
  if (cfg.adaptive_thresholds_enabled === false) {
    const baseBb = regime === 'UPTREND' ? baseBbUptrend
                 : regime === 'DOWNTREND' ? baseBbDowntrend
                 : baseBbRange;
    return {
      effectiveBbUptrend:   baseBbUptrend,
      effectiveBbRange:     baseBbRange,
      effectiveBbDowntrend: baseBbDowntrend,
      effectiveObMin:       baseObMin,
      baseBbThreshold:      baseBb,
      baseObMin,
      offsets: { bb: 0, ob: 0, signals: ['adaptive_disabled'] },
    };
  }

  // ── Compute offsets ─────────────────────────────────────────────────────────
  let bbOffset = 0;
  let obOffset = 0;
  const signals = [];

  // 1. Inactivity: no buys in X hours takes priority over shorter window (not stacked).
  // Thresholds are configurable via bot_config so live adjustments need no deploy.
  // Defaults (24h / 12h) match the original hardcoded values — no behaviour change
  // until the columns are explicitly set to lower values in bot_config.
  const inactivity24hThresh = cfg.adaptive_inactivity_24h_hours ?? 24;
  const inactivity12hThresh = cfg.adaptive_inactivity_12h_hours ?? 12;
  if (inactivityHours >= inactivity24hThresh) {
    bbOffset += cfg.adaptive_bb_24h_offset ?? 0.07;
    obOffset += cfg.adaptive_ob_24h_offset ?? 0.07; // positive = toward 0 = looser
    signals.push('inactive_24h');
  } else if (inactivityHours >= inactivity12hThresh) {
    bbOffset += cfg.adaptive_bb_12h_offset ?? 0.04;
    obOffset += cfg.adaptive_ob_12h_offset ?? 0.04;
    signals.push('inactive_12h');
  }

  // 2. Flat portfolio — loosen slightly (non-stacking with above, additive)
  if (openPositionsCount === 0) {
    bbOffset += cfg.adaptive_bb_flat_offset ?? 0.03;
    obOffset += cfg.adaptive_ob_flat_offset ?? 0.03;
    signals.push('flat_portfolio');
  }

  // 3. Elevated volatility — tighten (negative offset)
  const atrHighPct = cfg.adaptive_atr_high_pct ?? DEFAULT_ATR_HIGH_PCT;
  if (atrPct != null && atrPct > atrHighPct) {
    bbOffset -= cfg.adaptive_bb_vol_offset ?? 0.05;
    obOffset -= cfg.adaptive_ob_vol_offset ?? 0.05; // negative = more negative = tighter
    signals.push('high_volatility');
  }

  // 4. Risk controls active — tighten (takes priority, applied on top)
  if (lossStreakActive) {
    bbOffset -= cfg.adaptive_bb_risk_offset ?? 0.08;
    obOffset -= cfg.adaptive_ob_risk_offset ?? 0.08;
    signals.push('loss_streak_active');
  }
  if (drawdownHalved) {
    // Drawdown halving already halves size in riskEngine; tighten entries too.
    // Use a smaller offset here to avoid double-punishing.
    bbOffset -= (cfg.adaptive_bb_risk_offset ?? 0.08) * 0.5;
    obOffset -= (cfg.adaptive_ob_risk_offset ?? 0.08) * 0.5;
    signals.push('drawdown_halved');
  }

  // ── Hard absolute clamps ─────────────────────────────────────────────────────
  // BB %B — higher = looser; cannot go below strict minimum or above reckless max
  const BB_UPTREND_MIN   = cfg.adaptive_bb_uptrend_min   ?? 0.20;
  const BB_UPTREND_MAX   = cfg.adaptive_bb_uptrend_max   ?? 0.60;
  const BB_RANGE_MIN     = cfg.adaptive_bb_range_min     ?? 0.10;
  const BB_RANGE_MAX     = cfg.adaptive_bb_range_max     ?? 0.50;
  const BB_DOWNTREND_MIN = cfg.adaptive_bb_downtrend_min ?? 0.02;
  const BB_DOWNTREND_MAX = cfg.adaptive_bb_downtrend_max ?? 0.12;

  // OB imbalance — less negative = looser (more orders allowed through)
  const OB_FLOOR = cfg.adaptive_ob_floor ?? -0.70; // most negative ever allowed
  const OB_CEIL  = cfg.adaptive_ob_ceil  ?? -0.15; // least negative ever allowed

  const effectiveBbUptrend   = clamp(baseBbUptrend   + bbOffset, BB_UPTREND_MIN,   BB_UPTREND_MAX);
  const effectiveBbRange     = clamp(baseBbRange     + bbOffset, BB_RANGE_MIN,     BB_RANGE_MAX);
  const effectiveBbDowntrend = clamp(baseBbDowntrend + bbOffset, BB_DOWNTREND_MIN, BB_DOWNTREND_MAX);
  const effectiveObMin       = clamp(baseObMin       + obOffset, OB_FLOOR,         OB_CEIL);

  // "Base for current regime" used for logging comparison
  const baseBbThreshold = regime === 'UPTREND'   ? baseBbUptrend
                        : regime === 'DOWNTREND' ? baseBbDowntrend
                        : baseBbRange;

  return {
    effectiveBbUptrend:   +effectiveBbUptrend.toFixed(4),
    effectiveBbRange:     +effectiveBbRange.toFixed(4),
    effectiveBbDowntrend: +effectiveBbDowntrend.toFixed(4),
    effectiveObMin:       +effectiveObMin.toFixed(4),
    baseBbThreshold:      +baseBbThreshold.toFixed(4),
    baseObMin:            +baseObMin.toFixed(4),
    offsets: {
      bb:      +(bbOffset.toFixed(4)),
      ob:      +(obOffset.toFixed(4)),
      signals,
    },
  };
}

module.exports = { computeAdaptiveThresholds };
