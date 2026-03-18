/**
 * Pi Trader v3 — signal-driven, trades frequently
 *
 * Schedule:
 *   Every 5 min  : sell checks (profit-take, RSI, BB, MACD, trailing stop)
 *   Every hour   : dip-buy check (RSI oversold, BB lower, MACD bull cross)
 *   Every Monday : weekly DCA buy
 *   Every 10s    : manual trigger + kill switch poll
 *   Every 5 min  : heartbeat
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const trader = require('../lib/cryptoTrader');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPBIT_ACCESS_KEY', 'UPBIT_SECRET_KEY'];
for (const key of required) {
  if (!process.env[key]) { console.error(`[pi-trader] Missing: ${key}`); process.exit(1); }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
let running = false;
let sellCheckCount = 0;   // track sell_check cycles for periodic diagnostic logging

/** Write one structured log row and prune entries older than 14 days. */
async function writeLog(level, tag, message, meta = null) {
  try {
    await supabase.from('crypto_bot_logs').insert({ level, tag, message, meta });
    // Prune logs older than 14 days to keep the table tidy
    await supabase.from('crypto_bot_logs')
      .delete()
      .lt('created_at', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  } catch (_) {}
}

async function isKilled() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'kill_switch').single();
    return data?.value?.enabled === true;
  } catch (_) { return false; }
}

