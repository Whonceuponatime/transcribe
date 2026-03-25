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

// Per-asset cooldown tracking (in-memory, resets on restart — intentional).
// Prevents buy/sell spam within a cycle window. Persisted cooldowns use risk engine.
const _lastBuyAt  = new Map(); // { 'BTC': timestamp }
const _lastSellAt = new Map(); // { 'BTC': timestamp }
const BUY_COOLDOWN_MS  = 30 * 60 * 1000; // 30 min between buys on same asset
const SELL_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between sells on same asset

// DECISION_CYCLE: one compact row per symbol per cycle.
// Written unconditionally — no rate limit — so every evaluation is auditable.
// Combines buy + sell checks into a single event for clean diagnostic exports.

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
      .in('strategy_tag', ['tactical', 'unassigned', 'core'])
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

    if (!pos) {
      console.error(`[v2] applyFillToPosition: position ${positionId} not found`);
      return;
    }

    if (fill.side === 'buy') {
      const newQty  = (pos.qty_open ?? 0) + fill.qty;
      const newCost = ((pos.avg_cost_krw ?? 0) * (pos.qty_total ?? 0) + fill.price_krw * fill.qty)
                      / (newQty || 1);
      const { error } = await supabase.from('positions').update({
        qty_open:    newQty,
        qty_total:   (pos.qty_total ?? 0) + fill.qty,
        avg_cost_krw: newCost,
        updated_at:  new Date().toISOString(),
      }).eq('position_id', positionId);
      if (error) console.error(`[v2] applyFillToPosition buy update failed for ${positionId}:`, error.message);
    } else {
      const newQty = Math.max(0, (pos.qty_open ?? 0) - fill.qty);
      const pnl    = (fill.price_krw - (pos.avg_cost_krw ?? 0)) * fill.qty - (fill.fee_krw ?? 0);
      const { error } = await supabase.from('positions').update({
        qty_open:    newQty,
        realized_pnl: ((pos.realized_pnl ?? 0) + pnl),
        state:       newQty <= 0 ? 'closed' : 'partial',
        closed_at:   newQty <= 0 ? new Date().toISOString() : null,
        updated_at:  new Date().toISOString(),
      }).eq('position_id', positionId);
      if (error) console.error(`[v2] applyFillToPosition sell update failed for ${positionId}:`, error.message);
      else console.log(`[v2] applyFillToPosition: ${fill.asset ?? positionId} qty ${pos.qty_open}→${newQty}`);
    }
  } catch (err) {
    console.error(`[v2] applyFillToPosition exception for position ${positionId}:`, err.message);
  }
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
  const cycleId = `V2-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
            message:      `V2 cycles frozen (mode=${EXECUTION_MODE}) — ${reasons[0] ?? 'unknown reason'}`,
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

    // ── CYCLE_START_HEARTBEAT — proof that executeCycleV2 is reached ─────────
    try {
      await supabase.from('bot_events').insert({
        event_type:   'CYCLE_START_HEARTBEAT',
        severity:     'debug',
        subsystem:    'orchestrator',
        message:      `V2 cycle started — cycle_id=${cycleId}`,
        context_json: { cycle_id: cycleId, engine: 'V2', execution_mode: EXECUTION_MODE, timestamp: new Date().toISOString() },
        mode:         EXECUTION_MODE,
      });
    } catch (_) {}

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
    console.log(`\n[v2] Mode=${EXECUTION_MODE}  Regime=${regime.regime}  EMA50=${regime.ema50}  EMA200=${regime.ema200}  ADX=${regime.adxVal}`);

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

    // ── Decision accumulator — one entry per coin, written at end of cycle ───
    // Captures both buy and sell checks so the diagnostic export has a single
    // authoritative DECISION_CYCLE row per symbol per cycle.
    const cycleDecisions = {};
    for (const coin of coins) {
      const ind = liveIndicators[coin];
      cycleDecisions[coin] = {
        symbol:      coin,
        timestamp:   new Date().toISOString(),
        price:       ind?.currentPrice ?? null,
        regime:      regime?.regime ?? null,
        qty_open:    null,
        avg_cost_krw: null,
        pnl_percent: null,
        protected:   false,
        buy_checks:  null,
        sell_checks: null,
        final_action: 'NO_EVALUATION',
        final_reason: 'cycle_not_reached',
      };
    }

    // ── 6. Sell cycle ─────────────────────────────────────────────────────────
    const openPositions = await getOpenPositions(supabase);
    if (!opts.dipBuyOnly) {

      // Track which protected positions we have already logged this cycle
      // to avoid emitting POSITION_SKIP_PROTECTED on every 2-min tick.
      const protectedLogged = new Set();

      for (const position of openPositions) {
        const coin = position.asset;
        const ind  = liveIndicators[coin];
        if (!ind) continue;

        // Populate base decision data for this coin
        const dec = cycleDecisions[coin] ?? {};
        dec.qty_open     = Number(position.qty_open);
        dec.avg_cost_krw = position.avg_cost_krw ?? null;
        dec.protected    = signalEngine.isFullyProtected(position);

        // ── Protected position gate ─────────────────────────────────────────
        if (dec.protected && !protectedLogged.has(position.position_id)) {
          protectedLogged.add(position.position_id);
          dec.sell_checks  = { sells_enabled: sellsEnabled, system_frozen: false, protected: true, final_sell_eligible: false, final_sell_blocker: 'protected_unassigned' };
          dec.final_action = 'NO_ACTION';
          dec.final_reason = 'sell_blocked:protected_unassigned';
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

        // ── Populate sell decision for DECISION_CYCLE event ──────────────────
        const gainPctRaw  = ind.currentPrice && position.avg_cost_krw
          ? ((ind.currentPrice - position.avg_cost_krw) / position.avg_cost_krw) * 100
          : null;
        const roundTrip  = (askFeeRate * 2) * 100;
        // reqEdgePct = minimum NET gain required above fees (matches signalEngine gate).
        // Previously was roundTrip + 0.20 which double-counted fees (gross threshold was 1.20%).
        // Now: net must exceed safety buffer only → gross >= fees + 0.10% = ~0.60%.
        const reqEdgePct = cfg.exit_safety_buffer_pct ?? 0.10;
        const netGainPct = gainPctRaw != null ? gainPctRaw - roundTrip : null;
        const aboveEdgeVal = netGainPct != null && netGainPct >= reqEdgePct;
        const exitFiredVal = exits.length > 0;
        const firedTrims   = position.fired_trims ?? [];
        const regimeBreakHit = exits.some((e) => e.trim === 'regime_break');
        const trailHit       = exits.some((e) => e.trim === 'runner');

        let sellBlocker = null;
        if (!sellsEnabled)            sellBlocker = 'sells_disabled';
        else if (!position.avg_cost_krw || Number(position.avg_cost_krw) <= 0) sellBlocker = 'no_cost_basis';
        else if (!aboveEdgeVal)       sellBlocker = `below_required_edge:net=${netGainPct?.toFixed(2)}%<${reqEdgePct.toFixed(2)}%`;
        else if (!exitFiredVal)       sellBlocker = 'above_edge_no_exit_condition_met';

        if (cycleDecisions[coin]) {
          cycleDecisions[coin].pnl_percent  = gainPctRaw != null ? +gainPctRaw.toFixed(2) : null;
          cycleDecisions[coin].sell_checks  = {
            sells_enabled:          sellsEnabled,
            system_frozen:          false,
            qty_ok:                 Number(position.qty_open) > 0,
            protected:              false,
            required_edge_pct:      +reqEdgePct.toFixed(2),
            pnl_pct:                gainPctRaw  != null ? +gainPctRaw.toFixed(2)  : null,
            net_pnl_pct:            netGainPct  != null ? +netGainPct.toFixed(2)  : null,
            above_edge:             aboveEdgeVal,
            tranche_state:          firedTrims,
            trailing_stop_hit:      trailHit,
            regime_break_hit:       regimeBreakHit,
            exits_triggered:        exits.map((e) => ({ reason: e.reason, sell_pct: e.sellPct, trim: e.trim })),
            rsi:                    ind.rsi14  != null ? +ind.rsi14.toFixed(1)  : null,
            bb_pctB:                ind.bbPctB != null ? +ind.bbPctB.toFixed(3) : null,
            final_sell_eligible:    exitFiredVal,
            final_sell_blocker:     sellBlocker,
          };
          if (exitFiredVal && !sellBlocker) {
            cycleDecisions[coin].final_action = 'SELL_TRIGGERED';
            cycleDecisions[coin].final_reason = `sell:${exits[0]?.reason}`;
          } else if (!cycleDecisions[coin].final_action || cycleDecisions[coin].final_action === 'NO_EVALUATION') {
            cycleDecisions[coin].final_action = 'NO_ACTION';
            cycleDecisions[coin].final_reason = `sell_blocked:${sellBlocker ?? 'unknown'}`;
          }
        }

        // ── EXIT_EVALUATION structured log ──────────────────────────────────
        // Always emitted for every managed non-protected position, once per 30 min.
        // This means underwater positions also appear in the audit trail with
        // blocker_summary explaining why no exit fired. Without this, the export
        // has no evidence that V2 is actually evaluating positions.
        // (variables reuse gainPctRaw/roundTrip/reqEdgePct/netGainPct computed above for DECISION_CYCLE)
        const aboveEdge  = aboveEdgeVal;
        const exitFired  = exitFiredVal;

        // Determine blocker reason for EXIT_EVALUATION log
        let blockerSummary = null;
        if (!exitFired) {
          if (position.avg_cost_krw == null || Number(position.avg_cost_krw) <= 0) {
            blockerSummary = 'no_cost_basis';
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
                mode:               EXECUTION_MODE,
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
          if (cycleDecisions[coin]) {
            cycleDecisions[coin].final_action = 'NO_ACTION';
            cycleDecisions[coin].final_reason = `sell_blocked:cooldown_sells_disabled`;
          }
          continue;
        }

        // ── Sell cooldown ────────────────────────────────────────────────────
        // regime_break is NO LONGER exempt — every protective exit is subject
        // to the cooldown. Without this, the 2-min cron fires a new regime-break
        // sell on every tick while regime stays DOWNTREND.
        // Only time_stop retains the bypass (position age doesn't change mid-cycle).
        const isProtectiveExit = ['time_stop'].includes(exit.trim);
        const lastSell = _lastSellAt.get(coin) ?? 0;
        const sellCooldownMs = cfg.sell_cooldown_ms ?? SELL_COOLDOWN_MS;
        if (!isProtectiveExit && (Date.now() - lastSell) < sellCooldownMs) {
          const waitMin = Math.ceil((sellCooldownMs - (Date.now() - lastSell)) / 60000);
          const suppMsg = `SELL_SUPPRESSED_RECENT_SELL: ${coin} — cooldown ${waitMin}min remaining (trim=${exit.trim})`;
          console.log(`[v2] ${suppMsg}`);
          summary.skipped.push(`SELL ${coin}: sell_cooldown_${waitMin}min_remaining`);
          if (cycleDecisions[coin]) {
            cycleDecisions[coin].final_action = 'NO_ACTION';
            cycleDecisions[coin].final_reason = `sell_suppressed:recent_sell:cooldown_${waitMin}min`;
          }
          try {
            await supabase.from('bot_events').insert({
              event_type:   'SELL_SUPPRESSED_RECENT_SELL',
              severity:     'info',
              subsystem:    'sell_cycle',
              message:      suppMsg,
              context_json: {
                symbol:         coin,
                reason:         'sell_cooldown',
                exit_trim:      exit.trim,
                exit_reason:    exit.reason,
                qty_before:     Number(position.qty_open),
                cooldown_ms:    sellCooldownMs,
                wait_min:       waitMin,
                engine:         'V2',
                execution_mode: EXECUTION_MODE,
                timestamp:      new Date().toISOString(),
              },
              regime: regime?.regime ?? null,
              mode:   EXECUTION_MODE,
            });
          } catch (_) {}
          continue;
        }

        // ── Unresolved sell order guard (primary duplicate-sell suppression) ──
        // Before submitting, verify no sell order for this asset is still in
        // flight. This catches stale-qty duplicates that survive process restarts
        // (in-memory cooldown would not). Fail-safe: if the DB check itself
        // throws, skip the sell rather than risk a double-submit.
        try {
          const { data: unresolvedSells } = await supabase
            .from('orders')
            .select('id, state, identifier, created_at')
            .eq('asset', coin)
            .eq('side', 'sell')
            .in('state', ['intent_created', 'submitted', 'accepted', 'partially_filled'])
            .order('created_at', { ascending: false })
            .limit(1);

          if (unresolvedSells && unresolvedSells.length > 0) {
            const unresolved = unresolvedSells[0];
            const suppMsg = `SELL_SUPPRESSED_UNRESOLVED_ORDER: ${coin} — prior sell ${unresolved.identifier} is ${unresolved.state}`;
            console.warn(`[v2] ${suppMsg}`);
            summary.skipped.push(`SELL ${coin}: suppressed_unresolved_order:${unresolved.state}`);
            if (cycleDecisions[coin]) {
              cycleDecisions[coin].final_action = 'NO_ACTION';
              cycleDecisions[coin].final_reason = `sell_suppressed:unresolved_order:${unresolved.state}`;
            }
            try {
              await supabase.from('bot_events').insert({
                event_type:   'SELL_SUPPRESSED_UNRESOLVED_ORDER',
                severity:     'warn',
                subsystem:    'sell_cycle',
                message:      suppMsg,
                context_json: {
                  symbol:           coin,
                  reason:           'unresolved_sell_order_in_flight',
                  order_id:         unresolved.id,
                  order_state:      unresolved.state,
                  order_identifier: unresolved.identifier,
                  qty_before:       Number(position.qty_open),
                  exit_trim:        exit.trim,
                  exit_reason:      exit.reason,
                  engine:           'V2',
                  execution_mode:   EXECUTION_MODE,
                  timestamp:        new Date().toISOString(),
                },
                regime: regime?.regime ?? null,
                mode:   EXECUTION_MODE,
              });
            } catch (_) {}
            continue;
          }
        } catch (unresolvedCheckErr) {
          // Cannot verify — safer to skip than to risk double-sell
          console.warn(`[v2] Unresolved-order check failed for ${coin} — skipping sell:`, unresolvedCheckErr.message);
          summary.skipped.push(`SELL ${coin}: skipped_unresolved_check_failed`);
          if (cycleDecisions[coin]) {
            cycleDecisions[coin].final_action = 'NO_ACTION';
            cycleDecisions[coin].final_reason = 'sell_suppressed:unresolved_check_db_error';
          }
          continue;
        }

        const result = await execEngine.executeSell(supabase, exit, position, ind.currentPrice, { usdKrw: usdtKrwRate, gainPct, regime: regime.regime });
        summary.sells.push({ coin, result });

        if (result.ok && !result.paper && !result.shadow) {
          _lastSellAt.set(coin, Date.now()); // start sell cooldown
          for (const fill of (result.fills || [])) {
            await applyFillToPosition(supabase, position.position_id, fill);
            await riskEngine.recordFillOutcome(supabase, { asset: coin, side: 'sell', gainPct, krwAmount: result.grossKrw, cfg });
          }

          // ── Fill fallback: direct position update when exchange returned no fills ──
          // Occurs when Upbit returned state:'wait' and the poll in executionEngine
          // timed out before the order settled. The sell DID execute — qty_open must
          // still be reduced so the next decision cycle sees correct exposure.
          if (!result.fills?.length) {
            const qtySold  = Number(position.qty_open) * (exit.sellPct / 100);
            const qtyAfter = Math.max(0, Number(position.qty_open) - qtySold);
            console.warn(`[v2] FILL_FALLBACK_DIRECT ${coin}: no fills in response — direct qty update ${Number(position.qty_open)}→${qtyAfter.toFixed(8)}`);
            try {
              await supabase.from('positions').update({
                qty_open:  qtyAfter,
                state:     qtyAfter <= 0 ? 'closed' : 'partial',
                closed_at: qtyAfter <= 0 ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
              }).eq('position_id', position.position_id);
              await supabase.from('bot_events').insert({
                event_type:   'FILL_FALLBACK_DIRECT',
                severity:     'warn',
                subsystem:    'sell_cycle',
                message:      `${coin} position qty updated via fallback — Upbit response had no fill data`,
                context_json: {
                  symbol:         coin,
                  qty_before:     Number(position.qty_open),
                  qty_sold:       +qtySold.toFixed(8),
                  qty_after:      +qtyAfter.toFixed(8),
                  sell_pct:       exit.sellPct,
                  exit_trim:      exit.trim,
                  order_id:       result.orderId,
                  engine:         'V2',
                  execution_mode: EXECUTION_MODE,
                  timestamp:      new Date().toISOString(),
                },
                regime: regime?.regime ?? null,
                mode:   EXECUTION_MODE,
              });
            } catch (fbErr) {
              console.error(`[v2] FILL_FALLBACK_DIRECT failed for ${coin}:`, fbErr.message);
            }
          }

          // ── Mark trim as fired in position metadata ──────────────────────
          // regime_break is now included so evaluateExit won't re-fire it on
          // the next cycle while regime stays DOWNTREND. Previously excluded,
          // which was the root cause of repeat regime-break sells.
          if (exit.trim && !['time_stop', 'runner'].includes(exit.trim)) {
            const firedTrims = [...new Set([...(position.fired_trims ?? []), exit.trim])];
            try {
              await supabase.from('positions').update({ fired_trims: firedTrims, updated_at: new Date().toISOString() }).eq('position_id', position.position_id);
            } catch (_) {}
          }

          // ── REGIME_BREAK_REDUCE_APPLIED structured log ───────────────────
          if (exit.trim === 'regime_break') {
            const qtyAfter = Number(position.qty_open) - (Number(position.qty_open) * exit.sellPct / 100);
            try {
              await supabase.from('bot_events').insert({
                event_type:   'REGIME_BREAK_REDUCE_APPLIED',
                severity:     'info',
                subsystem:    'sell_cycle',
                message:      `${coin} regime-break reduce applied — ${exit.sellPct}% sold, fired_trims updated`,
                context_json: {
                  symbol:         coin,
                  reason:         exit.reason,
                  sell_pct:       exit.sellPct,
                  qty_before:     Number(position.qty_open),
                  qty_after:      +qtyAfter.toFixed(8),
                  order_id:       result.orderId,
                  engine:         'V2',
                  execution_mode: EXECUTION_MODE,
                  timestamp:      new Date().toISOString(),
                },
                regime: regime?.regime ?? null,
                mode:   EXECUTION_MODE,
              });
            } catch (_) {}
          }

          // ── POSITION_REFRESH_AFTER_SELL: re-fetch to confirm DB qty ──────
          try {
            const { data: refreshedPos } = await supabase
              .from('positions')
              .select('qty_open, state')
              .eq('position_id', position.position_id)
              .single();
            const qtyAfter = refreshedPos ? Number(refreshedPos.qty_open) : null;
            console.log(`[v2] POSITION_REFRESH_AFTER_SELL: ${coin} qty_before=${Number(position.qty_open)} qty_after=${qtyAfter ?? 'unknown'} state=${refreshedPos?.state ?? 'unknown'}`);
            await supabase.from('bot_events').insert({
              event_type:   'POSITION_REFRESH_AFTER_SELL',
              severity:     'info',
              subsystem:    'sell_cycle',
              message:      `${coin} position qty refreshed after ${exit.trim} sell`,
              context_json: {
                symbol:         coin,
                qty_before:     Number(position.qty_open),
                qty_after:      qtyAfter,
                position_state: refreshedPos?.state ?? null,
                order_id:       result.orderId,
                exit_trim:      exit.trim,
                engine:         'V2',
                execution_mode: EXECUTION_MODE,
                timestamp:      new Date().toISOString(),
              },
              regime: regime?.regime ?? null,
              mode:   EXECUTION_MODE,
            });
          } catch (_) {}

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

      // Check for existing position using the same set already loaded for sell cycle.
      // This guarantees buy-block and sell-evaluation use identical position data —
      // prevents the contradiction where a core/unassigned position blocks buys but
      // is invisible to sell logic due to a strategy_tag filter mismatch.
      const existingPos = openPositions.find((p) => p.asset === coin) ?? null;

      // Determine buy blocker — ordered by priority
      let buyBlocker = null;
      let riskResult = null;
      let isAddon    = false;
      let addonIntent = intent; // may be resized for add-ons

      // Add-on config
      const addOnDipPct  = cfg.addon_min_dip_pct  ?? 1.0;  // require 1% price improvement over avg_cost
      const addOnSizeMult = cfg.addon_size_mult    ?? 0.5;  // add-on is 50% of normal signal budget

      if (!buysEnabled) {
        buyBlocker = 'buys_disabled';
      } else if (!intent) {
        // Work out the specific signal reason from indicator values
        const r = regime?.regime ?? 'UNKNOWN';
        const bbThresh = cfg[`entry_bb_pct_${r.toLowerCase()}`] ?? cfg.entry_bb_pct_range ?? 0.45;
        const rsiMin   = cfg.entry_rsi_min_uptrend ?? 42;
        const rsiMax   = cfg.entry_rsi_max_uptrend ?? 55;
        if (r === 'DOWNTREND' && coin === 'SOL') {
          buyBlocker = 'signal_not_met:sol_disabled_in_downtrend';
        } else if (ind.obImbalance != null && ind.obImbalance < (cfg.ob_imbalance_min ?? -0.45)) {
          buyBlocker = `signal_not_met:ob_imbalance=${ind.obImbalance?.toFixed(2)} < ${cfg.ob_imbalance_min ?? -0.45}`;
        } else if (ind.bbPctB != null && ind.bbPctB >= bbThresh) {
          buyBlocker = `signal_not_met:bb_pctB=${ind.bbPctB?.toFixed(3)} >= threshold=${bbThresh}`;
        } else if (ind.rsi14 != null && r === 'UPTREND' && (ind.rsi14 < rsiMin || ind.rsi14 > rsiMax)) {
          buyBlocker = `signal_not_met:RSI=${ind.rsi14?.toFixed(1)} outside ${rsiMin}-${rsiMax}`;
        } else {
          buyBlocker = 'signal_not_met:conditions_not_satisfied';
        }
      } else if (existingPos) {
        // Controlled add-on logic: allow a smaller second entry only if:
        //   1. Signal conditions are met (intent != null — already confirmed above)
        //   2. Current price is at least addon_min_dip_pct% below existing avg_cost
        //   3. Risk engine permits (includes max_entries_per_coin_24h layer cap)
        //   4. Buy cooldown has elapsed
        const avgCost = Number(existingPos.avg_cost_krw ?? 0);
        const dipOk   = avgCost > 0 && ind.currentPrice != null
          && ind.currentPrice <= avgCost * (1 - addOnDipPct / 100);

        const lastBuy = _lastBuyAt.get(coin) ?? 0;
        const buyCooldownMs = cfg.buy_cooldown_ms ?? BUY_COOLDOWN_MS;
        const cooldownOk = (Date.now() - lastBuy) >= buyCooldownMs;

        if (!dipOk) {
          buyBlocker = `existing_position_add_rule:need_${addOnDipPct}pct_below_avg=${Math.round(avgCost)}`;
        } else if (!cooldownOk) {
          const waitMin = Math.ceil((buyCooldownMs - (Date.now() - lastBuy)) / 60000);
          buyBlocker = `existing_position_add_rule:buy_cooldown_${waitMin}min_remaining`;
        } else {
          // Add-on allowed — halve the size and run through risk checks
          isAddon = true;
          addonIntent = { ...intent, krwAmount: intent.krwAmount * addOnSizeMult, reason: intent.reason + '_addon' };
          riskResult = riskEngine.allows(addonIntent, portfolio, cfg);
          if (!riskResult.ok) buyBlocker = riskResult.reason;
        }
      } else {
        // Buy cooldown for fresh entries too
        const lastBuy = _lastBuyAt.get(coin) ?? 0;
        const buyCooldownMs = cfg.buy_cooldown_ms ?? BUY_COOLDOWN_MS;
        if ((Date.now() - lastBuy) < buyCooldownMs) {
          const waitMin = Math.ceil((buyCooldownMs - (Date.now() - lastBuy)) / 60000);
          buyBlocker = `buy_cooldown_${waitMin}min_remaining`;
        } else {
          riskResult = riskEngine.allows(intent, portfolio, cfg);
          if (!riskResult.ok) buyBlocker = riskResult.reason;
        }
      }

      const buyEligible = !buyBlocker;

      // ── Populate buy decision for DECISION_CYCLE event ─────────────────────
      const r        = regime?.regime ?? 'UNKNOWN';
      const bbThresh = cfg[`entry_bb_pct_${r.toLowerCase()}`] ?? cfg.entry_bb_pct_range ?? 0.45;
      const rsiThreshold = r === 'UPTREND'
        ? `${cfg.entry_rsi_min_uptrend ?? 42}-${cfg.entry_rsi_max_uptrend ?? 55}`
        : `<${r === 'RANGE' ? (cfg.entry_rsi_max_range ?? 45) : (cfg.entry_rsi_max_downtrend ?? 28)}`;

      if (cycleDecisions[coin]) {
        cycleDecisions[coin].buy_checks = {
          buys_enabled:      buysEnabled,
          system_frozen:     false,
          risk_cap_ok:       riskResult ? riskResult.ok : !existingPos,
          cash_ok:           portfolio.krwBalance > (portfolio.navKrw * (cfg.krw_min_reserve_pct ?? 12) / 100),
          dca_timer_ok:      null, // V2 uses signal-based entries, not DCA timer
          dip_score:         null, // V2 uses 4-factor signal (BB%B + RSI + OB)
          dip_score_threshold: null,
          is_addon:          isAddon,
          addon_dip_required: addOnDipPct,
          rsi:               ind.rsi14  != null ? +ind.rsi14.toFixed(1)  : null,
          rsi_threshold:     rsiThreshold,
          bb_pctB:           ind.bbPctB != null ? +ind.bbPctB.toFixed(3) : null,
          bb_threshold:      bbThresh,
          bb_ok:             ind.bbPctB != null && ind.bbPctB < bbThresh,
          ob_imbalance:      ind.obImbalance != null ? +ind.obImbalance.toFixed(3) : null,
          ob_threshold:      cfg.ob_imbalance_min ?? -0.45,
          regime_allows_buy: !(r === 'DOWNTREND' && coin === 'SOL'),
          existing_position: !!existingPos,
          signal_met:        intent !== null,
          intent_reason:     intent?.reason ?? null,
          risk_blocker:      riskResult && !riskResult.ok ? riskResult.reason : null,
          size_mult:         riskResult?.sizeMult ?? null,
          budget_krw:        intent?.krwAmount ?? null,
          final_buy_eligible: buyEligible,
        };

        // Update final_action and final_reason
        if (buyEligible) {
          cycleDecisions[coin].final_action = isAddon ? 'ADD_ON_ELIGIBLE' : 'BUY_ELIGIBLE';
          cycleDecisions[coin].final_reason = isAddon
            ? `add_on_allowed:${addonIntent?.reason ?? 'signal_met'}`
            : `buy:${intent?.reason ?? 'signal_met'}`;
        } else {
          const prevAction = cycleDecisions[coin].final_action;
          if (!prevAction || prevAction === 'NO_EVALUATION') {
            cycleDecisions[coin].final_action = 'NO_ACTION';
            cycleDecisions[coin].final_reason = `buy_blocked:${buyBlocker}`;
          } else if (prevAction === 'NO_ACTION') {
            // Append buy blocker to existing sell blocker
            cycleDecisions[coin].final_reason += ` | buy_blocked:${buyBlocker}`;
          }
        }
      }

      if (!buyEligible) {
        if (buyBlocker) summary.skipped.push(`BUY ${coin}: ${buyBlocker}`);
        continue;
      }

      // Apply size multiplier from risk engine (drawdown halving).
      // For add-ons, addonIntent already has the reduced krwAmount.
      const activeIntent = isAddon ? addonIntent : intent;
      const effectiveKrw = Math.min(
        activeIntent.krwAmount * (riskResult.sizeMult ?? 1),
        riskResult.cappedKrw ?? activeIntent.krwAmount,
      );

      // For add-ons use the existing position; for fresh entries get/create one.
      const positionId = isAddon && existingPos
        ? existingPos.position_id
        : await getOrCreatePosition(supabase, coin, regime, activeIntent.reason, ind.atrVal, usdtKrwRate);

      const result = await execEngine.executeBuy(supabase, { ...activeIntent, krwAmount: effectiveKrw }, regime, { usdKrw: usdtKrwRate, atrVal: ind.atrVal, positionId });
      summary.buys.push({ coin, result });

      if (result.ok) {
        _lastBuyAt.set(coin, Date.now()); // start buy cooldown
        if (cycleDecisions[coin]) {
          cycleDecisions[coin].final_action = isAddon ? 'ADD_ON_SUBMITTED' : 'BUY_SUBMITTED';
          cycleDecisions[coin].final_reason = `${isAddon ? 'add_on' : 'buy'}_order:${result.state}`;
        }
        for (const fill of (result.fills || [])) {
          await applyFillToPosition(supabase, positionId, fill);
        }
        await riskEngine.recordEntry(supabase, { asset: coin, krwAmount: effectiveKrw });
      }
    }

    // ── 8. Write DECISION_CYCLE events — one per symbol, every cycle ──────────
    // Unconditional — no rate limit. Every evaluation is auditable.
    // DECISION_EMIT_ATTEMPT written before loop as proof the write path is reached.
    try {
      await supabase.from('bot_events').insert({
        event_type:   'DECISION_EMIT_ATTEMPT',
        severity:     'debug',
        subsystem:    'decision_audit',
        message:      `V2 DECISION_CYCLE write path reached — cycle_id=${cycleId} symbols=${coins.join(',')}`,
        context_json: { cycle_id: cycleId, engine: 'V2', execution_mode: EXECUTION_MODE, timestamp: new Date().toISOString(), symbols: coins },
        mode:         EXECUTION_MODE,
      });
    } catch (_) {}

    for (const coin of coins) {
      const dec = cycleDecisions[coin];
      if (!dec) continue;
      // Fill in sell_checks for coins without positions
      if (!dec.sell_checks) {
        dec.sell_checks = {
          sells_enabled: sellsEnabled, system_frozen: false,
          qty_ok: false, protected: false,
          required_edge_pct: null, pnl_pct: null, net_pnl_pct: null,
          above_edge: false, tranche_state: [], trailing_stop_hit: false,
          regime_break_hit: false, exits_triggered: [],
          rsi: dec.buy_checks?.rsi ?? null, bb_pctB: dec.buy_checks?.bb_pctB ?? null,
          final_sell_eligible: false, final_sell_blocker: 'no_position',
        };
        if (!dec.buy_checks) {
          dec.final_action = 'NO_ACTION';
          dec.final_reason = 'no_position_and_buy_not_evaluated';
        }
      }
      // Determine cooldown_remaining from fired_trims (approximate — actual cooldown
      // is enforced by isRecentlySold in the execution layer, not tracked in-cycle)
      const pos = openPositions.find((p) => p.asset === coin);
      dec.cooldown_remaining = pos?.fired_trims?.length
        ? `${pos.fired_trims.join(',')} fired — cooldown active`
        : null;
      try {
        await supabase.from('bot_events').insert({
          event_type:   'DECISION_CYCLE',
          severity:     (dec.final_action === 'BUY_SUBMITTED' || dec.final_action === 'SELL_TRIGGERED') ? 'info' : 'debug',
          subsystem:    'decision_audit',
          message:      `${coin} → ${dec.final_action}: ${dec.final_reason}`,
          context_json: {
            symbol:         dec.symbol,
            timestamp:      dec.timestamp,
            price:          dec.price,
            regime:         dec.regime,
            qty_open:       dec.qty_open,
            avg_cost_krw:   dec.avg_cost_krw,
            pnl_percent:    dec.pnl_percent,
            protected:      dec.protected,
            cooldown_remaining: dec.cooldown_remaining,
            buy_checks:     dec.buy_checks,
            sell_checks:    dec.sell_checks,
            final_action:   dec.final_action,
            final_reason:   dec.final_reason,
            engine:         'V2',
            execution_mode: EXECUTION_MODE,
            cycle_id:       cycleId,
          },
          regime: dec.regime,
          mode:   EXECUTION_MODE,
        });
        // Hard-proof that this specific coin's DECISION_CYCLE row was committed.
        try {
          await supabase.from('bot_events').insert({
            event_type:   'DECISION_EMIT_SUCCESS',
            severity:     'debug',
            subsystem:    'decision_audit',
            message:      `DECISION_CYCLE committed for ${coin} — cycle_id=${cycleId}`,
            context_json: { cycle_id: cycleId, symbol: coin, engine: 'V2', execution_mode: EXECUTION_MODE, timestamp: new Date().toISOString() },
            mode:         EXECUTION_MODE,
          });
        } catch (_) {}
      } catch (err) {
        console.warn(`[v2] DECISION_CYCLE write failed for ${coin}: ${err.message}`);
      }
    }

    // ── 9. Snapshot ───────────────────────────────────────────────────────────
    await saveV2Snapshot(supabase, portfolio, regime, cbStatus, coins, priceMap);
    try {
      await supabase.from('bot_events').insert({
        event_type:   'SNAPSHOT_EMIT_SUCCESS',
        severity:     'debug',
        subsystem:    'orchestrator',
        message:      `portfolio_snapshots_v2 row written — cycle_id=${cycleId}`,
        context_json: { cycle_id: cycleId, engine: 'V2', execution_mode: EXECUTION_MODE, timestamp: new Date().toISOString(), nav_krw: portfolio.navKrw },
        mode:         EXECUTION_MODE,
      });
    } catch (_) {}

    console.log(`[v2] Cycle complete — sells: ${summary.sells.length}  buys: ${summary.buys.length}  skipped: ${summary.skipped.length}`);

    // ── CYCLE_END_HEARTBEAT — proof the full cycle executed without throwing ──
    try {
      await supabase.from('bot_events').insert({
        event_type:   'CYCLE_END_HEARTBEAT',
        severity:     'debug',
        subsystem:    'orchestrator',
        message:      `V2 cycle complete — cycle_id=${cycleId} sells=${summary.sells.length} buys=${summary.buys.length}`,
        context_json: { cycle_id: cycleId, engine: 'V2', execution_mode: EXECUTION_MODE, timestamp: new Date().toISOString(), sells: summary.sells.length, buys: summary.buys.length, skipped: summary.skipped.length },
        mode:         EXECUTION_MODE,
      });
    } catch (_) {}

  } catch (err) {
    summary.errors.push(err.message);
    console.error('[v2] Cycle error:', err.message);
    try {
      await supabase.from('bot_events').insert({
        event_type: 'CYCLE_ERROR', severity: 'error', subsystem: 'orchestrator',
        message: err.message, context_json: { stack: err.stack?.slice(0, 500) }, mode: EXECUTION_MODE,
      });
    } catch (_) {}
  }

  return summary;
}

module.exports = { executeCycleV2, getV2Config };
