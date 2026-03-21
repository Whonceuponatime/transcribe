/**
 * Portfolio Adopter — first-deployment portfolio discovery and safe import.
 *
 * Startup sequence:
 *   1. Query live Upbit balances
 *   2. Normalize asset symbols
 *   3. Separate into: supported / unsupported / KRW cash
 *   4. Build initial in-memory portfolio state
 *   5. Write adopted position records to DB (ALL modes including paper)
 *   6. Record excluded unsupported holdings in bot_events and adoption_run
 *   7. Mark adoption_run complete
 *
 * All adopted positions carry full metadata:
 *   origin = 'adopted_at_startup'
 *   managed = true (supported) / false (unsupported)
 *   supported_universe = true / false
 *   strategy_tag = 'unassigned' — not core/tactical until explicitly classified
 *   adoption_timestamp = now()
 *   current_mark_price = live price at adoption time
 *   estimated_market_value = qty × current_mark_price
 *
 * Positions are created in ALL modes (paper/shadow/live).
 * The positions table is the source of truth for what the bot manages.
 * In paper/shadow mode, orders are simulated but positions are real DB records.
 *
 * Idempotent: a completed adoption_run blocks re-import. Use force=true to re-run.
 *
 * Safety rules enforced here:
 *   - No position is created with qty = 0
 *   - Dust balances below MIN_HOLDING_KRW are ignored
 *   - Historical fill data unavailability does NOT block adoption
 *     (avg_cost_krw left as null or taken from Upbit avg_buy_price if available)
 *   - Adopted positions start as 'unassigned' to avoid premature tactical selling
 */

const upbit = require('./upbit');
const { normalizeSymbol } = require('./reconciliationEngine');

const MIN_HOLDING_KRW = 1000; // ignore dust holdings below this KRW threshold

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCompletedAdoption(supabase) {
  try {
    const { data } = await supabase.from('adoption_runs')
      .select('*').eq('status', 'complete')
      .order('run_at', { ascending: false }).limit(1).single();
    return data ?? null;
  } catch (_) {
    return null;
  }
}

async function openPositionExists(supabase, asset) {
  try {
    const { data } = await supabase.from('positions')
      .select('position_id').eq('asset', asset)
      .in('state', ['open', 'adopted', 'partial'])
      .limit(1).single();
    return data != null;
  } catch (_) {
    return false;
  }
}

/**
 * Fetch current mark price for an asset.
 * Returns null if unavailable — adoption continues regardless.
 */
async function fetchMarkPrice(asset) {
  try {
    const tickers = await upbit.getTicker([`KRW-${asset}`]);
    return tickers?.[0]?.trade_price ?? null;
  } catch (_) {
    return null;
  }
}

// ─── Main adoption ────────────────────────────────────────────────────────────

/**
 * Run first-deployment portfolio adoption.
 *
 * @param {SupabaseClient} supabase
 * @param {string[]}       supportedCoins
 * @param {string}         mode           — 'paper' | 'shadow' | 'live'
 * @param {boolean}        force          — re-run even if completed run exists
 * @returns {{
 *   alreadyDone, adopted, unsupported, skipped,
 *   krwBalance, runId, portfolioState
 * }}
 */
