/**
 * Pi Trader — runs 24/7 on Raspberry Pi
 *
 * Fully automated schedule:
 *   - Every hour  : profit-take + trailing stop checks (sells when targets hit)
 *   - Every Monday: DCA buy (+ signal boost / fear-greed gate applied automatically)
 *   - Every 10s   : poll Supabase for kill switch and manual triggers from dashboard
 *   - Every 5min  : heartbeat so dashboard shows Pi online
 *
 * Kill switch: checked at the start of EVERY cycle — flipping it in the dashboard
 * stops all trading within 10 seconds (next poll cycle).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const trader = require('../lib/cryptoTrader');

// ─── Validate env ─────────────────────────────────────────────────────────────
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPBIT_ACCESS_KEY', 'UPBIT_SECRET_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`[pi-trader] Missing env var: ${key}`);
    process.exit(1);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let running = false;

// ─── Kill switch check ────────────────────────────────────────────────────────

async function isKilled() {
  try {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'kill_switch').single();
    return data?.value?.enabled === true;
  } catch (_) { return false; }
}

// ─── Core cycle ───────────────────────────────────────────────────────────────

async function runCycle(forceDca = false, reason = 'auto') {
  // Kill switch — checked before every cycle
  if (await isKilled()) {
    console.log(`[pi-trader] Kill switch ON — skipping cycle (reason=${reason})`);
    return;
  }

  if (running) {
    console.log('[pi-trader] Already running — skipping');
    return;
  }

  running = true;
  const startedAt = new Date().toISOString();
  console.log(`\n[pi-trader] ── Cycle start ── reason=${reason} forceDca=${forceDca} at ${startedAt}`);

  try {
    const result = await trader.executeCycle(supabase, { forceDca });

    // Log meaningful activity only
    const hasTrades = result.dca?.some((t) => t.ok) ||
      result.profitTake?.some((t) => t.ok) ||
      result.trailingStop?.some((t) => t.ok);

    if (hasTrades || result.errors?.length) {
      console.log('[pi-trader] Cycle result:', JSON.stringify(result, null, 2));
    } else {
      const skips = [
        ...(result.skipped || []),
        ...(result.dca?.filter((t) => t.skipped).map((t) => t.reason) || []),
      ].join(' | ');
      console.log(`[pi-trader] Cycle done — no trades. ${skips || 'Nothing triggered.'}`);
    }

    await supabase.from('app_settings').upsert({
      key: 'last_cycle_result',
      value: { result, reason, startedAt, completedAt: new Date().toISOString(), ok: true },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    await supabase.from('app_settings').upsert({
      key: 'pi_heartbeat',
      value: { lastSeen: new Date().toISOString(), version: '2.0' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

  } catch (err) {
    console.error('[pi-trader] Cycle error:', err.message);
    await supabase.from('app_settings').upsert({
      key: 'last_cycle_result',
      value: { error: err.message, reason, startedAt, ok: false },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' }).catch(() => {});
  }

  running = false;
}

// ─── Manual trigger + kill switch poller ─────────────────────────────────────

async function pollTrigger() {
  try {
    const { data } = await supabase
      .from('app_settings').select('value').eq('key', 'crypto_manual_trigger').single();

    if (data?.value?.pending) {
      await supabase.from('app_settings').upsert({
        key: 'crypto_manual_trigger',
        value: { pending: false, clearedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      const forceDca = data.value.forceDca === true;
      console.log(`[pi-trader] Manual trigger received — forceDca=${forceDca}`);
      await runCycle(forceDca, 'manual_trigger');
    }
  } catch (_) {}
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

async function heartbeat() {
  try {
    await supabase.from('app_settings').upsert({
      key: 'pi_heartbeat',
      value: { lastSeen: new Date().toISOString(), version: '2.0' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}
}

// ─── Schedules ────────────────────────────────────────────────────────────────

// Every 5 minutes: profit-take + trailing stop checks (no forced DCA)
cron.schedule('*/5 * * * *', async () => {
  await runCycle(false, 'auto_check');
}, { timezone: 'UTC' });

// Weekly DCA: Monday 01:00 UTC = 10:00 KST
cron.schedule('0 1 * * 1', async () => {
  console.log('[pi-trader] ── Weekly DCA cron ──');
  await runCycle(false, 'weekly_dca');
}, { timezone: 'UTC' });

// Poll for manual triggers + kill switch every 10 seconds
setInterval(pollTrigger, 10_000);

// Heartbeat every 5 minutes
setInterval(heartbeat, 5 * 60_000);
heartbeat(); // immediate on start

// Run one check immediately on startup (catch any missed profit-takes)
setTimeout(() => runCycle(false, 'startup_check'), 5000);

console.log('[pi-trader] Started — v2.0 fully automated.');
console.log('  Auto check  : profit-take + trailing stop every 5 min');
console.log('  Weekly DCA  : Monday 01:00 UTC (10:00 KST)');
console.log('  Kill switch : checked before every cycle (10s response)');
console.log('  Manual      : dashboard triggers via Supabase poll');
