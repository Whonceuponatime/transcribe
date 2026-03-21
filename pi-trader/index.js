/**
 * Pi Trader v4 — signal-driven, comprehensive logging
 *
 * Schedule:
 *   Every 2 min  : sell checks (profit-take, RSI, BB, MACD, trailing stop)
 *   Every 5 min  : dip-buy check
 *   Every day    : DCA check at 01:00 UTC
 *   Every 10s    : manual trigger + kill switch + deploy poll
 *   Every 5 min  : heartbeat + portfolio snapshot
 *   Every hour   : hourly performance digest log
 *
 * Logging tags (all written to crypto_bot_logs):
 *   trade        — every trade executed, with full indicator context
 *   snapshot     — full indicator + portfolio state every ~30 min
 *   sell_diag    — per-coin sell block analysis every ~14 min
 *   hourly       — hourly P&L summary + trade count + near-misses
 *   active       — brief "bot is running" heartbeat every ~10 min
 *   error        — cycle errors
 *   deploy       — git pull events
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const trader      = require('../lib/cryptoTrader');
const traderV2    = require('../lib/cryptoTraderV2');
const riskEngine  = require('../lib/riskEngine');
const regimeEngine= require('../lib/regimeEngine');
const adopter     = require('../lib/portfolioAdopter');
const reconEngine = require('../lib/reconciliationEngine');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPBIT_ACCESS_KEY', 'UPBIT_SECRET_KEY'];
for (const key of required) {
  if (!process.env[key]) { console.error(`[pi-trader] Missing: ${key}`); process.exit(1); }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
let running         = false;
let runningV2       = false;
let adoptionDone    = false; // set to true once first-deployment adoption completes

// Per-coin order lock for v2 (prevents concurrent orders on same asset)
const coinLocks = {};

// Cycle counters
let sellCheckCount  = 0;
let snapshotCount   = 0;

// Hourly digest accumulator
let hourlyTrades    = [];
let hourlyStartKrw  = null;

/** Write one structured log row. Prunes entries older than 30 days for info+, 7 days for debug. */
async function writeLog(level, tag, message, meta = null) {
  try {
    await supabase.from('crypto_bot_logs').insert({ level, tag, message, meta });
    // Prune: keep debug logs 7 days, others 30 days
    const debugCutoff = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
    const infoCutoff  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('crypto_bot_logs').delete().eq('level', 'debug').lt('created_at', debugCutoff);
    await supabase.from('crypto_bot_logs').delete().neq('level', 'debug').lt('created_at', infoCutoff);
  } catch (_) {}
}

async function isKilled() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'kill_switch').single();
    return data?.value?.enabled === true;
  } catch (_) { return false; }
}

/** Format a trade line for a human-readable log message. */
function tradeLine(t) {
  const isBuy = t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA');
  const side  = isBuy ? 'BUY' : 'SELL';
  if (isBuy) {
    return `${side} ${t.coin} ₩${Math.round(t.krwAmount || 0).toLocaleString()} — ${t.reason}`;
  }
  const krwVal = t.grossKrw ?? (t.soldAmount && t.priceKrw ? Math.round(t.soldAmount * t.priceKrw) : null);
  const amt = krwVal
    ? `${(+t.soldAmount).toFixed(6)} ${t.coin} (≈₩${krwVal.toLocaleString()})`
    : `${t.soldAmount} ${t.coin}`;
  return `${side} ${t.coin} ${amt} — ${t.reason}`;
}

/**
 * Returns true when V1 should be suppressed.
 * V1 is disabled when V2 is in live mode to prevent double-trading:
 *   - Both engines target the same Upbit account
 *   - V1 fills are not tracked in V2's positions table
 *   - V1 live trades would cause V2 reconciliation balance mismatches
 *   - Concurrent V1+V2 live orders on the same coin would be uncoordinated
 */
async function isV1Suppressed() {
  try {
    const cfg = await traderV2.getV2Config(supabase);
    return (cfg.mode ?? 'paper') === 'live';
  } catch (_) {
    return false; // if we can't read config, let V1 run (fail open for V1)
  }
}

