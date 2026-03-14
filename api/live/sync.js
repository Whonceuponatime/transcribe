require('dotenv').config();
const liveTrading = require('../../lib/liveTrading');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const supabase = liveTrading.getSupabase();
    if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
    const adapter = liveTrading.getQuoteAdapter();
    let last = adapter.getLastQuote ? adapter.getLastQuote('USDKRW') : null;
    if (!last && typeof adapter.fetchOnce === 'function') {
      last = await adapter.fetchOnce();
    }
    if (last) {
      await supabase.from('market_ticks').insert({
        provider: adapter.name,
        symbol: 'USDKRW',
        bid: last.bid,
        ask: last.ask,
        mid: last.mid,
        spread: last.spread,
        event_ts: last.eventTs ? new Date(last.eventTs).toISOString() : new Date().toISOString(),
        received_ts: new Date().toISOString(),
        raw_payload: last.raw || {},
      });
    }
    const quote = await liveTrading.getLatestQuote(supabase);
    const barsAdapter = liveTrading.createDbHistoricalBarsAdapter(supabase);
    const toTs = Date.now();
    const bars1m = await barsAdapter.getBars('USDKRW', '1m', toTs - 120 * 60 * 1000, toTs);
    const bars1d = await barsAdapter.getBars('USDKRW', '1d', toTs - 365 * 24 * 60 * 60 * 1000, toTs);
    const mode = await liveTrading.getTradingMode(supabase);
    const killOn = await liveTrading.isKillSwitchOn(supabase);
    const result = liveTrading.runSignal(quote, bars1m, bars1d, killOn);
    await supabase.from('signal_runs').insert({
      symbol: 'USDKRW',
      mode: mode || 'paper',
      score: result.score,
      decision: result.decision,
      allocation_pct: result.allocation_pct,
      confidence: result.confidence,
      reasons: result.reasons || [],
      safeguards: result.safeguards || [],
      snapshot: result.snapshot || {},
    });
    res.json({ ok: true, quote, signal: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
