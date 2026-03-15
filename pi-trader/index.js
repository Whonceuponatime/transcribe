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

    try {
      await supabase.from('app_settings').upsert({
        key: 'last_cycle_result',
        value: { result, label, startedAt, completedAt: new Date().toISOString(), ok: true },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });
    } catch (_) {}

  } catch (err) {
    console.error(`[pi-trader] Cycle error: ${err.message}`);
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

// Every 5 min — sell checks (profit-take + signal sells + trailing stop)
cron.schedule('*/5 * * * *', () => runCycle({ dipBuyOnly: false }, 'sell_check'), { timezone: 'UTC' });

// Every hour — dip-buy check (runs full cycle so it also catches sells)
cron.schedule('0 * * * *', () => runCycle({}, 'dip_check'), { timezone: 'UTC' });

// Weekly DCA — Monday 01:00 UTC (10:00 KST)
cron.schedule('0 1 * * 1', () => runCycle({ forceDca: false }, 'weekly_dca'), { timezone: 'UTC' });

// Poll manual trigger / kill switch every 10s
setInterval(pollTrigger, 10_000);

// Heartbeat every 5 min
setInterval(heartbeat, 5 * 60_000);
heartbeat();

// Startup check 5s after boot
setTimeout(() => runCycle({}, 'startup'), 5000);

console.log('[pi-trader] v3.0 started — signal-driven trading');
console.log('  Sell checks : every 5 min (RSI, Bollinger, MACD, profit-take, trailing stop)');
console.log('  Dip buys    : every hour (RSI oversold, BB lower band, MACD bull cross)');
console.log('  Weekly DCA  : Monday 01:00 UTC (10:00 KST)');
console.log('  Kill switch : checked before every cycle (~10s response)');
