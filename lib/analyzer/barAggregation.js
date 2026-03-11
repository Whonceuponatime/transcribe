/**
 * Build or fetch 1-minute bars from incoming quotes. Save to fx_bars_1m.
 */

const { createFinnhubFallbackProvider } = require('./adapters/finnhubFallbackProvider');

async function getRecentQuotes(supabase, symbol, minutes = 120) {
  const from = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('fx_live_quotes')
    .select('mid, quote_ts, provider')
    .eq('symbol', symbol)
    .gte('quote_ts', from)
    .order('quote_ts', { ascending: true });
  return data || [];
}

function bucketToMinute(ts) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  return d.toISOString();
}

async function upsertBars(supabase, rows) {
  if (!rows.length) return 0;
  let inserted = 0;
  for (const row of rows) {
    const { error } = await supabase.from('fx_bars_1m').upsert(row, {
      onConflict: 'symbol,provider,bucket_ts',
    });
    if (!error) inserted++;
  }
  return inserted;
}

async function aggregateBarsFromQuotes(supabase, symbol = 'USDKRW') {
  const quotes = await getRecentQuotes(supabase, symbol, 120);
  if (!quotes.length) return { aggregated: 0 };

  const buckets = new Map();
  for (const q of quotes) {
    const ts = q.quote_ts;
    const bucket = bucketToMinute(ts);
    const mid = Number(q.mid);
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { open: mid, high: mid, low: mid, close: mid, count: 0, provider: q.provider });
    } else {
      const b = buckets.get(bucket);
      b.high = Math.max(b.high, mid);
      b.low = Math.min(b.low, mid);
      b.close = mid;
      b.count += 1;
    }
  }

  let inserted = 0;
  for (const [bucket_ts, b] of buckets) {
    const row = {
      symbol,
      provider: b.provider || 'analyzer',
      bucket_ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      source_count: b.count,
      raw_payload: {},
    };
    inserted += await upsertBars(supabase, [row]);
  }
  return { aggregated: inserted };
}

/**
 * If quote-driven ingestion is sparse (manual clicks), backfill recent 1m candles from provider.
 * This makes the USD/KRW chart and indicators meaningful without pretending it's real-time.
 */
async function ensureRecentBars(supabase, symbol = 'USDKRW', minutes = 240) {
  const fromIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('fx_bars_1m')
    .select('id')
    .eq('symbol', symbol)
    .gte('bucket_ts', fromIso);

  const count = (data || []).length;
  if (count >= Math.min(60, minutes / 2)) return { ok: true, backfilled: 0, reason: 'enough_bars' };

  // Backfill using Finnhub candles (fallback) because it provides O/H/L/C bars directly.
  const finnhub = createFinnhubFallbackProvider();
  if (!finnhub.fetchCandles1m) return { ok: true, backfilled: 0, reason: 'no_bar_provider' };

  const to = Math.floor(Date.now() / 1000);
  const from = to - minutes * 60;
  const candles = await finnhub.fetchCandles1m(symbol, from, to);
  const rows = (candles || []).map((c) => ({
    symbol,
    provider: 'finnhub',
    bucket_ts: c.bucket_ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    source_count: 1,
    raw_payload: { source: 'finnhub_candle_1m' },
  }));

  const backfilled = await upsertBars(supabase, rows);
  return { ok: true, backfilled, reason: 'backfilled_from_finnhub' };
}

module.exports = { getRecentQuotes, aggregateBarsFromQuotes, bucketToMinute, ensureRecentBars };
