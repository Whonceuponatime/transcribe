/**
 * Portfolio Adopter — first-deployment safety module.
 *
 * On initial startup the bot queries the live Upbit account and classifies
 * every detected holding into one of three groups:
 *
 *   supported   — in the active coins list (BTC, ETH, SOL by default)
 *                 → imported as 'adopted' positions so the bot manages them
 *                 → NOT force-sold just because they pre-date the bot
 *
 *   unsupported — present in the account but not in the coins list
 *                 → recorded in bot_events and adoption_runs, never touched
 *
 *   cash (KRW)  — imported as part of portfolio state automatically via
 *                 getPortfolioState(); no special handling needed here
 *
 * Adoption is IDEMPOTENT: if a completed adoption_run already exists the
 * adopter returns immediately without creating duplicate positions.
 *
 * The bot waits for adoption to complete before placing any new orders.
 */

const upbit = require('./upbit');

const MIN_HOLDING_KRW = 1000; // ignore dust balances below this threshold

/**
 * Check whether a successful adoption has already been recorded.
 * Returns the completed run row or null.
 */
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

/**
 * Check if an open or adopted position already exists for an asset.
 */
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
 * Main adoption function.
 *
 * @param {SupabaseClient} supabase
 * @param {string[]}       supportedCoins  — e.g. ['BTC','ETH','SOL']
 * @param {string}         mode            — 'paper' | 'shadow' | 'live'
 * @param {boolean}        force           — re-run even if a completed run exists
 * @returns {{ alreadyDone, adopted, skipped, unsupported, runId }}
 */