async function runCycle(opts = {}, label = 'auto') {
  if (await isKilled()) { console.log(`[${label}] Kill switch ON — skipped`); return; }
  if (running) { console.log(`[${label}] Busy — skipped`); return; }

  running = true;
  const startedAt = new Date().toISOString();
  console.log(`\n[${label}] ── Start at ${startedAt}`);

  try {
    const result = await trader.executeCycle(supabase, opts);

    const trades = [
      ...(result.sells || []).filter((t) => t.ok),
      ...(result.dca || []).filter((t) => t.ok),
      ...(result.dipBuys || []).filter((t) => t.ok),
    ];

    const completedAt = new Date().toISOString();

    if (trades.length || result.errors?.length) {
      console.log(`[${label}] Trades executed: ${trades.length}`);
      for (const t of trades) {
        console.log(`  ${t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA') ? 'BUY' : 'SELL'} ${t.coin} — ${t.reason} | ${t.krwAmount ? `₩${t.krwAmount.toLocaleString()}` : `${t.soldAmount} ${t.coin}`}`);
      }
      if (result.errors?.length) console.error(`[${label}] Errors:`, result.errors);
    } else {
      const skipMsg = result.skipped?.join(' | ') || 'no triggers';
      console.log(`[${label}] Done — ${skipMsg}`);
    }

    // ── Structured log for dashboard ──────────────────────────────────────
    if (trades.length > 0) {
      const lines = trades.map((t) => {
        const isBuy = t.reason?.startsWith('DIP') || t.reason?.startsWith('DCA');
        const side  = isBuy ? 'BUY' : 'SELL';
        let amt;
        if (isBuy) {
          amt = t.krwAmount ? `₩${Math.round(t.krwAmount).toLocaleString()}` : '?';
        } else {
          const krwVal = t.grossKrw ?? (t.soldAmount && t.priceKrw ? Math.round(t.soldAmount * t.priceKrw) : null);
          amt = krwVal
            ? `${t.soldAmount} ${t.coin} (≈₩${krwVal.toLocaleString()})`
            : `${t.soldAmount} ${t.coin}`;
        }
        return `${side} ${t.coin} ${amt} — ${t.reason ?? '?'}`;
      });
      await writeLog('info', label, lines.join(' · '), {
        tradeCount: trades.length,
        trades: trades.map((t) => ({ coin: t.coin, reason: t.reason, krwAmount: t.krwAmount })),
      });
    } else if (result.errors?.length) {
      await writeLog('warn', label, `Cycle finished with errors: ${result.errors.join('; ')}`);
    } else {
      const skipMsg = result.skipped?.join(' | ') || 'no triggers fired';
      if (label !== 'sell_check') {
        // Always log dip_check / startup / manual_trigger no-trade cycles
        await writeLog('info', label, `No trades — ${skipMsg}`);
      } else if (sellCheckCount % 5 === 0) {
        // Log sell_check every ~10 min (every 5 cycles) so dashboard shows the bot is active
        await writeLog('info', label, `Active — ${skipMsg}`);
      }
    }

    // ── Sell diagnostics: log to DB every ~15 min (every 7 sell_checks) ──
    if (label === 'sell_check') sellCheckCount++;
    const isDiagCycle = label !== 'sell_check' || sellCheckCount % 7 === 0;
    if (isDiagCycle && result.sellDiag?.length) {
      const diagLines = result.sellDiag.map((d) => {
        const base = `${d.coin}: gain=${d.gainPct ?? '?'}% net=${d.netGainPct ?? '?'}%`;
        const block = d.blockedBy ? ` | BLOCKED: ${d.blockedBy}` : (d.signalsMet.length ? ` | SIGNALS: ${d.signalsMet.join(',')}` : ' | no signals');
        const ind = ` | RSI=${d.indicators.rsi} StochRSI=${d.indicators.stochRsi} VWAP=${d.indicators.vwapDev}% WR=${d.indicators.williamsR} CCI=${d.indicators.cci}`;
        return base + block + ind;
      });
      await writeLog('debug', 'sell_diag', diagLines.join('  ·  '), {
        sellDiag: result.sellDiag,
        skipped:  result.skipped,
        cycleLabel: label,
      });
    }

    try {
      await supabase.from('app_settings').upsert({
        key: 'last_cycle_result',
        value: { result, label, startedAt, completedAt, ok: true },
        updated_at: completedAt,
      }, { onConflict: 'key' });
    } catch (_) {}

  } catch (err) {
    console.error(`[pi-trader] Cycle error: ${err.message}`);
    await writeLog('error', label, `Cycle error: ${err.message}`);
    try {
      await supabase.from('app_settings').upsert({
        key: 'last_cycle_result',
        value: { error: err.message, label, startedAt, ok: false },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    } catch (_) {}
  } finally {
    // Always release the lock, even if an error occurs mid-cycle
    running = false;
  }
}

async function heartbeat() {
  try {
    await supabase.from('app_settings').upsert({
      key: 'pi_heartbeat',
      value: { lastSeen: new Date().toISOString(), version: '3.0' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}

  // Also refresh the portfolio snapshot so the dashboard always shows live balances
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

    // Get cached USD/KRW rate
    const { data: fxRow } = await supabase.from('app_settings').select('value').eq('key', 'usd_krw_rate').single();
    const usdKrw = fxRow?.value?.rate ?? null;

    await trader.savePortfolioSnapshot(supabase, { accounts, priceMap, usdKrw, coins, config });
  } catch (_) {}
}

async function pollDeploy() {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'crypto_deploy_trigger').single();
    if (data?.value?.pending) {
      // Clear flag immediately so a crash doesn't loop
      await supabase.from('app_settings').upsert({
        key: 'crypto_deploy_trigger',
        value: { pending: false, startedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      await writeLog('info', 'deploy', 'git pull triggered — pulling latest code…');
      console.log('[deploy] Running git pull…');

      const { execSync } = require('child_process');
      execSync('git pull', { cwd: require('path').resolve(__dirname, '..'), stdio: 'inherit' });

      await writeLog('info', 'deploy', 'git pull complete — exiting so PM2 restarts with new code');
      console.log('[deploy] git pull done — exiting for PM2 restart');
      setTimeout(() => process.exit(0), 500); // give log write a moment
    }
  } catch (err) {
    await writeLog('error', 'deploy', `Deploy failed: ${err.message}`);
    console.error('[deploy] Error:', err.message);
  }
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

// ─── Schedules ────────────────────────────────────────────────────────────────

// Every 2 min — sell checks (profit-take + signal sells + trailing stop)
// Upbit allows ~600 market-data req/min; each cycle uses ~11 → safe headroom.
cron.schedule('*/2 * * * *', () => runCycle({ dipBuyOnly: false }, 'sell_check'), { timezone: 'UTC' });

// Every 5 min — dip-buy check (catches oversold entries faster)
cron.schedule('*/5 * * * *', () => runCycle({}, 'dip_check'), { timezone: 'UTC' });

// Daily DCA check — runs every day at 01:00 UTC (10:00 KST)
// Actual buy only happens when cooldown (dca_cooldown_days) has elapsed.
cron.schedule('0 1 * * *', () => runCycle({ forceDca: false }, 'daily_dca'), { timezone: 'UTC' });

// Poll manual trigger / kill switch / deploy every 10s
setInterval(pollTrigger, 10_000);
setInterval(pollDeploy,  10_000);

// Heartbeat every 5 min
setInterval(heartbeat, 5 * 60_000);
heartbeat();

// Startup check 5s after boot
setTimeout(() => runCycle({}, 'startup'), 5000);

console.log('[pi-trader] v3.2 started — signal-driven trading');
console.log('  Sell checks : every 2 min (RSI, Bollinger, MACD, profit-take, trailing stop)');
console.log('  Dip buys    : every 5 min  (RSI oversold, BB lower band, MACD bull cross, VWAP)');
console.log('  DCA         : every 0.5d by default (configurable, checked every cycle)');
console.log('  Kill switch : checked before every cycle (~10s response)');
