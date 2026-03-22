/**
 * Crypto Trader v2 — thin orchestrator.
 *
 * Strategy and execution are fully delegated to separate modules:
 *   regimeEngine  — BTC regime (UPTREND / RANGE / DOWNTREND)
 *   signalEngine  — 4-factor entry + ATR-based exit evaluation
 *   riskEngine    — portfolio-level circuit breakers
 *   executionEngine — order placement with idempotency and retry
 *
 * Modes:
 *   paper  — all logic runs, decisions logged, NO exchange orders sent (default)
 *   shadow — same as paper but with a clear [SHADOW] label in events
 *   live   — real orders sent to Upbit
 *
 * The v1 cryptoTrader.js continues running unchanged in parallel
 * until v2 is verified and mode is switched to 'live'.
 */

const upbit          = require('./upbit');
const regimeEngine   = require('./regimeEngine');
const signalEngine   = require('./signalEngine');
const riskEngine     = require('./riskEngine');
const execEngine     = require('./executionEngine');
const adopter        = require('./portfolioAdopter');
const reconEngine    = require('./reconciliationEngine');
const { compositeSignal } = require('./indicators');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_COINS = ['BTC', 'ETH', 'SOL'];

// Rate-limit CYCLE_FROZEN events to once per hour per freeze period.
let _lastCycleFrozenLogAt = 0;
const CYCLE_FROZEN_LOG_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Rate-limit EXIT_EVALUATION to once per 30 min per position.
const _exitEvalLastLogAt = new Map();
const EXIT_EVAL_LOG_INTERVAL_MS = 30 * 60 * 1000; // 30 min

// Rate-limit BUY_DECISION to once per 10 min per symbol.
// Written for ALL coins every evaluation, not just those with a signal.
// This gives a clean per-symbol per-cycle audit of why no buy happened.
const _buyDecisionLastLogAt = new Map();
const BUY_DECISION_LOG_INTERVAL_MS = 10 * 60 * 1000; // 10 min

async function getV2Config(supabase) {
  try {
    const { data } = await supabase.from('bot_config').select('*').limit(1).single();
    if (!data) return {};
    // Defaults for live-only operation
    return {
      ...data,
      trading_enabled: data.trading_enabled ?? true,
      buys_enabled:    data.buys_enabled    ?? true,
      sells_enabled:   data.sells_enabled   ?? true,
    };
  } catch (_) {
    return {};
  }
}

// ─── Portfolio state ──────────────────────────────────────────────────────────

async function getPortfolioState(supabase, coins, priceMap, usdtKrwRate) {
  const accounts = await upbit.getAccounts().catch(() => []);
  const krwAcc   = accounts.find((a) => a.currency === 'KRW');
  const krwBal   = Number(krwAcc?.balance ?? 0);

  const holdingsByAsset = {};
  let holdingsTotal = 0;

  for (const coin of coins) {
    const acc = accounts.find((a) => a.currency === coin);
    const qty = Number(acc?.balance ?? 0);
    const val = qty * (priceMap[coin] ?? 0);
    holdingsByAsset[coin] = val;
    holdingsTotal += val;
  }

  const navKrw      = krwBal + holdingsTotal;
  const navUsdProxy = usdtKrwRate && usdtKrwRate > 0 ? navKrw / usdtKrwRate : null;
  const krwPct      = navKrw > 0 ? (krwBal / navKrw) * 100 : 0;

  return {
    accounts,
    krwBalance: krwBal,
    holdingsByAsset,
    holdingsTotal,
    navKrw,
    navUsdProxy,
    krwPct,
  };
}

// ─── Open positions from DB ───────────────────────────────────────────────────

// Returns open, adopted, and partial positions for all managed strategy tags.
// Includes 'unassigned' (adopted holdings awaiting classification).
// Filters to managed=true so unsupported/excluded holdings are never touched.
async function getOpenPositions(supabase) {
  try {
    const { data } = await supabase.from('positions')
      .select('*')
      .in('state', ['open', 'adopted', 'partial'])
      .in('strategy_tag', ['tactical', 'unassigned'])
      .eq('managed', true);
    return data ?? [];
  } catch (_) {
    return [];
  }
}

/**
 * Check whether an open or adopted position already exists for an asset.
 * Used to prevent buy duplication when an adopted holding is present.
 */
