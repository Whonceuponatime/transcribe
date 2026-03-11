/**
 * Quote ingestion: try Massive first, fallback to Finnhub. Save to fx_live_quotes, update provider_health.
 */

const { createMassiveLiveProvider } = require('./adapters/massiveLiveProvider');
const { createFinnhubFallbackProvider } = require('./adapters/finnhubFallbackProvider');

const STALE_SECONDS = 120;
const SYMBOL = 'USDKRW';

async function ingestQuote(supabase) {
  const massive = createMassiveLiveProvider();
  const finnhub = createFinnhubFallbackProvider();

  let quote = await massive.getQuote(SYMBOL);
  let provider = 'massive';
  let latencyMs = null;
  let status = 'up';

  if (!quote || !quote.mid) {
    const t0 = Date.now();
    quote = await finnhub.getQuote(SYMBOL);
    latencyMs = Date.now() - t0;
    provider = 'finnhub';
    if (!quote || !quote.mid) {
      await supabase.from('provider_health').insert({
        provider: 'massive',
        checked_at: new Date().toISOString(),
        status: 'down',
        details: { reason: 'no_quote' },
      });
      await supabase.from('provider_health').insert({
        provider: 'finnhub',
        checked_at: new Date().toISOString(),
        status: 'down',
        details: { reason: 'no_quote' },
      });
      return { ok: false, provider: null, quote: null };
    }
    // Massive failed but fallback succeeded: record Massive down for observability.
    await supabase.from('provider_health').insert({
      provider: 'massive',
      checked_at: new Date().toISOString(),
      status: 'down',
      details: { reason: 'fallback_active', symbol: SYMBOL },
    });
    status = 'up';
  } else {
    latencyMs = 0;
  }

  const now = new Date();
  const quoteTs = quote.timestamp instanceof Date ? quote.timestamp : new Date(quote.timestamp);
  const staleSeconds = (now - quoteTs) / 1000;
  const isStale = staleSeconds > STALE_SECONDS;

  await supabase.from('fx_live_quotes').insert({
    symbol: SYMBOL,
    provider,
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    spread: quote.spread,
    quote_ts: quoteTs.toISOString(),
    received_ts: now.toISOString(),
    is_stale: isStale,
    raw_payload: quote.raw || {},
  });

  await supabase.from('provider_health').insert({
    provider,
    checked_at: now.toISOString(),
    status: isStale ? 'degraded' : 'up',
    latency_ms: latencyMs,
    stale_seconds: Math.round(staleSeconds),
    details: { symbol: SYMBOL },
  });

  return {
    ok: true,
    provider,
    quote: {
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      timestamp: quoteTs.toISOString(),
      is_stale: isStale,
      stale_seconds: staleSeconds,
    },
  };
}

module.exports = { ingestQuote, STALE_SECONDS, SYMBOL };