async function runCycle(opts = {}, label = 'auto') {
  if (await isKilled()) { console.log(`[${label}] Kill switch ON — skipped`); return; }
  if (running) { console.log(`[${label}] Busy — skipped`); return; }

  // Suppress V1 when V2 is live to prevent concurrent trading on the same account.
  if (await isV1Suppressed()) {
    if (label === 'startup') {
      console.log(`[v1][${label}] V2 is in live mode — V1 suppressed to prevent double-trading`);
    }
    return;
  }

  running = true;
  snapshotCount++;
  const startedAt = new Date().toISOString();
  console.log(`\n[${label}] ── Start at ${startedAt}`);

  try {
    const result = await trader.executeCycle(supabase, opts);

    const allTrades = [
      ...(result.sells    || []).filter((t) => t.ok),
      ...(result.dca      || []).filter((t) => t.ok),
      ...(result.dipBuys  || []).filter((t) => t.ok),
    ];
    const completedAt = new Date().toISOString();

    // ── Accumulate trades for hourly digest ─────────────────────────────────
    hourlyTrades.push(...allTrades.map((t) => ({ ...t, cycleLabel: label, ts: completedAt })));

    // ── Log every trade with full indicator context ──────────────────────────
    for (const t of allTrades) {
      const isBuy = t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA');
      const indicators = result.cycleIndicators?.[t.coin] ?? null;
      await writeLog('info', 'trade', tradeLine(t), {
        side:       isBuy ? 'buy' : 'sell',
        coin:       t.coin,
        reason:     t.reason,
        krwAmount:  t.krwAmount   ?? null,
        soldAmount: t.soldAmount  ?? null,
        grossKrw:   t.grossKrw    ?? null,
        gainPct:    t.gainPct     ?? null,
        priceKrw:   t.priceKrw    ?? null,
        cycleLabel: label,
        indicators,
      });
    }

    // ── Log no-trade cycles ──────────────────────────────────────────────────
    if (allTrades.length === 0) {
      if (label === 'sell_check') sellCheckCount++;
      const skipMsg = result.skipped?.join(' | ') || 'no triggers fired';

      if (label !== 'sell_check') {
        await writeLog('info', label, `No trades — ${skipMsg}`);
      } else if (sellCheckCount % 5 === 0) {
        // Brief "Active" log every ~10 min with sell-block summary
        const diagSummary = (result.sellDiag || []).map((d) => {
          if (d.atProfit) return `${d.coin} ✓ profitable`;
          const needs = d.needsPctForProfit ? `+${d.needsPctForProfit}% to sell` : 'blocked';
          return `${d.coin} ${d.gainPct ?? '?'}% (needs ${needs})`;
        }).join(' | ');
        await writeLog('info', 'active', `Sell check — ${diagSummary || skipMsg}`);
      }
    } else {
      const lines = allTrades.map(tradeLine).join(' · ');
      console.log(`[${label}] ${lines}`);
      if (result.errors?.length) console.error(`[${label}] Errors:`, result.errors);
    }

    // ── Sell diagnostics every ~14 min (every 7 sell_check cycles) ──────────
    if (label === 'sell_check') sellCheckCount++;
    const isDiagCycle = label !== 'sell_check' || sellCheckCount % 7 === 0;
    if (isDiagCycle && (result.sellDiag || []).length > 0) {
      const diagLines = result.sellDiag.map((d) => {
        const base  = `${d.coin}: gain=${d.gainPct ?? '?'}% net=${d.netGainPct ?? '?'}%`;
        const block = d.blockedBy ? ` | BLOCKED: ${d.blockedBy}` : (d.signalsMet.length ? ` | SIGNALS: ${d.signalsMet.join(',')}` : ' | no signals');
        const ind   = ` | RSI=${d.indicators?.rsi} StochRSI=${d.indicators?.stochRsi} VWAP=${d.indicators?.vwapDev}% WR=${d.indicators?.williamsR} CCI=${d.indicators?.cci}`;
        return base + block + ind;
      });
      await writeLog('debug', 'sell_diag', diagLines.join('  ·  '), {
        sellDiag: result.sellDiag,
        skipped:  result.skipped,
        cycleLabel: label,
      });
    }

    // ── Full snapshot every ~30 min (every 15 cycles across all types) ──────
    // Snapshot captures everything needed for post-mortem analysis:
    // indicators, portfolio, sell decisions, dip signal evaluations, skipped reasons
    if (snapshotCount % 15 === 0) {
      const { data: snapRow } = await Promise.resolve(
        supabase.from('app_settings').select('value')
          .eq('key', 'last_cycle_detail').single()
      ).catch(() => ({ data: null }));
      const cycleDetail = snapRow?.value ?? null;
      if (cycleDetail) {
        const snapMsg = [
          `F&G=${cycleDetail.fearGreed?.value ?? '?'}`,
          `KRW=${cycleDetail.portfolio?.krwBalance != null ? Math.round(cycleDetail.portfolio.krwBalance / 1000) + 'K' : '?'}`,
          ...(cycleDetail.portfolio?.positions ?? []).map((p) =>
            `${p.coin}=${p.gainPct != null ? (p.gainPct >= 0 ? '+' : '') + p.gainPct.toFixed(1) + '%' : '?'} RSI=${cycleDetail.indicators?.[p.coin]?.rsi?.toFixed(1) ?? '?'}`
          ),
          `sells=${allTrades.filter((t) => !t.reason?.startsWith('DIP') && !t.reason?.startsWith('DCA')).length}`,
          `buys=${allTrades.filter((t) => t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA')).length}`,
        ].join(' | ');

        await writeLog('debug', 'snapshot', snapMsg, cycleDetail);
      }
    }

    // ── Persist last_cycle_result for status display ─────────────────────────
    try {
      await supabase.from('app_settings').upsert({
        key: 'last_cycle_result',
        value: { result, label, startedAt, completedAt, ok: true },
        updated_at: completedAt,
      }, { onConflict: 'key' });
    } catch (_) {}

    if (result.errors?.length) {
      await writeLog('warn', label, `Cycle errors: ${result.errors.join('; ')}`);
    }

  } catch (err) {
    console.error(`[pi-trader] Cycle error: ${err.message}`);
    await writeLog('error', label, `Cycle error: ${err.message}`, { stack: err.stack?.slice(0, 500) });
    try {
      await supabase.from('app_settings').upsert({
        key: 'last_cycle_result',
        value: { error: err.message, label, startedAt, ok: false },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    } catch (_) {}
  } finally {
    running = false;
  }
}

/**
 * Hourly digest — fires every hour.
 * Aggregates trades, P&L change, and near-miss signals from the last hour.
 */
async function hourlyDigest() {
  try {
    const trades = hourlyTrades.splice(0); // drain accumulator

    // Current portfolio snapshot for P&L reference
    const { data: snapRow } = await Promise.resolve(
      supabase.from('app_settings').select('value')
        .eq('key', 'crypto_portfolio_snapshot').single()
    ).catch(() => ({ data: null }));
    const snap = snapRow?.value ?? null;

    const totalKrw   = snap?.totalValueKrw ?? null;
    const krwBalance = snap?.krwBalance    ?? null;

    // P&L delta since last hour
    let pnlDelta = null;
    if (hourlyStartKrw != null && totalKrw != null) {
      pnlDelta = totalKrw - hourlyStartKrw;
    }
    hourlyStartKrw = totalKrw;

    const buys  = trades.filter((t) => t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA'));
    const sells = trades.filter((t) => !t.reason?.startsWith('DIP') && !t.reason?.startsWith('DCA'));

    // Fetch recent sell_diag for near-miss info
    const since1h = new Date(Date.now() - 3600000).toISOString();
    const { data: diagLogs } = await supabase.from('crypto_bot_logs')
      .select('meta').eq('tag', 'sell_diag').gte('created_at', since1h)
      .order('created_at', { ascending: false }).limit(3)
      .catch(() => ({ data: [] }));

    const nearMisses = [];
    for (const log of (diagLogs || [])) {
      for (const d of (log.meta?.sellDiag || [])) {
        if (!d.atProfit && d.gainPct != null) {
          nearMisses.push(`${d.coin} needs +${d.needsPctForProfit ?? '?'}% more (currently ${d.gainPct}%)`);
        }
      }
    }

    const msgParts = [
      `Trades: ${trades.length} (${buys.length} buys, ${sells.length} sells)`,
      pnlDelta != null ? `P&L delta: ${pnlDelta >= 0 ? '+' : ''}₩${Math.round(pnlDelta).toLocaleString()}` : null,
      totalKrw  != null ? `Portfolio: ₩${Math.round(totalKrw).toLocaleString()}` : null,
      krwBalance != null ? `KRW: ₩${Math.round(krwBalance).toLocaleString()}` : null,
      nearMisses.length ? `Near sells: ${[...new Set(nearMisses)].slice(0, 3).join(' | ')}` : null,
    ].filter(Boolean).join(' | ');

    await writeLog('info', 'hourly', msgParts, {
      tradesThisHour: trades.length,
      buys:  buys.length,
      sells: sells.length,
      pnlDelta,
      totalKrw,
      krwBalance,
      tradeDetails: trades.map((t) => ({
        coin: t.coin, side: (t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA')) ? 'buy' : 'sell',
        reason: t.reason, krwAmount: t.krwAmount, grossKrw: t.grossKrw, gainPct: t.gainPct,
      })),
      nearMisses: [...new Set(nearMisses)],
    });

    console.log(`[hourly] ${msgParts}`);
  } catch (err) {
    console.error('[hourly] Digest error:', err.message);
  }
}

async function heartbeat() {
  try {
    await supabase.from('app_settings').upsert({
      key: 'pi_heartbeat',
      value: { lastSeen: new Date().toISOString(), version: '4.0' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}

  try {
    const upbit  = require('../lib/upbit');
    const config = await trader.getConfig(supabase);
    const coins  = config.coins || ['BTC', 'ETH', 'SOL'];

    const [accounts, tickers] = await Promise.all([
      upbit.getAccounts().catch(() => []),
      upbit.getTicker(coins.map((c) => `KRW-${c}`)).catch(() => []),
    ]);

    const priceMap = {};
    for (const t of tickers) priceMap[t.market.split('-')[1]] = t.trade_price;

    const { data: fxRow } = await supabase.from('app_settings').select('value').eq('key', 'usd_krw_rate').single();
    const usdKrw = fxRow?.value?.rate ?? null;

    await trader.savePortfolioSnapshot(supabase, { accounts, priceMap, usdKrw, coins, config });
  } catch (_) {}
}

async function pollDeploy() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'crypto_deploy_trigger').single();
    if (data?.value?.pending) {
      await supabase.from('app_settings').upsert({
        key: 'crypto_deploy_trigger',
        value: { pending: false, startedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      await writeLog('info', 'deploy', 'git pull triggered — pulling latest code…');
      console.log('[deploy] Running git pull…');

      const { execSync } = require('child_process');
      const root = require('path').resolve(__dirname, '..');

      execSync('git pull', { cwd: root, stdio: 'inherit' });

      // Install any new npm packages added since the last deploy.
      // This ensures executionEngine (uuid), etc. are always available.
      console.log('[deploy] Running npm install…');
      execSync('npm install --omit=dev', { cwd: root, stdio: 'inherit' });

      await writeLog('info', 'deploy', 'git pull + npm install complete — exiting so PM2 restarts with new code');
      console.log('[deploy] Done — exiting for PM2 restart');
      setTimeout(() => process.exit(0), 500);
    }
  } catch (err) {
    await writeLog('error', 'deploy', `Deploy failed: ${err.message}`);
    console.error('[deploy] Error:', err.message);
  }
}

async function pollReconcileTrigger() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'reconcile_trigger').single();
    if (data?.value?.pending) {
      await supabase.from('app_settings').upsert({
        key: 'reconcile_trigger', value: { pending: false, clearedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      console.log('[reconcile] Manual trigger received — running reconciliation');
      await reconcile('manual');
    }
  } catch (_) {}
}

async function pollTrigger() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'crypto_manual_trigger').single();
    if (data?.value?.pending) {
      await supabase.from('app_settings').upsert({
        key: 'crypto_manual_trigger',
        value: { pending: false, clearedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
      const forceDca = data.value.forceDca === true;
      await runCycle({ forceDca }, 'manual_trigger');
    }
  } catch (_) {}
}

// ─── V2 cycle runner ─────────────────────────────────────────────────────────

/**
 * Run one v2 cycle. Uses a separate lock from the v1 runner.
 * Per-coin order locks prevent concurrent orders on the same asset.
 */
async function runCycleV2(opts = {}, label = 'v2_auto') {
  if (await isKilled()) return;
  if (runningV2) { console.log(`[v2][${label}] Busy — skipped`); return; }

  // Block all v2 cycles until adoption is complete AND reconciliation has passed.
  // adoptionDone is set by startupSequence(); reconEngine.isSystemFrozen() is the gate.
  if (!adoptionDone) {
    console.log(`[v2][${label}] Startup sequence not yet complete — skipped`);
    return;
  }
  // The freeze check in executeCycleV2 itself will skip the cycle if frozen.
  // This in-process check is a fast path to avoid even loading config.

  runningV2 = true;
  try {
    const result = await traderV2.executeCycleV2(supabase, opts);

    // Log mode prominently on first run
    if (!runCycleV2._modeLogged) {
      const mode = result.mode ?? 'paper';
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  V2 ENGINE MODE: ${mode.toUpperCase()}`);
      if (mode === 'paper')  console.log('  Paper mode — decisions logged, NO orders sent to exchange');
      if (mode === 'shadow') console.log('  Shadow mode — decisions logged with [SHADOW] label');
      if (mode === 'live')   console.log('  LIVE mode — real orders are being sent to Upbit');
      console.log(`${'═'.repeat(60)}\n`);
      runCycleV2._modeLogged = true;
    }

    // Write a brief info log for dashboard visibility
    const sells = result.sells?.filter((s) => s.result?.ok).length ?? 0;
    const buys  = result.buys?.filter((b)  => b.result?.ok).length ?? 0;
    if (sells > 0 || buys > 0) {
      await writeLog('info', `v2_${label}`, `[v2] Regime=${result.regime} sells=${sells} buys=${buys}`, { sells: result.sells, buys: result.buys, mode: result.mode });
    }

  } catch (err) {
    console.error(`[v2] Cycle error: ${err.message}`);
    await writeLog('error', `v2_${label}`, `[v2] Cycle error: ${err.message}`);
  } finally {
    runningV2 = false;
  }
}
runCycleV2._modeLogged = false;

/**
 * Startup reconciliation — verify exchange state matches DB on boot and every 4h.
 * Currently logs mismatches to bot_events for operator review.
 */
async function reconcile(trigger = 'scheduled') {
  try {
    const cfg   = await traderV2.getV2Config(supabase).catch(() => ({}));
    const coins = cfg.coins ?? ['BTC', 'ETH', 'SOL'];
    const result = await reconEngine.runReconciliation(supabase, coins, trigger);
    if (!result.passed) {
      await writeLog('warn', 'reconcile',
        `Reconciliation (${trigger}) FROZEN: ${result.freezeReasons.join(' | ')}`,
        { freezeReasons: result.freezeReasons }
      );
    }
  } catch (err) {
    console.error('[reconcile] Error:', err.message);
  }
}

// ─── Formal startup sequence ──────────────────────────────────────────────────
//
// Step 1: Portfolio adoption — import pre-existing holdings
// Step 2: Reconciliation    — verify exchange state vs DB state
// Step 3: Unfreeze          — enable cycles only if reconciliation passes
//
// The system starts FROZEN and only unfreezes after a clean reconciliation.
// If reconciliation finds discrepancies, the freeze persists and trading is blocked
// until the operator resolves the issue and triggers a manual clear.

/**
 * Full startup sequence: adoption → reconciliation → unfreeze.
 * Returns after all steps complete (or fail gracefully).
 */
async function startupSequence() {
  const cfg   = await traderV2.getV2Config(supabase).catch(() => ({}));
  const coins = cfg.coins ?? ['BTC', 'ETH', 'SOL'];
  const mode  = cfg.mode  ?? 'paper';

  console.log(`\n${'═'.repeat(64)}`);
  console.log('  STARTUP SEQUENCE');
  console.log(`  Mode: ${mode.toUpperCase()}   Coins: ${coins.join(', ')}`);
  console.log(`${'═'.repeat(64)}`);

  // ── Step 1: Load persisted freeze state from DB ──────────────────────────
  // Restoring from DB ensures a process restart does not silently clear a freeze
  // that was set in a previous run due to a balance mismatch.
  await reconEngine.loadFreezeState(supabase);
  console.log(`[startup] Freeze state loaded — currently ${reconEngine.isSystemFrozen() ? 'FROZEN' : 'clear'}`);

  // ── Step 2: Portfolio adoption ───────────────────────────────────────────
  let adoptionResult = { alreadyDone: false, adopted: [], unsupported: [], skipped: [], error: null };
  try {
    adoptionResult = await adopter.runAdoption(supabase, coins, mode);

    if (adoptionResult.alreadyDone) {
      console.log('[startup] Adoption: previously completed — skipping re-import');
      await writeLog('info', 'adoption', 'Adoption previously completed — skipping re-import', {
        adoption_completed: true, skipped_reason: 'already_done',
      });
    } else if (adoptionResult.error) {
      await writeLog('error', 'adoption', `Adoption failed: ${adoptionResult.error}`, {
        adoption_completed: false, error: adoptionResult.error,
      });
      console.error('[startup] Adoption failed:', adoptionResult.error);
    } else {
      // Count protected (unassigned) vs classified-adopted
      const protectedCount = (adoptionResult.adopted || []).filter((a) => a.strategy_tag === 'unassigned').length;
      const classifiedCount = (adoptionResult.adopted || []).filter((a) => a.strategy_tag !== 'unassigned').length;
      const adoptedStr     = adoptionResult.adopted.map((a) => `${a.currency}(${a.qty?.toFixed?.(4) ?? a.qty})`).join(' ') || '—';
      const unsupStr       = adoptionResult.unsupported.map((u) => u.currency).join(', ') || 'none';
      const invalidCount   = (adoptionResult.skipped || []).filter((s) => s.reason === 'symbol_normalization_failed').length;

      await writeLog('info', 'adoption',
        `Adoption complete — ${adoptionResult.adopted.length} supported adopted, ${adoptionResult.unsupported.length} excluded, ${protectedCount} need classification`,
        {
          adoption_completed:   true,
          mode,
          supported_managed:    adoptionResult.adopted.length,
          protected_unassigned: protectedCount,
          classified_adopted:   classifiedCount,
          excluded_unsupported: adoptionResult.unsupported.length,
          invalid_symbols:      invalidCount,
          krw_cash:             adoptionResult.krwBalance ?? null,
          adopted_assets:       adoptionResult.adopted.map((a) => ({
            currency: a.currency, qty: a.qty, avg_cost_krw: a.avg_cost_krw,
            strategy_tag: a.strategy_tag ?? 'unassigned',
          })),
          excluded_assets: adoptionResult.unsupported.map((u) => ({ currency: u.currency, approx_value_krw: u.approx_value_krw })),
        }
      );
      if (adoptionResult.unsupported.length > 0) {
        await writeLog('warn', 'adoption',
          `Excluded holdings (not managed by bot): ${unsupStr}`,
          { unsupported: adoptionResult.unsupported }
        );
      }
      console.log(`[startup] Adoption complete — adopted: ${adoptedStr} | excluded: ${unsupStr}`);
    }
  } catch (err) {
    console.error('[startup] Adoption unexpected error:', err.message);
    await writeLog('error', 'adoption', `Adoption unexpected error: ${err.message}`);
  }

  adoptionDone = true; // adoption step completed (even if errored)

  // ── Step 3: Startup reconciliation ──────────────────────────────────────
  console.log('[startup] Running startup reconciliation…');
  let reconResult = { passed: false, frozen: true, freezeReasons: ['reconciliation_not_run'] };
  try {
    reconResult = await reconEngine.runReconciliation(supabase, coins, 'startup');
  } catch (err) {
    console.error('[startup] Reconciliation error:', err.message);
    await reconEngine.setFreeze(supabase, [`reconciliation_error: ${err.message}`]);
    await writeLog('error', 'reconcile', `Reconciliation failed: ${err.message}`);
  }

  // Build concise per-check summary for crypto_bot_logs
  const cr = reconResult.checkResults ?? {};
  const checkSummary = [
    `adoption=${cr.adoption_complete?.passed     ? 'PASS' : 'FAIL'}`,
    `orders=${cr.no_unresolved_orders?.passed    ? 'PASS' : 'FAIL'}`,
    `balance=${cr.balance_match?.passed          ? 'PASS' : 'FAIL'}`,
    `ownership=${cr.ownership_clarity?.passed    ? 'PASS' : 'FAIL'}`,
    `integrity=${cr.position_integrity?.passed   ? 'PASS' : 'FAIL'}`,
  ].join(' | ');

  if (reconResult.passed) {
    await writeLog('info', 'reconcile',
      `Startup reconciliation PASSED — trading enabled | ${checkSummary}`,
      {
        trading_enabled: true,
        frozen:          false,
        trigger:         'startup',
        mode,
        recon_id:        reconResult.reconId,
        checks:          checkSummary,
        freeze_reasons:  [],
      }
    );
    console.log(`[startup] ✓ Reconciliation passed — v2 trading enabled (mode=${mode})`);
  } else {
    const reasons = reconResult.freezeReasons.join(' | ');
    await writeLog('warn', 'reconcile',
      `Startup reconciliation FROZEN | ${checkSummary} | reasons: ${reasons}`,
      {
        trading_enabled: false,
        frozen:          true,
        trigger:         'startup',
        mode,
        recon_id:        reconResult.reconId,
        checks:          checkSummary,
        freeze_reasons:  reconResult.freezeReasons,
      }
    );
    console.warn(`[startup] ⛔ FROZEN — ${reasons}`);
    console.warn('[startup] Resolve freeze in dashboard → Portfolio Adoption section → Clear Freeze');
  }

  console.log(`${'═'.repeat(64)}\n`);
}

// ─── Schedules ────────────────────────────────────────────────────────────────

// Every 2 min — sell checks
cron.schedule('*/2 * * * *', () => runCycle({ dipBuyOnly: false }, 'sell_check'), { timezone: 'UTC' });

// Every 5 min — dip-buy checks
cron.schedule('*/5 * * * *', () => runCycle({}, 'dip_check'), { timezone: 'UTC' });

// Daily DCA at 01:00 UTC
cron.schedule('0 1 * * *', () => runCycle({ forceDca: false }, 'daily_dca'), { timezone: 'UTC' });

// Hourly performance digest
cron.schedule('0 * * * *', hourlyDigest, { timezone: 'UTC' });

// Poll manual trigger / kill switch / deploy / reconcile every 10s
setInterval(pollTrigger,          10_000);
setInterval(pollDeploy,           10_000);
setInterval(pollReconcileTrigger, 10_000);

// Heartbeat every 5 min
setInterval(heartbeat, 5 * 60_000);
heartbeat();

// ── V2 schedules (run alongside v1) ──────────────────────────────────────────
// V2 sell checks every 2 min (same cadence as v1)
cron.schedule('*/2 * * * *', () => runCycleV2({ dipBuyOnly: false }, 'sell_check'), { timezone: 'UTC' });
// V2 buy checks every 5 min
cron.schedule('*/5 * * * *', () => runCycleV2({}, 'buy_check'), { timezone: 'UTC' });
// Reconciliation every 4h
cron.schedule('0 */4 * * *', () => reconcile('scheduled'), { timezone: 'UTC' });

// Startup sequence:
//   5s  — v1 continues trading live (existing engine, unaffected)
//   8s  — full startup sequence: adoption → reconciliation → unfreeze
//          v2 cycles are blocked (frozen) until reconciliation passes
//   After startup sequence completes: v2 first cycle runs if not frozen
setTimeout(() => runCycle({}, 'startup'), 5000);
setTimeout(async () => {
  await startupSequence();
  // Run first v2 cycle immediately after startup sequence (freeze state already set)
  await runCycleV2({}, 'startup');
}, 8000);

// Load risk engine state from DB in parallel with other init
riskEngine.loadState(supabase).catch(() => {});

console.log('[pi-trader] v4.0 started — v1 live + v2 paper running in parallel');
console.log('  V1 sell checks : every 2 min (v1 live signals)');
console.log('  V1 dip buys    : every 5 min');
console.log('  V1 DCA         : daily at 01:00 UTC');
console.log('  V2 sell checks : every 2 min (regime + ATR exits, paper mode)');
console.log('  V2 buy checks  : every 5 min (4-factor signals, paper mode)');
console.log('  Reconciliation : every 4h + on startup');
console.log('  Switch to live : set mode=live in bot_config via dashboard');