async function hasExistingPosition(supabase, asset) {
  try {
    const { data } = await supabase.from('positions')
      .select('position_id, state').eq('asset', asset)
      .in('state', ['open', 'adopted', 'partial'])
      .limit(1).single();
    return data ?? null;
  } catch (_) {
    return null;
  }
}

/** Update a position's qty and avg_cost after a fill. */
async function applyFillToPosition(supabase, positionId, fill) {
  if (!positionId) return;
  try {
    const { data: pos } = await supabase.from('positions')
      .select('qty_open, qty_total, avg_cost_krw, strategy_tag')
      .eq('position_id', positionId).single();

    if (!pos) return;

    if (fill.side === 'buy') {
      const newQty  = (pos.qty_open ?? 0) + fill.qty;
      const newCost = ((pos.avg_cost_krw ?? 0) * (pos.qty_total ?? 0) + fill.price_krw * fill.qty)
                      / (newQty || 1);
      await supabase.from('positions').update({
        qty_open:    newQty,
        qty_total:   (pos.qty_total ?? 0) + fill.qty,
        avg_cost_krw: newCost,
        updated_at:  new Date().toISOString(),
      }).eq('position_id', positionId);
    } else {
      const newQty = Math.max(0, (pos.qty_open ?? 0) - fill.qty);
      const pnl    = (fill.price_krw - (pos.avg_cost_krw ?? 0)) * fill.qty - (fill.fee_krw ?? 0);
      await supabase.from('positions').update({
        qty_open:    newQty,
        realized_pnl: ((pos.realized_pnl ?? 0) + pnl),
        state:       newQty <= 0 ? 'closed' : 'partial',
        closed_at:   newQty <= 0 ? new Date().toISOString() : null,
        updated_at:  new Date().toISOString(),
      }).eq('position_id', positionId);
    }
  } catch (_) {}
}

/** Get or create a tactical position for an asset. */
async function getOrCreatePosition(supabase, asset, regime, reason, atrVal, usdKrw) {
  try {
    const { data: existing } = await supabase.from('positions')
      .select('position_id').eq('asset', asset).eq('strategy_tag', 'tactical').eq('state', 'open')
      .order('opened_at', { ascending: false }).limit(1).single();

    if (existing) return existing.position_id;

    const { data: created } = await supabase.from('positions').insert({
      asset,
      strategy_tag: 'tactical',
      qty_open:     0,
      qty_total:    0,
      avg_cost_krw: 0,
      entry_regime: regime?.regime ?? null,
      entry_reason: reason ?? null,
      atr_at_entry: atrVal ?? null,
      usd_proxy_fx: usdKrw ?? null,
      state:        'open',
    }).select('position_id').single();

    return created?.position_id ?? null;
  } catch (_) {
    return null;
  }
}

// ─── Snapshot persistence ─────────────────────────────────────────────────────

