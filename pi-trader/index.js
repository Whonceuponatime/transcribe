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
// V1 (cryptoTrader.js) is fully removed. V2 is the only engine.
const traderV2    = require('../lib/cryptoTraderV2');
const riskEngine  = require('../lib/riskEngine');
const adopter     = require('../lib/portfolioAdopter');
const reconEngine = require('../lib/reconciliationEngine');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPBIT_ACCESS_KEY', 'UPBIT_SECRET_KEY'];
for (const key of required) {
  if (!process.env[key]) { console.error(`[pi-trader] Missing: ${key}`); process.exit(1); }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
let runningV2    = false;
let adoptionDone = false; // set true after startup adoption completes
let lastCycleCompletedAt = null; // written after every successful cycle for dashboard freshness

// Hourly digest accumulator (V2 fills, not V1 trades)
let hourlyTrades   = [];
let hourlyStartKrw = null;

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

// V1 runCycle and tradeLine fully removed. V2 is the only engine.

/**
 * Hourly digest — fires every hour.
 * Aggregates trades, P&L change, and near-miss signals from the last hour.
 */
async function hourlyDigest() {
  try {
    const trades = hourlyTrades.splice(0); // drain accumulator

    // Current portfolio snapshot for P&L reference
    let snapRow = null;
    try {
      const { data } = await supabase.from('app_settings').select('value')
        .eq('key', 'crypto_portfolio_snapshot').single();
      snapRow = data;
    } catch (_) {}
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
    let diagLogs = [];
    try {
      const { data: _diagData } = await supabase.from('crypto_bot_logs')
        .select('meta').eq('tag', 'sell_diag').gte('created_at', since1h)
        .order('created_at', { ascending: false }).limit(3);
      diagLogs = _diagData ?? [];
    } catch (_) {}

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
      value: {
        lastSeen:     new Date().toISOString(),
        lastCycleAt:  lastCycleCompletedAt,
        version:      '5.0',
        engine:       'V2_live_only',
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}

  // V2 saves its own portfolio snapshot every cycle.
  // V1 portfolio snapshot (trader.savePortfolioSnapshot) has been removed.
  try {
    // no-op placeholder so the try/catch structure is clear
  } catch (_) {}
}

/**
 * Fetch Fear & Greed index and store in app_settings for V2 macro gate.
 * Uses the same key V1 used ('fear_greed') so the dashboard can still read it.
 * Non-fatal — V2 fails open if unavailable.
 */
async function refreshFearGreed() {
  try {
    const https = require('https');
    const raw = await new Promise((resolve, reject) => {
      const req = https.get('https://api.alternative.me/fng/?limit=1', (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const d = JSON.parse(raw)?.data?.[0];
    if (!d) return;
    await supabase.from('app_settings').upsert({
      key:        'fear_greed',
      value:      { value: Number(d.value), label: d.value_classification, fetchedAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
    console.log(`[pi] Fear & Greed: ${d.value} (${d.value_classification})`);
  } catch (err) {
    console.warn('[pi] Fear & Greed fetch failed (non-fatal):', err.message);
  }
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
      // V1 runCycle removed — manual trigger now fires a V2 cycle directly
      await runCycleV2({}, 'manual_trigger');
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
    lastCycleCompletedAt = new Date().toISOString();
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
    const coins = cfg.coins ?? ['BTC', 'ETH'];
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
  const coins = cfg.coins ?? ['BTC', 'ETH'];

  console.log(`\n${'═'.repeat(64)}`);
  console.log('  STARTUP SEQUENCE — V2 LIVE ENGINE');
  console.log(`  Coins: ${coins.join(', ')}   execution_mode: live`);
  console.log(`${'═'.repeat(64)}`);

  // ── Step 1: Load persisted freeze state from DB ──────────────────────────
  // Restoring from DB ensures a process restart does not silently clear a freeze
  // that was set in a previous run due to a balance mismatch.
  await reconEngine.loadFreezeState(supabase);
  console.log(`[startup] Freeze state loaded — currently ${reconEngine.isSystemFrozen() ? 'FROZEN' : 'clear'}`);

  // ── Step 2: Portfolio adoption ───────────────────────────────────────────
  let adoptionResult = { alreadyDone: false, adopted: [], unsupported: [], skipped: [], error: null };
  try {
    adoptionResult = await adopter.runAdoption(supabase, coins, 'live');

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
          execution_mode:       'live',
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

  // ── Step 2.5: Resolve stuck orders before reconciliation ────────────────
  // Orders left in 'accepted' state from a previous crashed/disconnected run
  // are fetched from Upbit, their fills applied to positions, and their state
  // updated to terminal. Without this step, reconciliation always freezes on
  // restart after the sell→'wait'→crash sequence, requiring manual intervention.
  console.log('[startup] Resolving any stuck orders from previous run…');
  try {
    const stuckResult = await reconEngine.resolveStuckOrders(supabase);
    if (stuckResult.resolved.length > 0) {
      console.log(`[startup] Stuck orders resolved: ${stuckResult.resolved.map((r) => `${r.asset}(${r.state})`).join(', ')}`);
      await writeLog('warn', 'reconcile',
        `Startup: resolved ${stuckResult.resolved.length} stuck order(s) — positions updated before reconciliation`,
        { resolved: stuckResult.resolved, failed: stuckResult.failed }
      );
    }
    if (stuckResult.failed.length > 0) {
      console.warn(`[startup] Failed to resolve ${stuckResult.failed.length} stuck order(s): ${stuckResult.failed.map((f) => f.asset).join(', ')}`);
      await writeLog('error', 'reconcile',
        `Startup: ${stuckResult.failed.length} stuck order(s) could not be resolved — manual review required`,
        { failed: stuckResult.failed }
      );
    }
  } catch (stuckErr) {
    console.error('[startup] resolveStuckOrders error:', stuckErr.message);
    await writeLog('error', 'reconcile', `resolveStuckOrders startup error: ${stuckErr.message}`);
  }

  // ── Step 2.6: Backfill orphaned fills ───────────────────────────────────
  // Covers the gap resolveStuckOrders cannot: orders already in terminal
  // ('filled') state with no v2_fills rows and stale positions.qty_open.
  // This happens when executeSell's poll moved the order to 'filled' but
  // extractFills still returned [] (empty trades array at that moment).
  console.log('[startup] Backfilling any orphaned fills (filled orders with no fill records)…');
  try {
    const orphanResult = await reconEngine.backfillOrphanedFills(supabase);
    if (orphanResult.applied.length > 0) {
      console.log(`[startup] Orphaned fills backfilled: ${orphanResult.applied.map((r) => `${r.asset}(${r.qtyBefore}→${r.qtyAfter})`).join(', ')}`);
      await writeLog('warn', 'reconcile',
        `Startup: backfilled ${orphanResult.applied.length} orphaned fill(s) — positions corrected`,
        { applied: orphanResult.applied, skipped: orphanResult.skipped, failed: orphanResult.failed }
      );
    }
    if (orphanResult.failed.length > 0) {
      console.warn(`[startup] Orphaned fill backfill failed for: ${orphanResult.failed.map((f) => f.asset).join(', ')}`);
    }
  } catch (orphanErr) {
    console.error('[startup] backfillOrphanedFills error:', orphanErr.message);
    await writeLog('error', 'reconcile', `backfillOrphanedFills startup error: ${orphanErr.message}`);
  }

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
        execution_mode:  'live',
        recon_id:        reconResult.reconId,
        checks:          checkSummary,
        freeze_reasons:  [],
      }
    );
    console.log('[startup] ✓ Reconciliation passed — V2 live engine trading enabled');
  } else {
    const reasons = reconResult.freezeReasons.join(' | ');
    await writeLog('warn', 'reconcile',
      `Startup reconciliation FROZEN | ${checkSummary} | reasons: ${reasons}`,
      {
        trading_enabled: false,
        frozen:          true,
        trigger:         'startup',
        execution_mode:  'live',
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

// ─── Schedules (V2 live engine only) ─────────────────────────────────────────

// V2 full evaluation every 1 min (sell + buy both enabled)
cron.schedule('* * * * *', () => runCycleV2({}, 'cycle'), { timezone: 'UTC' });
// Reconciliation every 4h
cron.schedule('0 */4 * * *', () => reconcile('scheduled'), { timezone: 'UTC' });
// Hourly performance digest + Fear & Greed refresh for macro gate
cron.schedule('0 * * * *', hourlyDigest, { timezone: 'UTC' });
cron.schedule('0 * * * *', refreshFearGreed, { timezone: 'UTC' });
refreshFearGreed(); // initial fetch on startup

// Poll manual trigger / kill switch / deploy / reconcile every 10s
setInterval(pollTrigger,          10_000);
setInterval(pollDeploy,           10_000);
setInterval(pollReconcileTrigger, 10_000);

// Heartbeat every 1 min for dashboard freshness
setInterval(heartbeat, 60_000);
heartbeat();

// Startup: adoption → reconciliation → first V2 cycle
setTimeout(async () => {
  await startupSequence();
  await runCycleV2({}, 'startup');
}, 5000);

// Load risk engine state from DB
riskEngine.loadState(supabase).catch(() => {});

console.log('[pi-trader] v5.0 — V2 live engine only (V1 removed)');
console.log('  engine         : V2 (live)');
console.log('  sell checks    : every 2 min (regime + ATR exits)');
console.log('  buy checks     : every 5 min (4-factor signals)');
console.log('  reconciliation : every 4h + on startup');
console.log('  controls       : trading_enabled / buys_enabled / sells_enabled in dashboard');
