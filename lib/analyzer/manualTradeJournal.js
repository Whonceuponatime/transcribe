/**
 * Manual trade journal: record trades, link to signal, average buy rate, totals.
 * No execution – user trades manually.
 */

async function recordTrade(supabase, trade) {
  const { data, error } = await supabase
    .from('fx_manual_trades')
    .insert({
      action: trade.action,
      krw_amount: trade.krw_amount,
      usd_amount: trade.usd_amount,
      fx_rate: trade.fx_rate,
      fees_krw: trade.fees_krw ?? 0,
      note: trade.note,
      related_signal_id: trade.related_signal_id ?? null,
    })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, trade: data };
}

async function getTrades(supabase, limit = 100) {
  const { data } = await supabase
    .from('fx_manual_trades')
    .select('*')
    .order('trade_ts', { ascending: false })
    .limit(limit);
  return data || [];
}

async function getJournalStats(supabase) {
  const { data } = await supabase
    .from('fx_manual_trades')
    .select('action, krw_amount, usd_amount, fx_rate');
  const trades = data || [];
  let totalKrw = 0;
  let totalUsd = 0;
  let costKrw = 0;
  for (const t of trades) {
    if (t.action === 'BUY_USD') {
      totalKrw += Number(t.krw_amount) || 0;
      totalUsd += Number(t.usd_amount) || 0;
      costKrw += Number(t.krw_amount) || 0;
    } else if (t.action === 'SELL_USD') {
      totalUsd -= Number(t.usd_amount) || 0;
      totalKrw -= Number(t.usd_amount) * Number(t.fx_rate) || 0;
    }
  }
  const avgBuyRate = totalUsd > 0 ? costKrw / totalUsd : null;
  return {
    totalKrwConverted: costKrw,
    totalUsdAcquired: totalUsd,
    averageBuyRate: avgBuyRate,
    tradeCount: trades.length,
  };
}

module.exports = { recordTrade, getTrades, getJournalStats };
