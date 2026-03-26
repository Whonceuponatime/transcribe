/**
 * Consolidated live-trading API handler.
 * Replaces api/live/quote, sync, signal, orders, kill-switch, portfolio, mode, order/test.
 * Route via ?action=<name>
 *
 * Old paths are kept working via vercel.json rewrites.
 */
require('dotenv').config();
const liveTrading = require('../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const action = req.query.action || '';

  switch (action) {
    case 'quote':      return handleQuote(req, res);
    case 'sync':       return handleSync(req, res);
    case 'signal':     return handleSignal(req, res);
    case 'orders':     return handleOrders(req, res);
    case 'kill-switch':return handleKillSwitch(req, res);
    case 'portfolio':  return handlePortfolio(req, res);
    case 'mode':       return handleMode(req, res);
    case 'order-test': return handleOrderTest(req, res);
    default:
      return res.status(400).json({
        error: `Unknown action: "${action}". Valid: quote, sync, signal, orders, kill-switch, portfolio, mode, order-test`,
      });
  }
};

// ── quote ─────────────────────────────────────────────────────────────────────
async function handleQuote(req, res) {
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const quote   = await liveTrading.getLatestQuote(supabase);
    const adapter = liveTrading.getQuoteAdapter();
    const health  = adapter.getHealth();
    res.json({ quote, health, lastQuote: adapter.getLastQuote ? adapter.getLastQuote('USDKRW') : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── sync ──────────────────────────────────────────────────────────────────────
async function handleSync(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const adapter = liveTrading.getQuoteAdapter();
    let last = adapter.getLastQuote ? adapter.getLastQuote('USDKRW') : null;
    if (!last && typeof adapter.fetchOnce === 'function') last = await adapter.fetchOnce();
    if (last) {
      await supabase.from('market_ticks').insert({
        provider: adapter.name, symbol: 'USDKRW',
        bid: last.bid, ask: last.ask, mid: last.mid, spread: last.spread,
        event_ts:    last.eventTs ? new Date(last.eventTs).toISOString() : new Date().toISOString(),
        received_ts: new Date().toISOString(),
        raw_payload: last.raw || {},
      });
    }
    const quote       = await liveTrading.getLatestQuote(supabase);
    const barsAdapter = liveTrading.createDbHistoricalBarsAdapter(supabase);
    const toTs        = Date.now();
    const bars1m      = await barsAdapter.getBars('USDKRW', '1m', toTs - 120 * 60 * 1000, toTs);
    const bars1d      = await barsAdapter.getBars('USDKRW', '1d', toTs - 365 * 24 * 60 * 60 * 1000, toTs);
    const mode        = await liveTrading.getTradingMode(supabase);
    const killOn      = await liveTrading.isKillSwitchOn(supabase);
    const result      = liveTrading.runSignal(quote, bars1m, bars1d, killOn);
    await supabase.from('signal_runs').insert({
      symbol: 'USDKRW', mode: mode || 'paper',
      score: result.score, decision: result.decision,
      allocation_pct: result.allocation_pct, confidence: result.confidence,
      reasons: result.reasons || [], safeguards: result.safeguards || [],
      snapshot: result.snapshot || {},
    });
    res.json({ ok: true, quote, signal: result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
}

// ── signal ────────────────────────────────────────────────────────────────────
async function handleSignal(req, res) {
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const signal = await liveTrading.getLatestSignal(supabase);
    const mode   = await liveTrading.getTradingMode(supabase);
    const killOn = await liveTrading.isKillSwitchOn(supabase);
    res.json({ signal, mode, killSwitch: killOn });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── orders ────────────────────────────────────────────────────────────────────
async function handleOrders(req, res) {
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const { data } = await supabase
      .from('order_requests').select('*')
      .order('created_at', { ascending: false }).limit(limit);
    res.json({ orders: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── kill-switch ───────────────────────────────────────────────────────────────
async function handleKillSwitch(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const body    = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const enabled = body.enabled !== false && (body.enabled === true || body.enable === true);
    await liveTrading.setKillSwitch(supabase, enabled);
    res.json({ ok: true, killSwitch: enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── portfolio ─────────────────────────────────────────────────────────────────
async function handlePortfolio(req, res) {
  try {
    const supabase   = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const mode       = await liveTrading.getTradingMode(supabase);
    const broker     = liveTrading.getBrokerAdapter(mode);
    const cash       = await broker.getCash();
    const positions  = await broker.getPositions();
    const { data: latest } = await supabase
      .from('portfolio_snapshots').select('*')
      .order('snapshot_ts', { ascending: false }).limit(1).single();
    res.json({ cash, positions, snapshot: latest, mode });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── mode ──────────────────────────────────────────────────────────────────────
async function handleMode(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const mode = (body.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
    const set  = await liveTrading.setTradingMode(supabase, mode);
    res.json({ ok: true, mode: set });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── order-test ────────────────────────────────────────────────────────────────
async function handleOrderTest(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const mode   = await liveTrading.getTradingMode(supabase);
    const broker = liveTrading.getBrokerAdapter(mode);
    const safety = await liveTrading.checkSafety(supabase, {
      notionalKrw: 100000, quoteStaleSeconds: 10, spreadBps: 20, circuitFailureCount: 0,
    });
    if (!safety.allowed) return res.status(400).json({ ok: false, reason: safety.reason, detail: safety.detail });
    const result = await liveTrading.placeOrder(supabase, broker, {
      clientOrderId:  `test-${Date.now()}`,
      symbol:         'USDKRW',
      side:           'buy',
      orderType:      'MKTABLE_LMT',
      quantity:       10,
      notionalKrw:    13500,
      limitPrice:     1355,
      idempotencyKey: `test-${Date.now()}`,
      mode,
    });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
}
