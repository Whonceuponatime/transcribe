/**
 * Pi Trader — runs 24/7 on Raspberry Pi
 *
 * - Weekly DCA cron: Monday 10:00 KST (01:00 UTC)
 * - Polls Supabase every 10s for manual triggers from the Vercel dashboard
 * - All Upbit API calls originate from this process → home IP is allowlisted
 *
 * Env vars required (set in /home/pi/transcribe/.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   UPBIT_ACCESS_KEY, UPBIT_SECRET_KEY
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

// ─── Core cycle ───────────────────────────────────────────────────────────────

async function runCycle(forceDca = false, reason = 'manual') {
  if (running) {
    console.log('[pi-trader] Already running — skipping');
    return;
  }
  running = true;
  const startedAt = new Date().toISOString();
  console.log(`\n[pi-trader] ── Cycle start ── reason=${reason} forceDca=${forceDca} at ${startedAt}`);

  try {
    const result = await trader.executeCycle(supabase, { forceDca });
    console.log('[pi-trader] Cycle result:', JSON.stringify(result, null, 2));

    await supabase.from('app_settings').upsert({
      key: 'last_cycle_result',
      value: { result, reason, startedAt, completedAt: new Date().toISOString(), ok: true },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    // Update heartbeat
    await supabase.from('app_settings').upsert({
      key: 'pi_heartbeat',
      value: { lastSeen: new Date().toISOString(), version: '1.0' },
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

// ─── Manual trigger poller ────────────────────────────────────────────────────

async function pollTrigger() {
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'crypto_manual_trigger')
      .single();

    if (data?.value?.pending) {
      // Clear immediately to prevent double-fire
      await supabase.from('app_settings').upsert({
        key: 'crypto_manual_trigger',
        value: { pending: false, clearedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'key' });

      const forceDca = data.value.forceDca === true;
      console.log(`[pi-trader] Manual trigger received — forceDca=${forceDca}`);
      await runCycle(forceDca, 'manual_trigger');
    }
  } catch (_) {
    // Row doesn't exist yet — ignore
  }
}

// ─── Heartbeat (every 5 min, so dashboard can show Pi online status) ──────────

async function heartbeat() {
  try {
    await supabase.from('app_settings').upsert({
      key: 'pi_heartbeat',
      value: { lastSeen: new Date().toISOString(), version: '1.0' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}
}

// ─── Schedules ────────────────────────────────────────────────────────────────

// Weekly DCA: Monday 01:00 UTC = 10:00 KST
cron.schedule('0 1 * * 1', async () => {
  console.log('[pi-trader] ── Weekly DCA cron triggered ──');
  await runCycle(false, 'weekly_cron');
}, { timezone: 'UTC' });

// Poll for manual triggers every 10 seconds
setInterval(pollTrigger, 10_000);

// Heartbeat every 5 minutes
setInterval(heartbeat, 5 * 60_000);
heartbeat(); // immediate on start

console.log('[pi-trader] Started.');
console.log('  Weekly cron : Monday 01:00 UTC (10:00 KST)');
console.log('  Trigger poll: every 10s');
console.log('  Heartbeat   : every 5min');
console.log('  Upbit IP    : your home IP (59.20.105.83) must be in Upbit allowlist');