async function runAdoption(supabase, supportedCoins = ['BTC', 'ETH', 'SOL'], mode = 'paper', force = false) {

  // ── Idempotency check ──────────────────────────────────────────────────────
  if (!force) {
    const existing = await getCompletedAdoption(supabase);
    if (existing) {
      console.log(`[adoption] Previously completed (run ${existing.id} at ${existing.run_at}) — skipping`);
      return {
        alreadyDone:    true,
        adopted:        existing.adopted_assets    ?? [],
        unsupported:    existing.unsupported_assets ?? [],
        skipped:        [],
        krwBalance:     null,
        runId:          existing.id,
        portfolioState: null,
      };
    }
  }

  // ── Create pending run record ──────────────────────────────────────────────
  let runId = null;
  try {
    const { data } = await supabase.from('adoption_runs')
      .insert({ status: 'pending' }).select('id').single();
    runId = data?.id ?? null;
  } catch (_) {}

  console.log(`\n[adoption] ── Starting portfolio adoption (run=${runId} mode=${mode})`);

  const adopted     = [];  // supported assets imported as positions
  const unsupported = [];  // assets outside strategy universe (excluded)
  const skipped     = [];  // supported but already had a position
  const now         = new Date().toISOString();

  // In-memory portfolio state built during adoption
  const portfolioState = {
    krwBalance:       0,
    supportedHoldings: {},  // { BTC: { qty, avgCost, markPrice, value } }
    unsupportedHoldings: [],
    totalValueKrw:    0,
  };

  try {
    // ── 1. Fetch live Upbit balances ─────────────────────────────────────────
    const accounts = await upbit.getAccounts();
    console.log(`[adoption] Exchange returned ${accounts.length} account entries`);

    // Collect KRW first
    const krwAcc = accounts.find((a) => a.currency === 'KRW');
    portfolioState.krwBalance = Number(krwAcc?.balance ?? 0);

    // ── 2. Process each non-KRW holding ─────────────────────────────────────
    for (const acc of accounts) {
      if (acc.currency === 'KRW') continue;

      // ── Normalise symbol using the 3-state classifier ───────────────────
      const classification = normalizeSymbol(acc.currency);

      if (classification.type === 'invalid') {
        // Structurally unmappable — record but do not block adoption.
        // The reconciliation check will catch this and may freeze trading.
        console.warn(`[adoption] INVALID symbol: ${acc.currency} — skipping, reconciliation will handle freeze`);
        skipped.push({ currency: acc.currency ?? '(empty)', reason: 'symbol_normalization_failed' });
        continue;
      }

      const symbol    = classification.symbol;
      const qty       = Number(acc.balance ?? 0) + Number(acc.locked ?? 0);
      const avgBuyKrw = Number(acc.avg_buy_price ?? 0);

      // ── 3. Fetch live mark price ─────────────────────────────────────────
      let markPrice = (classification.type === 'supported') ? await fetchMarkPrice(symbol) : null;
      if (markPrice == null && avgBuyKrw > 0) markPrice = avgBuyKrw;

      const estimatedValue = markPrice ? qty * markPrice : (avgBuyKrw ? qty * avgBuyKrw : null);

      // Skip dust
      if (qty <= 0 || (estimatedValue != null && estimatedValue < MIN_HOLDING_KRW)) {
        console.log(`[adoption] DUST skip: ${symbol} qty=${qty} value≈₩${Math.round(estimatedValue ?? 0)}`);
        continue;
      }

      // ── 4. Classify using normalizeSymbol result ─────────────────────────
      const isSupported = classification.type === 'supported' && supportedCoins.includes(symbol);

      if (!isSupported) {
        const entry = {
          currency:           symbol,
          original_currency:  acc.currency,
          balance:            qty,
          avg_buy_price:      avgBuyKrw || null,
          mark_price:         markPrice,
          approx_value_krw:   estimatedValue,
          managed:            false,
          supported_universe: false,
        };
        unsupported.push(entry);
        portfolioState.unsupportedHoldings.push(entry);
        console.log(`[adoption] UNSUPPORTED: ${symbol} qty=${qty} ≈₩${Math.round(estimatedValue ?? 0)} — excluded`);

        try { await supabase.from('bot_events').insert({
          event_type:   'ADOPTION_UNSUPPORTED',
          severity:     'info',
          subsystem:    'portfolio_adopter',
          message:      `Excluded holding: ${symbol} qty=${qty} (not in strategy universe)`,
          context_json: entry,
          mode,
        }); } catch (_) {}
        continue;
      }

      // ── 5. Supported — check for existing position ───────────────────────
      const alreadyExists = await openPositionExists(supabase, symbol);
      if (alreadyExists) {
        skipped.push({ currency: symbol, qty, reason: 'position_already_exists' });
        console.log(`[adoption] SKIP ${symbol} — open position already exists`);
        continue;
      }

      // ── 6. Create adopted position (all modes) ────────────────────────────
      // Positions are created even in paper/shadow mode so they are managed.
      // avg_cost_krw: use Upbit's avg_buy_price if > 0; otherwise null (unknown history).
      const avgCostKrw = avgBuyKrw > 0 ? avgBuyKrw : null;

      let positionId = null;
      try {
        const { data: pos } = await supabase.from('positions').insert({
          asset:                  symbol,
          strategy_tag:           'unassigned',  // not core/tactical until operator classifies
          qty_open:               qty,
          qty_total:              qty,
          avg_cost_krw:           avgCostKrw,
          realized_pnl:           0,
          entry_reason:           'adopted_at_startup',
          state:                  'adopted',
          origin:                 'adopted_at_startup',
          managed:                true,
          supported_universe:     true,
          current_mark_price:     markPrice,
          estimated_market_value: estimatedValue,
          adoption_timestamp:     now,
          adoption_run_id:        runId,
        }).select('position_id').single();
        positionId = pos?.position_id ?? null;
      } catch (err) {
        console.error(`[adoption] Failed to create position for ${symbol}:`, err.message);
        skipped.push({ currency: symbol, qty, reason: `db_error: ${err.message}` });
        continue;
      }

      const entry = {
        currency:               symbol,
        qty,
        avg_cost_krw:           avgCostKrw,
        mark_price:             markPrice,
        estimated_market_value: estimatedValue,
        position_id:            positionId,
        strategy_tag:           'unassigned',
        origin:                 'adopted_at_startup',
        managed:                true,
        supported_universe:     true,
      };
      adopted.push(entry);
      portfolioState.supportedHoldings[symbol] = { qty, avgCost: avgCostKrw, markPrice, value: estimatedValue };
      if (estimatedValue) portfolioState.totalValueKrw += estimatedValue;

      console.log(`[adoption] ADOPTED: ${symbol} qty=${qty} avg=₩${Math.round(avgCostKrw ?? 0).toLocaleString()} mark=₩${Math.round(markPrice ?? 0).toLocaleString()} tag=unassigned pos=${positionId}`);

      try { await supabase.from('bot_events').insert({
        event_type:   'ADOPTION_IMPORT',
        severity:     'info',
        subsystem:    'portfolio_adopter',
        message:      `Adopted ${symbol}: qty=${qty} mark=₩${Math.round(markPrice ?? 0).toLocaleString()} value=₩${Math.round(estimatedValue ?? 0).toLocaleString()} tag=unassigned`,
        context_json: entry,
        mode,
      }); } catch (_) {}
    }

    portfolioState.totalValueKrw += portfolioState.krwBalance;

  } catch (err) {
    console.error('[adoption] Error:', err.message);
    try {
      await supabase.from('adoption_runs').update({
        status: 'failed', error_message: err.message,
        completed_at: new Date().toISOString(),
      }).eq('id', runId);
    } catch (_) {}

    return { alreadyDone: false, adopted, unsupported, skipped, krwBalance: portfolioState.krwBalance, runId, error: err.message };
  }

  // ── 7. Mark adoption complete ──────────────────────────────────────────────
  try {
    await supabase.from('adoption_runs').update({
      status:            'complete',
      adopted_count:      adopted.length,
      skipped_count:      skipped.length,
      unsupported_count:  unsupported.length,
      adopted_assets:     adopted,
      unsupported_assets: unsupported,
      completed_at:       new Date().toISOString(),
    }).eq('id', runId);
  } catch (_) {}

  // Persist adoption status for dashboard
  const statusPayload = {
    complete:            true,
    runId,
    mode,
    adoptedCount:        adopted.length,
    skippedCount:        skipped.length,
    unsupportedCount:    unsupported.length,
    adoptedAssets:       adopted,
    unsupportedAssets:   unsupported,
    krwBalance:          portfolioState.krwBalance,
    totalValueKrw:       portfolioState.totalValueKrw,
    completedAt:         now,
  };

  try {
    await supabase.from('app_settings').upsert({
      key:        'adoption_status',
      value:      statusPayload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}

  console.log(`[adoption] ✓ Complete — adopted=${adopted.length} unsupported=${unsupported.length} skipped=${skipped.length} KRW=₩${Math.round(portfolioState.krwBalance).toLocaleString()}`);

  return {
    alreadyDone: false, adopted, unsupported, skipped,
    krwBalance: portfolioState.krwBalance,
    runId, portfolioState,
  };
}

/**
 * Returns true if a completed adoption_run exists.
 * Used by pi-trader to gate cycle execution.
 */
async function isAdoptionComplete(supabase) {
  return (await getCompletedAdoption(supabase)) != null;
}

/**
 * Transition an adopted position to 'open' after the bot's first managed action.
 * Also marks it as strategy_tag = 'tactical' (the bot chose to exit/add so it's tactical).
 */
async function promoteAdoptedPosition(supabase, positionId) {
  try {
    await supabase.from('positions').update({
      state:        'open',
      strategy_tag: 'tactical', // first bot action classifies it as tactical
      updated_at:   new Date().toISOString(),
    }).eq('position_id', positionId).eq('state', 'adopted');
  } catch (_) {}
}

module.exports = {
  runAdoption,
  isAdoptionComplete,
  promoteAdoptedPosition,
  getCompletedAdoption,
};
