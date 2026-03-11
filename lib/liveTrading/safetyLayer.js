/**
 * Safety: kill switch, caps, cooldown, stale guard, spread guard, circuit breaker.
 * PAPER default; LIVE only if LIVE_TRADING_ENABLED=true.
 */

const TRADING_MODE_KEY = 'trading_mode';
const KILL_SWITCH_KEY = 'kill_switch';
const MAX_DAILY_KEY = 'max_daily_notional_krw';
const MAX_SINGLE_KEY = 'max_single_order_krw';
const COOLDOWN_KEY = 'order_cooldown_seconds';
const STALE_KEY = 'stale_data_seconds';
const MAX_SPREAD_KEY = 'max_spread_bps';
const CIRCUIT_KEY = 'circuit_breaker_failures';

async function getSetting(supabase, key, defaultVal) {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', key).single();
    const v = data?.value;
    if (v != null && typeof v === 'object' && 'value' in v) return v.value;
    if (v != null && typeof v === 'object' && 'enabled' in v) return v.enabled;
  } catch (_) {}
  return defaultVal;
}

async function isKillSwitchOn(supabase) {
  return getSetting(supabase, KILL_SWITCH_KEY, false);
}

async function getTradingMode(supabase) {
  const mode = await getSetting(supabase, TRADING_MODE_KEY, 'paper');
  const liveAllowed = process.env.LIVE_TRADING_ENABLED === 'true' || process.env.LIVE_TRADING_ENABLED === '1';
  if (mode === 'live' && !liveAllowed) return 'paper';
  return mode;
}

async function getMaxDailyNotionalKrw(supabase) {
  return getSetting(supabase, MAX_DAILY_KEY, 10_000_000);
}

async function getMaxSingleOrderKrw(supabase) {
  return getSetting(supabase, MAX_SINGLE_KEY, 2_000_000);
}

async function getCooldownSeconds(supabase) {
  return getSetting(supabase, COOLDOWN_KEY, 300);
}

async function getStaleDataSeconds(supabase) {
  return getSetting(supabase, STALE_KEY, 60);
}

async function getMaxSpreadBps(supabase) {
  return getSetting(supabase, MAX_SPREAD_KEY, 50);
}

async function getCircuitBreakerFailures(supabase) {
  return getSetting(supabase, CIRCUIT_KEY, 5);
}

async function getDailyFilledNotionalKrw(supabase) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('fills')
    .select('quantity, price')
    .gte('fill_ts', `${today}T00:00:00Z`);
  const total = (data || []).reduce((s, f) => s + (Number(f.quantity) * Number(f.price) || 0), 0);
  return total;
}

async function getLastOrderTs(supabase) {
  const { data } = await supabase
    .from('order_requests')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data?.created_at ? new Date(data.created_at).getTime() : 0;
}

async function recordRiskEvent(supabase, severity, category, message, payload = {}) {
  await supabase.from('risk_events').insert({
    severity,
    category,
    message,
    payload,
  });
}

async function checkSafety(supabase, context) {
  const {
    notionalKrw,
    quoteStaleSeconds,
    spreadBps,
    circuitFailureCount,
  } = context;

  const killOn = await isKillSwitchOn(supabase);
  if (killOn) {
    await recordRiskEvent(supabase, 'critical', 'kill_switch', 'Order blocked: kill switch is ON');
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'kill_switch' };
  }

  const maxDaily = await getMaxDailyNotionalKrw(supabase);
  const maxSingle = await getMaxSingleOrderKrw(supabase);
  const dailyFilled = await getDailyFilledNotionalKrw(supabase);
  if (dailyFilled + notionalKrw > maxDaily) {
    await recordRiskEvent(supabase, 'warn', 'cap', `Daily cap exceeded: ${dailyFilled + notionalKrw} > ${maxDaily}`);
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'max_daily_notional' };
  }
  if (notionalKrw > maxSingle) {
    await recordRiskEvent(supabase, 'warn', 'cap', `Single order cap exceeded: ${notionalKrw} > ${maxSingle}`);
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'max_single_order' };
  }

  const cooldownSec = await getCooldownSeconds(supabase);
  const lastOrderTs = await getLastOrderTs(supabase);
  const elapsed = (Date.now() - lastOrderTs) / 1000;
  if (elapsed < cooldownSec) {
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'cooldown', retryAfter: cooldownSec - elapsed };
  }

  const staleLimit = await getStaleDataSeconds(supabase);
  if (quoteStaleSeconds != null && quoteStaleSeconds > staleLimit) {
    await recordRiskEvent(supabase, 'warn', 'stale', `Quote stale: ${quoteStaleSeconds}s > ${staleLimit}s`);
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'stale_data' };
  }

  const maxSpreadBps = await getMaxSpreadBps(supabase);
  if (spreadBps != null && spreadBps > maxSpreadBps) {
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'spread_guard' };
  }

  const circuitLimit = await getCircuitBreakerFailures(supabase);
  if (circuitFailureCount >= circuitLimit) {
    await recordRiskEvent(supabase, 'critical', 'circuit_breaker', `Circuit breaker: ${circuitFailureCount} failures`);
    return { allowed: false, reason: 'BLOCKED_BY_RISK', detail: 'circuit_breaker' };
  }

  return { allowed: true };
}

module.exports = {
  isKillSwitchOn,
  getTradingMode,
  getMaxDailyNotionalKrw,
  getMaxSingleOrderKrw,
  getCooldownSeconds,
  getStaleDataSeconds,
  getMaxSpreadBps,
  getCircuitBreakerFailures,
  getDailyFilledNotionalKrw,
  getLastOrderTs,
  recordRiskEvent,
  checkSafety,
  KILL_SWITCH_KEY,
  TRADING_MODE_KEY,
};
