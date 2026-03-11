/**
 * Live trading: get supabase client, broker adapter, quote adapter, run signal, place order.
 * PAPER default; LIVE only when LIVE_TRADING_ENABLED=true.
 */

const { createClient } = require('@supabase/supabase-js');
const { createPaperBrokerAdapter } = require('./adapters/paperBrokerAdapter');
const { createIbkrBrokerAdapter } = require('./adapters/ibkrBrokerAdapter');
const { createPollingQuoteAdapter } = require('./adapters/pollingQuoteAdapter');
const { createDbHistoricalBarsAdapter } = require('./adapters/historicalBarsAdapter');
const { placeOrder, getOrderByIdempotencyKey } = require('./orderService');
const { runSignal } = require('./signalEngine');
const {
  isKillSwitchOn,
  getTradingMode,
  checkSafety,
  getDailyFilledNotionalKrw,
  getLastOrderTs,
  recordRiskEvent,
  KILL_SWITCH_KEY,
  TRADING_MODE_KEY,
} = require('./safetyLayer');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function getBrokerAdapter(mode) {
  const provider = (process.env.BROKER_PROVIDER || 'paper').toLowerCase();
  if (provider === 'ibkr' || provider === 'ib') {
    return createIbkrBrokerAdapter(mode);
  }
  return createPaperBrokerAdapter();
}

function getQuoteAdapter() {
  const provider = (process.env.MARKET_DATA_PROVIDER || 'polling').toLowerCase();
  if (provider === 'polling') return createPollingQuoteAdapter({ pollMs: 15000 });
  return createPollingQuoteAdapter({ pollMs: 15000 });
}

async function getLatestQuote(supabase) {
  const { data } = await supabase
    .from('market_ticks')
    .select('bid, ask, mid, spread, event_ts, received_ts')
    .eq('symbol', 'USDKRW')
    .order('event_ts', { ascending: false })
    .limit(1)
    .single();
  if (!data) return null;
  const ageSeconds = (Date.now() - new Date(data.event_ts || data.received_ts).getTime()) / 1000;
  return {
    bid: data.bid,
    ask: data.ask,
    mid: data.mid ?? (data.bid + data.ask) / 2,
    spread: data.spread ?? (data.ask - data.bid),
    eventTs: data.event_ts,
    staleSeconds: ageSeconds,
  };
}

async function getLatestSignal(supabase) {
  const { data } = await supabase
    .from('signal_runs')
    .select('*')
    .order('signal_ts', { ascending: false })
    .limit(1)
    .single();
  return data;
}

async function setKillSwitch(supabase, enabled) {
  await supabase.from('app_settings').upsert({
    key: KILL_SWITCH_KEY,
    value: { enabled: !!enabled },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  await recordRiskEvent(supabase, enabled ? 'critical' : 'info', 'kill_switch', enabled ? 'Kill switch turned ON' : 'Kill switch turned OFF');
}

async function setTradingMode(supabase, mode) {
  const allowed = process.env.LIVE_TRADING_ENABLED === 'true' || process.env.LIVE_TRADING_ENABLED === '1';
  const m = mode === 'live' && !allowed ? 'paper' : (mode === 'paper' || mode === 'live' ? mode : 'paper');
  await supabase.from('app_settings').upsert({
    key: TRADING_MODE_KEY,
    value: { mode: m },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  return m;
}

module.exports = {
  getSupabase,
  getBrokerAdapter,
  getQuoteAdapter,
  getLatestQuote,
  getLatestSignal,
  placeOrder,
  getOrderByIdempotencyKey,
  runSignal,
  isKillSwitchOn,
  getTradingMode,
  checkSafety,
  getDailyFilledNotionalKrw,
  getLastOrderTs,
  setKillSwitch,
  setTradingMode,
  createDbHistoricalBarsAdapter,
};