async function saveV2Snapshot(supabase, portfolio, regime, circuitBreakers, coins, priceMap) {
  try {
    const snap = {
      nav_krw:       portfolio.navKrw,
      nav_usd_proxy: portfolio.navUsdProxy,
      usdt_krw_rate: portfolio.navUsdProxy && portfolio.navKrw ? portfolio.navKrw / portfolio.navUsdProxy : null,
      krw_balance:   portfolio.krwBalance,
      krw_pct:       portfolio.krwPct,
      regime:        regime?.regime ?? null,
      circuit_breakers: circuitBreakers,
    };

    for (const coin of (coins || DEFAULT_COINS)) {
      const val = portfolio.holdingsByAsset?.[coin] ?? 0;
      const pct = portfolio.navKrw > 0 ? (val / portfolio.navKrw) * 100 : 0;
      snap[`${coin.toLowerCase()}_value_krw`] = val;
      snap[`${coin.toLowerCase()}_pct`]       = pct;
    }

    await supabase.from('portfolio_snapshots_v2').insert(snap);

    // Also persist to app_settings for cheap dashboard reads
    await supabase.from('app_settings').upsert({
      key:        'v2_portfolio_snapshot',
      value:      snap,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}
}

// ─── Log research-only indicators to bot_events ───────────────────────────────

async function logResearchIndicators(supabase, coin, sig, regime, mode) {
  try {
    await supabase.from('bot_events').insert({
      event_type:   'RESEARCH_INDICATORS',
      severity:     'debug',
      subsystem:    'signal_engine',
      message:      `${coin} research indicators (not used in live decisions)`,
      context_json: {
        coin,
        stochRsi:   sig?.stochRsi,
        williamsR:  sig?.williamsR,
        cci:        sig?.cci,
        roc:        sig?.roc,
        obvSlope:   sig?.obvSlope,
        kimchi:     sig?.kimchiPremium,
        score:      sig?.score,
        signals:    sig?.signals?.map((s) => s.name),
      },
      regime: regime?.regime ?? null,
      mode,
    });
  } catch (_) {}
}

// ─── USDT/KRW rate ────────────────────────────────────────────────────────────

async function fetchUsdtKrwRate() {
  try {
    const tickers = await upbit.getTicker(['KRW-USDT']);
    return tickers?.[0]?.trade_price ?? null;
  } catch (_) {
    return null;
  }
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

/**
 * Run one full v2 trading cycle.
 *
 * @param {SupabaseClient} supabase
 * @param {object} opts — { dipBuyOnly, forceDca }
 */
async function executeCycleV2(supabase, opts = {}) {
  const EXECUTION_MODE = 'live'; // this engine is always live
  const summary = { execution_mode: EXECUTION_MODE, engine: 'V2', regime: null, sells: [], buys: [], skipped: [], errors: [] };

  try {
    // ── 0. Read config ───────────────────────────────────────────────────────
    const cfg             = await getV2Config(supabase);
    const coins           = cfg.coins           ?? DEFAULT_COINS;
    const tradingEnabled  = cfg.trading_enabled ?? true;
    const buysEnabled     = cfg.buys_enabled    ?? true;
    const sellsEnabled    = cfg.sells_enabled   ?? true;

    if (!tradingEnabled) {
      summary.skipped.push('trading_enabled=false in bot_config');
      return summary;
    }

    // ── 0b. Freeze gate — block ALL order placement if system is frozen ──────
    if (reconEngine.isSystemFrozen()) {
      const reasons = reconEngine.getFreezeReasons();
      summary.skipped.push(`System frozen — ${reasons.join('; ')}`);
      console.log(`[v2] Cycle skipped — system frozen: ${reasons.join('; ')}`);

      // Write CYCLE_FROZEN on first frozen cycle and then at most once per hour.
      // On first run after restart _lastCycleFrozenLogAt=0, so it fires immediately.
      // This explains why EXIT_EVALUATION / POSITION_SKIP_PROTECTED / EXECUTION
      // are absent from the export — cycles never reached sell/buy logic.
      const now = Date.now();
      if (now - _lastCycleFrozenLogAt >= CYCLE_FROZEN_LOG_INTERVAL_MS) {
        _lastCycleFrozenLogAt = now;
        try {
          await supabase.from('bot_events').insert({
            event_type:   'CYCLE_FROZEN',
            severity:     'warn',
            subsystem:    'orchestrator',
            message:      `V2 cycles frozen (mode=${mode}) — ${reasons[0] ?? 'unknown reason'}`,
            context_json: {
              freeze_reasons:           reasons,
              engine:                   'V2',
              execution_mode:           EXECUTION_MODE,
              first_cycle_after_restart: _lastCycleFrozenLogAt === now,
              explanation: 'EXIT_EVALUATION, POSITION_SKIP_PROTECTED, EXECUTION absent until freeze clears.',
            },
            mode: EXECUTION_MODE,
          });
        } catch (_) {}
      }

      return summary;
    }

    // ── 1. Fetch prices + USDT rate in parallel ───────────────────────────────
    const [tickers, usdtKrwRate, orderBooks] = await Promise.all([
      upbit.getTicker(coins.map((c) => `KRW-${c}`)).catch(() => []),
      fetchUsdtKrwRate(),
      upbit.getOrderBook(coins.map((c) => `KRW-${c}`)).catch(() => []),
    ]);

    const priceMap = {};
    for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

    // ── 2. Regime ─────────────────────────────────────────────────────────────
    const regime = await regimeEngine.getRegime(supabase, cfg);
    summary.regime = regime.regime;
    console.log(`\n[v2] Mode=${mode}  Regime=${regime.regime}  EMA50=${regime.ema50}  EMA200=${regime.ema200}  ADX=${regime.adxVal}`);

    // ── 3. Portfolio state ────────────────────────────────────────────────────
    const portfolio = await getPortfolioState(supabase, coins, priceMap, usdtKrwRate);
    console.log(`[v2] NAV ₩${Math.round(portfolio.navKrw).toLocaleString()} (USD-proxy: ${portfolio.navUsdProxy ? '$' + Math.round(portfolio.navUsdProxy).toLocaleString() : '—'})  KRW ${portfolio.krwPct.toFixed(1)}%`);

    // ── 4. Risk engine state + circuit breakers ───────────────────────────────
    await riskEngine.updateDrawdownState(supabase, cfg);
    const cbStatus = riskEngine.getCircuitBreakerStatus();

    // ── 5. Per-coin analysis (compute live indicators + research indicators) ──
    const liveIndicators = {};
    for (const coin of coins) {
      try {
        const ind = await signalEngine.computeIndicators(coin, orderBooks);
        liveIndicators[coin] = ind;

        // Also compute full composite signal for research logging (NOT used for live decisions)
        // Errors here are non-fatal. Use getMinuteCandles which returns a flat array.
        try {
          const candles = await upbit.getMinuteCandles(`KRW-${coin}`, 240, 120);
          if (Array.isArray(candles) && candles.length > 30) {
            const closes  = candles.map((c) => c.trade_price);
            const highs   = candles.map((c) => c.high_price);
            const lows    = candles.map((c) => c.low_price);
            const volumes = candles.map((c) => c.candle_acc_trade_volume ?? 0);
            const sig = compositeSignal(closes, highs, lows, volumes);
            await logResearchIndicators(supabase, coin, sig, regime, EXECUTION_MODE);
          }
        } catch (_) { /* research logging is non-fatal */ }
      } catch (err) {
        summary.errors.push(`Indicator error ${coin}: ${err.message}`);
      }
    }

    // ── 6. Sell cycle ─────────────────────────────────────────────────────────
    if (!opts.dipBuyOnly) {
      const openPositions = await getOpenPositions(supabase);

      // Track which protected positions we have already logged this cycle
      // to avoid emitting POSITION_SKIP_PROTECTED on every 2-min tick.
      const protectedLogged = new Set();

      for (const position of openPositions) {
        const coin = position.asset;
        const ind  = liveIndicators[coin];
        if (!ind) continue;

        // ── Protected position gate ─────────────────────────────────────────
        // Emit POSITION_SKIP_PROTECTED once per position per cycle run (not per tick).
        if (signalEngine.isFullyProtected(position) && !protectedLogged.has(position.position_id)) {
          protectedLogged.add(position.position_id);
          try {
            await supabase.from('bot_events').insert({
              event_type:   'POSITION_SKIP_PROTECTED',
              severity:     'info',
              subsystem:    'sell_cycle',
              message:      `${coin} skipped — protected adopted/unassigned position`,
              context_json: {
                position_id:  position.position_id,
                symbol:       coin,
                origin:       position.origin,
                strategy_tag: position.strategy_tag,
                state:        position.state,
                qty_open:     Number(position.qty_open),
                avg_cost_krw: position.avg_cost_krw,
                reason:       'protected_adopted_unassigned',
              },
              regime: regime?.regime ?? null,
              mode:   EXECUTION_MODE,
            });
          } catch (_) {}
          continue;
        }

        // Fetch runtime fees for required edge calculation
        const { bidFeeRate, askFeeRate } = await upbit.getOrderFees(`KRW-${coin}`).catch(() => ({ bidFeeRate: 0.0025, askFeeRate: 0.0025 }));
        const peakKey = `peak_price_${coin}`;

        // Get peak price for trailing stop
        let peakPrice = ind.currentPrice;
        try {
          const { data: peakRow } = await supabase.from('app_settings').select('value').eq('key', peakKey).single();
          if (peakRow?.value?.price) peakPrice = peakRow.value.price;
        } catch (_) {}

        // Update peak
        if (ind.currentPrice > peakPrice) {
          try {
            await supabase.from('app_settings').upsert({ key: peakKey, value: { price: ind.currentPrice, updated_at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
          } catch (_) {}
        }

        const exits = signalEngine.evaluateExit(position, ind, regime, askFeeRate, cfg, Math.max(peakPrice, ind.currentPrice));

        // ── EXIT_EVALUATION structured log ──────────────────────────────────
        // Always emitted for every managed non-protected position, once per 30 min.
        // This means underwater positions also appear in the audit trail with
        // blocker_summary explaining why no exit fired. Without this, the export
        // has no evidence that V2 is actually evaluating positions.
        const gainPctRaw  = ind.currentPrice && position.avg_cost_krw
          ? ((ind.currentPrice - position.avg_cost_krw) / position.avg_cost_krw) * 100
          : null;
        const roundTrip   = (askFeeRate * 2) * 100;
        const reqEdgePct  = roundTrip + 0.20;
        const netGainPct  = gainPctRaw != null ? gainPctRaw - roundTrip : null;
        const aboveEdge   = netGainPct != null && netGainPct >= reqEdgePct;
        const exitFired   = exits.length > 0;

        // Determine blocker reason for non-eligible positions
        let blockerSummary = null;
        if (!exitFired) {
          if (position.avg_cost_krw == null || Number(position.avg_cost_krw) <= 0) {
            blockerSummary = 'no_cost_basis — position cannot be evaluated without avg_cost_krw';
          } else if (gainPctRaw == null) {
            blockerSummary = 'current_price_unavailable';
          } else if (!aboveEdge) {
            blockerSummary = `below_required_edge: net_pnl=${netGainPct?.toFixed(2)}% < required=${reqEdgePct.toFixed(2)}%`;
          } else {
            blockerSummary = 'above_edge_but_no_exit_condition_met';
          }
        }

        const lastEvalLog     = _exitEvalLastLogAt.get(position.position_id) ?? 0;
        const shouldLogEval   = exitFired || (Date.now() - lastEvalLog) >= EXIT_EVAL_LOG_INTERVAL_MS;

        if (shouldLogEval) {
          _exitEvalLastLogAt.set(position.position_id, Date.now());
          try {
            await supabase.from('bot_events').insert({
              event_type:   'EXIT_EVALUATION',
              severity:     exitFired ? 'info' : 'debug',
              subsystem:    'sell_cycle',
              message:      exitFired
                ? `${coin} EXIT: ${exits.map((e) => e.reason).join(', ')}`
                : `${coin} evaluated — not eligible: ${blockerSummary}`,
              context_json: {
                position_id:        position.position_id,
                symbol:             coin,
                engine:             'V2',
                mode,
                strategy_tag:       position.strategy_tag,
                state:              position.state,
                protected:          false,
                evaluated:          true,
                pnl_pct:            gainPctRaw?.toFixed(3) ?? null,
                net_pnl_pct:        netGainPct?.toFixed(3) ?? null,
                required_edge_pct:  reqEdgePct.toFixed(3),
                above_edge:         aboveEdge,
                eligible:           exitFired,
                blocker_summary:    blockerSummary,
                exits_triggered:    exits.map((e) => ({ reason: e.reason, sell_pct: e.sellPct, trim: e.trim })),
                indicators: {
                  rsi:      ind.rsi14?.toFixed(1),
                  bb_pctB:  ind.bbPctB?.toFixed(3),
                  atr_pct:  ind.atrPct?.toFixed(2),
                },
              },
              regime: regime?.regime ?? null,
              mode:   EXECUTION_MODE,
            });
          } catch (_) {}
        }

        if (!exits.length) continue;

        // Execute at most one exit per coin per cycle
        const exit    = exits[0];
        const gainPct = gainPctRaw; // already computed above for EXIT_EVALUATION log

        if (!sellsEnabled) {
          console.log(`[v2] SELL ${coin} skipped — sells_enabled=false`);
          summary.skipped.push(`SELL ${coin}: sells_enabled=false`);
          continue;
        }
        const result = await execEngine.executeSell(supabase, exit, position, ind.currentPrice, { usdKrw: usdtKrwRate, gainPct, regime: regime.regime });
        summary.sells.push({ coin, result });

        if (result.ok && !result.paper && !result.shadow) {
          for (const fill of (result.fills || [])) {
            await applyFillToPosition(supabase, position.position_id, fill);
            await riskEngine.recordFillOutcome(supabase, { asset: coin, side: 'sell', gainPct, krwAmount: result.grossKrw, cfg });
          }
          // Mark trim as fired in position metadata
          if (exit.trim && !['time_stop', 'regime_break', 'runner'].includes(exit.trim)) {
            const firedTrims = [...(position.fired_trims ?? []), exit.trim];
            try {
              await supabase.from('positions').update({ fired_trims: firedTrims, updated_at: new Date().toISOString() }).eq('position_id', position.position_id);
            } catch (_) {}
          }
          // Promote adopted → open only after a REAL live fill is confirmed.
          // Paper/shadow exits must not change position classification because
          // no exchange transaction occurred. Promoting in paper mode would
          // make the position invisible to adoption tracking and corrupt reconciliation.
          if (position.state === 'adopted') {
            await adopter.promoteAdoptedPosition(supabase, position.position_id);
            console.log(`[v2] Adopted position ${coin} promoted to open after confirmed live fill`);
          }
        }
        // Paper/shadow: do NOT promote adopted positions — no real fill occurred
      }
    }

    // ── 7. Buy cycle ──────────────────────────────────────────────────────────
    // Every coin is evaluated regardless of whether a signal exists.
    // This ensures BUY_DECISION events are written for all symbols
    // so the diagnostic export can show WHY no buy happened per symbol.
    for (const coin of coins) {
      const ind = liveIndicators[coin];
      if (!ind) continue;

      // Evaluate buy signal (returns null if conditions not met)
      const intent = signalEngine.evaluateEntry(coin, regime, ind, cfg, portfolio.navKrw);

      // Check for existing position (always check, not just when intent exists)
      const existingPos = await hasExistingPosition(supabase, coin);

      // Determine buy blocker — ordered by priority
      let buyBlocker = null;
      let riskResult = null;

      if (!buysEnabled) {
        buyBlocker = 'buys_disabled';
      } else if (!intent) {
        // Work out the specific signal reason from indicator values
        const r = regime?.regime ?? 'UNKNOWN';
        const bbThresh = cfg[`entry_bb_pct_${r.toLowerCase()}`] ?? cfg.entry_bb_pct_range ?? 0.25;
        const rsiMin   = cfg.entry_rsi_min_uptrend ?? 35;
        const rsiMax   = cfg.entry_rsi_max_uptrend ?? 45;
        if (r === 'DOWNTREND' && coin === 'SOL') {
          buyBlocker = 'signal_not_met:sol_disabled_in_downtrend';
        } else if (ind.obImbalance != null && ind.obImbalance < (cfg.ob_imbalance_min ?? -0.30)) {
          buyBlocker = `signal_not_met:ob_imbalance=${ind.obImbalance?.toFixed(2)} < ${cfg.ob_imbalance_min ?? -0.30}`;
        } else if (ind.bbPctB != null && ind.bbPctB >= bbThresh) {
          buyBlocker = `signal_not_met:bb_pctB=${ind.bbPctB?.toFixed(3)} >= threshold=${bbThresh}`;
        } else if (ind.rsi14 != null && r === 'UPTREND' && (ind.rsi14 < rsiMin || ind.rsi14 > rsiMax)) {
          buyBlocker = `signal_not_met:RSI=${ind.rsi14?.toFixed(1)} outside ${rsiMin}-${rsiMax}`;
        } else {
          buyBlocker = 'signal_not_met:conditions_not_satisfied';
        }
      } else if (existingPos) {
        buyBlocker = `existing_position:${existingPos.state}`;
      } else {
        riskResult = riskEngine.allows(intent, portfolio, cfg);
        if (!riskResult.ok) buyBlocker = riskResult.reason;
      }

      const buyEligible = !buyBlocker;

      // ── BUY_DECISION log (rate-limited to once per 10 min per symbol) ───────
      const lastBuyLog = _buyDecisionLastLogAt.get(coin) ?? 0;
      if (buyEligible || (Date.now() - lastBuyLog) >= BUY_DECISION_LOG_INTERVAL_MS) {
        _buyDecisionLastLogAt.set(coin, Date.now());
        const r = regime?.regime ?? 'UNKNOWN';
        const bbThresh = cfg[`entry_bb_pct_${r.toLowerCase()}`] ?? cfg.entry_bb_pct_range ?? 0.25;
        try {
          await supabase.from('bot_events').insert({
            event_type:   'BUY_DECISION',
            severity:     buyEligible ? 'info' : 'debug',
            subsystem:    'buy_cycle',
            message:      buyEligible
              ? `${coin} BUY ELIGIBLE — ${intent?.reason ?? ''}`
              : `${coin} buy blocked: ${buyBlocker}`,
            context_json: {
              symbol:          coin,
              engine:          'V2',
              execution_mode:  EXECUTION_MODE,
              regime:          r,
              price:           ind.currentPrice,
              existing_position: existingPos
                ? { state: existingPos.state, strategy_tag: existingPos.strategy_tag ?? null }
                : null,
              buy_checks: {
                buys_enabled:      buysEnabled,
                system_frozen:     false,
                regime_allows_buy: !(r === 'DOWNTREND' && coin === 'SOL'),
                signal_met:        intent !== null,
                intent_reason:     intent?.reason ?? null,
                RSI:               ind.rsi14     != null ? +ind.rsi14.toFixed(1)    : null,
                RSI_threshold:     r === 'UPTREND'
                  ? `${cfg.entry_rsi_min_uptrend ?? 35}-${cfg.entry_rsi_max_uptrend ?? 45}`
                  : `<${cfg.entry_rsi_max_range ?? 35}`,
                bb_pctB:           ind.bbPctB    != null ? +ind.bbPctB.toFixed(3)   : null,
                bb_threshold:      bbThresh,
                bb_ok:             ind.bbPctB    != null && ind.bbPctB < bbThresh,
                ob_imbalance:      ind.obImbalance != null ? +ind.obImbalance.toFixed(3) : null,
                ob_threshold:      cfg.ob_imbalance_min ?? -0.30,
                ob_ok:             ind.obImbalance == null || ind.obImbalance >= (cfg.ob_imbalance_min ?? -0.30),
                existing_position: !!existingPos,
                risk_cap_ok:       riskResult ? riskResult.ok : !existingPos,
                risk_blocker:      riskResult && !riskResult.ok ? riskResult.reason : null,
                size_mult:         riskResult?.sizeMult ?? null,
                budget_krw:        intent?.krwAmount ?? null,
              },
              final_buy_eligible: buyEligible,
              final_buy_blocker:  buyBlocker,
            },
            regime: r,
            mode:   EXECUTION_MODE,
          });
        } catch (_) {}
      }

      if (!buyEligible) {
        if (buyBlocker) summary.skipped.push(`BUY ${coin}: ${buyBlocker}`);
        continue;
      }

      // Apply size multiplier from risk engine (drawdown halving)
      const effectiveKrw = Math.min(
        intent.krwAmount * (riskResult.sizeMult ?? 1),
        riskResult.cappedKrw ?? intent.krwAmount,
      );

      const positionId = await getOrCreatePosition(supabase, coin, regime, intent.reason, ind.atrVal, usdtKrwRate);

      const result = await execEngine.executeBuy(supabase, { ...intent, krwAmount: effectiveKrw }, regime, { usdKrw: usdtKrwRate, atrVal: ind.atrVal, positionId });
      summary.buys.push({ coin, result });

      if (result.ok && !result.paper && !result.shadow) {
        for (const fill of (result.fills || [])) {
          await applyFillToPosition(supabase, positionId, fill);
        }
        await riskEngine.recordEntry(supabase, { asset: coin, krwAmount: effectiveKrw });
      }
    }

    // ── 8. Snapshot ───────────────────────────────────────────────────────────
    await saveV2Snapshot(supabase, portfolio, regime, cbStatus, coins, priceMap);

    console.log(`[v2] Cycle complete — sells: ${summary.sells.length}  buys: ${summary.buys.length}  skipped: ${summary.skipped.length}`);

  } catch (err) {
    summary.errors.push(err.message);
    console.error('[v2] Cycle error:', err.message);
    try {
      await supabase.from('bot_events').insert({
        event_type: 'CYCLE_ERROR', severity: 'error', subsystem: 'orchestrator',
        message: err.message, context_json: { stack: err.stack?.slice(0, 500) }, mode: summary.mode,
      });
    } catch (_) {}
  }

  return summary;
}

module.exports = { executeCycleV2, getV2Config };
