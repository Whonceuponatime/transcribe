/**
 * Historical bars adapter interface: fetch OHLCV bars for computing MAs and percentile.
 * Implementations: getBars(symbol, resolution, from, to) -> [{ bucket_ts, open, high, low, close, volume }].
 */

function createHistoricalBarsAdapter(impl) {
  return {
    name: impl.name || 'unknown',

    async getBars(symbol, resolution, fromTs, toTs) {
      if (!impl.getBars) return [];
      return impl.getBars(symbol, resolution, fromTs, toTs);
    },
  };
}

/**
 * Build 1m bars from stored market_ticks or market_bars_1m in DB (used by backfill/sync).
 */
function createDbHistoricalBarsAdapter(supabase) {
  const impl = {
    name: 'db',

    async getBars(symbol, resolution, fromTs, toTs) {
      if (resolution !== '1m' && resolution !== '1d') return [];
      const fromStr = new Date(fromTs).toISOString();
      const toStr = new Date(toTs).toISOString();
      if (resolution === '1m') {
        const { data, error } = await supabase
          .from('market_bars_1m')
          .select('bucket_ts, open, high, low, close, volume, trade_count')
          .eq('symbol', symbol)
          .gte('bucket_ts', fromStr)
          .lte('bucket_ts', toStr)
          .order('bucket_ts', { ascending: true });
        if (error) return [];
        return (data || []).map((r) => ({
          bucket_ts: r.bucket_ts,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          trade_count: r.trade_count,
        }));
      }
      const { data } = await supabase
        .from('market_bars_1m')
        .select('bucket_ts, open, high, low, close, volume')
        .eq('symbol', symbol)
        .gte('bucket_ts', fromStr)
        .lte('bucket_ts', toStr)
        .order('bucket_ts', { ascending: true });
      const bars = data || [];
      const dayMap = new Map();
      bars.forEach((b) => {
        const day = b.bucket_ts.slice(0, 10);
        if (!dayMap.has(day)) dayMap.set(day, { bucket_ts: day + 'T00:00:00Z', open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 });
        const d = dayMap.get(day);
        d.high = Math.max(d.high, b.high);
        d.low = Math.min(d.low, b.low);
        d.close = b.close;
        d.volume += Number(b.volume) || 0;
      });
      return [...dayMap.values()].sort((a, b) => a.bucket_ts.localeCompare(b.bucket_ts));
    },
  };
  return createHistoricalBarsAdapter(impl);
}

module.exports = { createHistoricalBarsAdapter, createDbHistoricalBarsAdapter };