async function runAdoption(supabase, supportedCoins = ['BTC', 'ETH', 'SOL'], mode = 'paper', force = false) {
  // ── Idempotency check ──────────────────────────────────────────────────────
  if (!force) {
    const existing = await getCompletedAdoption(supabase);
    if (existing) {
      console.log(`[adoption] Already complete (run ${existing.id} at ${existing.run_at}) — skipping`);
      return {
        alreadyDone: true,
        adopted:     existing.adopted_assets    ?? [],
        skipped:     [],
        unsupported: existing.unsupported_assets ?? [],
        runId:       existing.id,
      };
    }
  }

  // ── Create pending adoption_run record ────────────────────────────────────
  let runId = null;
  try {
    const { data: runRow } = await supabase.from('adoption_runs')
      .insert({ status: 'pending' }).select('id').single();
    runId = runRow?.id ?? null;
  } catch (_) {}

  console.log(`[adoption] Starting first-deployment adoption (run ${runId}, mode=${mode})`);

  const adopted     = [];
  const skipped     = [];
  const unsupported = [];
  let   hadError    = false;

  try {
    // ── Fetch live Upbit balances ────────────────────────────────────────────
    const accounts = await upbit.getAccounts();

    for (const acc of accounts) {
      const currency = acc.currency;
      if (currency === 'KRW') continue; // cash handled separately

      const qty        = Number(acc.balance ?? 0);
      const avgBuyKrw  = Number(acc.avg_buy_price ?? 0);

      // Skip dust
      const approxValueKrw = qty * avgBuyKrw;
      if (qty <= 0 || approxValueKrw < MIN_HOLDING_KRW) continue;

      // ── Classify the holding ──────────────────────────────────────────────
      if (!supportedCoins.includes(currency)) {
        // Unsupported asset — record but do not touch
        unsupported.push({ currency, balance: qty, avg_buy_price: avgBuyKrw, approx_value_krw: approxValueKrw });
        console.log(`[adoption] UNSUPPORTED: ${currency} qty=${qty} (₩${Math.round(approxValueKrw).toLocaleString()}) — will not be managed`);
        await supabase.from('bot_events').insert({
          event_type:   'ADOPTION_UNSUPPORTED',
          severity:     'info',
          subsystem:    'portfolio_adopter',
          message:      `Unsupported holding detected: ${currency} qty=${qty}`,
          context_json: { currency, qty, avg_buy_price: avgBuyKrw, approx_value_krw: approxValueKrw },
          mode,
        }).catch(() => {});
        continue;
      }

      // ── Supported asset — import or skip if position already exists ───────
      const alreadyExists = await openPositionExists(supabase, currency);
      if (alreadyExists) {
        skipped.push({ currency, qty, reason: 'position_already_exists' });
        console.log(`[adoption] SKIP ${currency} — open position already exists`);
        continue;
      }

      // Create adopted position
      let positionId = null;
      if (mode !== 'paper' && mode !== 'shadow') {
        // Live mode: actually persist the position
        try {
          const { data: pos } = await supabase.from('positions').insert({
            asset:          currency,
            strategy_tag:   'tactical',
            qty_open:       qty,
            qty_total:      qty,
            avg_cost_krw:   avgBuyKrw,
            realized_pnl:   0,
            entry_reason:   'adoption_import',
            state:          'adopted',
            adoption_run_id: runId,
          }).select('position_id').single();
          positionId = pos?.position_id ?? null;
        } catch (err) {
          console.error(`[adoption] Failed to create position for ${currency}:`, err.message);
          skipped.push({ currency, qty, reason: `db_error: ${err.message}` });
          continue;
        }
      } else {
        // Paper/shadow: log what would happen
        await supabase.from('bot_events').insert({
          event_type:   'ADOPTION_WOULD_IMPORT',
          severity:     'info',
          subsystem:    'portfolio_adopter',
          message:      `[${mode.toUpperCase()}] Would adopt ${currency} qty=${qty} avg=₩${Math.round(avgBuyKrw).toLocaleString()}`,
          context_json: { currency, qty, avg_buy_price: avgBuyKrw },
          mode,
        }).catch(() => {});
      }

      adopted.push({ currency, qty, avg_cost_krw: avgBuyKrw, position_id: positionId, approx_value_krw: approxValueKrw });
      console.log(`[adoption] ADOPTED: ${currency} qty=${qty} avg=₩${Math.round(avgBuyKrw).toLocaleString()} (₩${Math.round(approxValueKrw).toLocaleString()}) position=${positionId}`);

      await supabase.from('bot_events').insert({
        event_type:   'ADOPTION_IMPORT',
        severity:     'info',
        subsystem:    'portfolio_adopter',
        message:      `Adopted ${currency}: qty=${qty} avg_cost=₩${Math.round(avgBuyKrw).toLocaleString()} value=₩${Math.round(approxValueKrw).toLocaleString()}`,
        context_json: { currency, qty, avg_cost_krw: avgBuyKrw, position_id: positionId },
        mode,
      }).catch(() => {});
    }

  } catch (err) {
    hadError = true;
    console.error('[adoption] Error fetching accounts:', err.message);
    await supabase.from('adoption_runs').update({
      status: 'failed',
      error_message: err.message,
      completed_at: new Date().toISOString(),
    }).eq('id', runId).catch(() => {});

    return { alreadyDone: false, adopted, skipped, unsupported, runId, error: err.message };
  }

  // ── Mark adoption complete ─────────────────────────────────────────────────
  await supabase.from('adoption_runs').update({
    status:            'complete',
    adopted_count:      adopted.length,
    skipped_count:      skipped.length,
    unsupported_count:  unsupported.length,
    adopted_assets:     adopted,
    unsupported_assets: unsupported,
    completed_at:       new Date().toISOString(),
  }).eq('id', runId).catch(() => {});

  // Persist summary to app_settings for cheap dashboard reads
  await supabase.from('app_settings').upsert({
    key:   'adoption_status',
    value: {
      complete:         true,
      runId,
      adoptedCount:     adopted.length,
      skippedCount:     skipped.length,
      unsupportedCount: unsupported.length,
      unsupportedAssets: unsupported,
      adoptedAssets:    adopted,
      completedAt:      new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' }).catch(() => {});

  console.log(`[adoption] Complete — adopted=${adopted.length} skipped=${skipped.length} unsupported=${unsupported.length}`);

  return { alreadyDone: false, adopted, skipped, unsupported, runId };
}

/**
 * Returns true if the adoption step has been completed (any mode).
 * Used by the cycle runner to block trading until adoption is done.
 */
async function isAdoptionComplete(supabase) {
  const existing = await getCompletedAdoption(supabase);
  return existing != null;
}

/**
 * Transition an adopted position to 'open' after its first bot-managed action.
 * This signals the position is now fully under bot control.
 */
async function promoteAdoptedPosition(supabase, positionId) {
  try {
    await supabase.from('positions').update({
      state:      'open',
      updated_at: new Date().toISOString(),
    }).eq('position_id', positionId).eq('state', 'adopted');
  } catch (_) {}
}

module.exports = {
  runAdoption,
  isAdoptionComplete,
  promoteAdoptedPosition,
  getCompletedAdoption,
};
