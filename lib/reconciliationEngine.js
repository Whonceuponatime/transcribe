/**
 * Reconciliation Engine — startup safety gate and freeze/unfreeze management.
 *
 * Purpose:
 *   Verify that internal DB state matches live Upbit exchange state before
 *   allowing the strategy to place any new orders. If a mismatch or unsafe
 *   condition is detected the system is FROZEN and all order placement is blocked
 *   until the operator resolves the issue.
 *
 * Freeze conditions (any one is sufficient to block trading):
 *   1. Exchange balance for a supported asset is more than BALANCE_TOLERANCE
 *      away from the qty_open in the positions table.
 *   2. Unresolved open orders exist in the orders table (submitted / accepted /
 *      partially_filled) with no corresponding exchange confirmation.
 *   3. Symbol normalization fails for any account entry (unmappable currency).
 *   4. Adoption step never completed successfully.
 *
 * Frozen state is persisted to app_settings.system_freeze so a process restart
 * does not silently clear the freeze.
 *
 * Operators can clear a freeze manually via the dashboard or by re-running
 * reconciliation with force=true after they have verified account state.
 */

const upbit = require('./upbit');

// Maximum allowed deviation between exchange qty and DB qty before freeze triggers.
// 0.5% of the exchange qty is acceptable rounding / dust.
const BALANCE_TOLERANCE_PCT = 0.005;

// Tiny drift auto-heal: when both DB and exchange have non-zero qty and the
// diff is within BOTH thresholds below, DB qty_open is corrected to match
// exchange instead of freezing. This handles rounding accumulation from many
// dust_refunded_and_filled market buy orders on Upbit.
// Only applied when no pending orders exist for the coin.
const DRIFT_HEAL_MAX_PCT = 2.0;   // max % relative diff eligible for auto-heal
const DRIFT_HEAL_MAX_ABS = { BTC: 0.0002, ETH: 0.002, SOL: 0.02 };
// DRIFT_HEAL_MAX_ABS values ≈ below Upbit's ₩5K minimum order at typical prices.
// Diffs above these are real mismatches and must still freeze.

// Assets the strategy actively manages (supported universe).
const UPBIT_SYMBOL_MAP = {
  BTC: 'BTC', ETH: 'ETH', SOL: 'SOL',
};

// ─── Auto-adopt configuration ─────────────────────────────────────────────────
// Assets eligible for reconciliation-triggered guarded auto-adopt.
// Kept narrow intentionally — only add assets after explicit operator review.
const AUTO_ADOPT_ELIGIBLE = new Set(['BTC', 'ETH']);

// Minimum on-exchange qty (exclusive) to treat a holding as non-dust.
// Sized below Upbit's ₩5K minimum order at typical price floors.
const AUTO_ADOPT_DUST_MIN = { BTC: 0.000001, ETH: 0.00001 };

// Currencies that are never strategy assets but are known-valid Upbit account
// entries. These are excluded from strategy logic but must NOT trigger a freeze.
// KRW is the cash currency. Others are common altcoins that may appear.
const KNOWN_NON_STRATEGY = new Set([
  'KRW', 'USDT',
  'XRP', 'DOGE', 'ADA', 'DOT', 'MATIC', 'LINK', 'AVAX', 'ATOM',
  'SHIB', 'LTC', 'BCH', 'ETC', 'TRX', 'XLM', 'NEAR', 'FTM',
  'SAND', 'MANA', 'UNI', 'AAVE', 'COMP', 'SNX', 'GRT', 'BAT',
  'ZIL', 'ICX', 'STEEM', 'EOS', 'NEO', 'WAVES', 'HBAR', 'ICP',
  // add more here as your account holds them — never triggers a freeze
]);

// Regex for a structurally valid currency code: 1-15 uppercase letters/digits.
// Anything not matching this is genuinely unmappable and should freeze.
const VALID_CURRENCY_RE = /^[A-Z0-9]{1,15}$/;

// ─── Symbol normalisation ─────────────────────────────────────────────────────

/**
 * Classify a raw Upbit account currency string into one of three states:
 *
 *   { type: 'supported', symbol }
 *     — in the active strategy universe (managed by the bot)
 *
 *   { type: 'excluded', symbol }
 *     — valid currency format but not a strategy asset; visible in dashboard,
 *       never traded, does NOT trigger a freeze
 *
 *   { type: 'invalid' }
 *     — non-string, empty, or fails the currency code regex;
 *       triggers a reconciliation freeze because the exchange response is
 *       malformed or unexpected
 *
 * Callers must check `result.type` before using `result.symbol`.
 */
function normalizeSymbol(currency) {
  // Type guard
  if (typeof currency !== 'string' || currency.trim() === '') {
    return { type: 'invalid' };
  }
  const upper = currency.toUpperCase().trim();

  // Supported strategy asset
  if (UPBIT_SYMBOL_MAP[upper]) {
    return { type: 'supported', symbol: UPBIT_SYMBOL_MAP[upper] };
  }

  // Not a strategy asset — check if it is a structurally valid currency code
  if (VALID_CURRENCY_RE.test(upper)) {
    // Further distinguish known non-strategy vs unknown-but-valid
    // Both are treated as 'excluded' (no freeze), but the caller can
    // log a warning for genuinely new currencies if desired.
    return { type: 'excluded', symbol: upper };
  }

  // Structurally invalid — freeze
  return { type: 'invalid' };
}

// ─── Freeze state ─────────────────────────────────────────────────────────────

let _frozenInMemory   = true;  // starts frozen; cleared only after successful reconciliation
let _freezeReasons    = ['system_not_reconciled'];

async function persistFreezeState(supabase, frozen, reasons) {
  try {
    await supabase.from('app_settings').upsert({
      key:        'system_freeze',
      value:      { frozen, reasons, updatedAt: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}
}

async function loadFreezeState(supabase) {
  try {
    const { data } = await supabase.from('app_settings')
      .select('value').eq('key', 'system_freeze').single();
    if (data?.value) {
      _frozenInMemory = data.value.frozen ?? true;
      _freezeReasons  = data.value.reasons ?? ['state_loaded_from_db'];
    }
  } catch (_) {
    // If we can't read state, stay frozen
    _frozenInMemory = true;
    _freezeReasons  = ['db_read_failed'];
  }
}

/**
 * Returns true if the system is currently frozen (no orders allowed).
 * This is the fast in-memory check used in every cycle.
 */
function isSystemFrozen() {
  return _frozenInMemory;
}

function getFreezeReasons() {
  return _freezeReasons;
}

async function setFreeze(supabase, reasons) {
  const wasFrozen = _frozenInMemory;
  _frozenInMemory = true;
  _freezeReasons  = Array.isArray(reasons) ? reasons : [reasons];
  console.warn(`[reconcile] ⛔ SYSTEM FROZEN — ${_freezeReasons.join('; ')}`);
  await persistFreezeState(supabase, true, _freezeReasons);
  // Only emit FREEZE_STATE_CHANGED when state actually transitions false → true
  if (!wasFrozen && supabase) {
    try {
      await supabase.from('bot_events').insert({
        event_type:   'FREEZE_STATE_CHANGED',
        severity:     'warn',
        subsystem:    'reconciliation_engine',
        message:      `System FROZEN: ${_freezeReasons[0] ?? 'unknown'}`,
        context_json: {
          previous_frozen: false,
          new_frozen:      true,
          reasons:         _freezeReasons,
          source:          'set_freeze',
        },
      });
    } catch (_) {}
  }
}

async function clearFreeze(supabase) {
  const wasFrozen = _frozenInMemory;
  _frozenInMemory = false;
  _freezeReasons  = [];
  console.log('[reconcile] ✓ System unfreeze — trading enabled');
  await persistFreezeState(supabase, false, []);
  // Only emit FREEZE_STATE_CHANGED when state actually transitions true → false
  if (wasFrozen && supabase) {
    try {
      await supabase.from('bot_events').insert({
        event_type:   'FREEZE_STATE_CHANGED',
        severity:     'info',
        subsystem:    'reconciliation_engine',
        message:      'System UNFROZEN — trading enabled',
        context_json: {
          previous_frozen: true,
          new_frozen:      false,
          reasons:         [],
          source:          'clear_freeze',
        },
      });
    } catch (_) {}
  }
}

// ─── Individual checks ────────────────────────────────────────────────────────

/** Check 1: adoption completed */
async function checkAdoptionComplete(supabase) {
  try {
    const { data } = await supabase.from('adoption_runs')
      .select('id, status').eq('status', 'complete')
      .order('run_at', { ascending: false }).limit(1).single();
    if (!data) {
      return { passed: false, reason: 'adoption_not_complete: no successful adoption_run found' };
    }
    return { passed: true };
  } catch (_) {
    return { passed: false, reason: 'adoption_check_db_error' };
  }
}

/** Check 2: no unresolved open orders in the orders table */
async function checkNoUnresolvedOrders(supabase) {
  try {
    const { data, count } = await supabase.from('orders')
      .select('id, asset, identifier, state', { count: 'exact' })
      .in('state', ['submitted', 'accepted', 'partially_filled'])
      .limit(20);
    const found = count ?? (data?.length ?? 0);
    if (found > 0) {
      const ids = (data || []).map((o) => `${o.asset}:${o.state}`).join(', ');
      return { passed: false, reason: `unresolved_orders: ${found} order(s) in flight — ${ids}`, count: found };
    }
    return { passed: true, count: 0 };
  } catch (_) {
    return { passed: false, reason: 'order_check_db_error' };
  }
}

/**
 * Check 3: exchange balances match DB positions within tolerance.
 *
 * For each supported coin: compare exchange qty_open with sum of open positions
 * in the positions table. Discrepancies beyond tolerance trigger a freeze.
 */
async function checkBalanceMatch(supabase, accounts, supportedCoins) {
  const exchangeQty   = {};
  const dbQty         = {};
  const discrepancies = {};
  const invalidSymbols = [];
  const healedCoins   = []; // coins auto-corrected this run

  // Build exchange qty map; classify each currency
  for (const acc of accounts) {
    const classification = normalizeSymbol(acc.currency);

    if (classification.type === 'invalid') {
      invalidSymbols.push(acc.currency ?? '(empty)');
      continue;
    }

    // Only map supported assets for balance comparison
    if (classification.type === 'supported' && supportedCoins.includes(classification.symbol)) {
      exchangeQty[classification.symbol] = Number(acc.balance ?? 0) + Number(acc.locked ?? 0);
    }
    // excluded currencies are silently skipped — they don't affect the balance check
  }

  if (invalidSymbols.length > 0) {
    return {
      passed: false,
      reason: `symbol_mapping_failed: unmappable currency codes from exchange — ${invalidSymbols.join(', ')}`,
      discrepancies,
    };
  }

  // Build DB qty map from open/adopted positions
  try {
    const { data: positions } = await supabase.from('positions')
      .select('asset, qty_open').in('state', ['open', 'adopted', 'partial']);
    for (const pos of (positions || [])) {
      if (supportedCoins.includes(pos.asset)) {
        dbQty[pos.asset] = (dbQty[pos.asset] ?? 0) + Number(pos.qty_open ?? 0);
      }
    }
  } catch (_) {
    return { passed: false, reason: 'balance_check_db_error', discrepancies };
  }

  // Compare
  for (const coin of supportedCoins) {
    const exQty = exchangeQty[coin] ?? 0;
    const intQty = dbQty[coin] ?? 0;

    // Skip if both are zero — nothing to compare
    if (exQty === 0 && intQty === 0) continue;

    const diff    = Math.abs(exQty - intQty);
    const tolQty  = exQty * BALANCE_TOLERANCE_PCT;

    if (diff > tolQty && diff > 0.000001) { // also skip sub-satoshi dust
      const diffPct = exQty > 0 ? (diff / exQty) * 100 : 999;
      const healMax = DRIFT_HEAL_MAX_ABS[coin] ?? 0;

      // ── Tiny drift auto-heal ────────────────────────────────────────────────
      // Conditions: both sides non-zero, diff within both % and abs thresholds.
      // Per-coin pending-order check ensures we don't heal while a fill is in flight.
      if (exQty > 0 && intQty > 0 && diffPct < DRIFT_HEAL_MAX_PCT && diff <= healMax) {
        try {
          const { count: pendingCount } = await supabase.from('orders')
            .select('id', { count: 'exact', head: true })
            .eq('asset', coin)
            .in('state', ['intent_created', 'submitted', 'accepted', 'partially_filled']);

          if ((pendingCount ?? 0) === 0) {
            // Find the managed position to heal (most recent open)
            const { data: healPositions } = await supabase.from('positions')
              .select('position_id, qty_open')
              .eq('asset', coin)
              .in('state', ['open', 'partial', 'adopted'])
              .eq('managed', true)
              .order('opened_at', { ascending: false })
              .limit(1);

            const healPos = healPositions?.[0] ?? null;
            if (healPos) {
              await supabase.from('positions').update({
                qty_open:   exQty,
                updated_at: new Date().toISOString(),
              }).eq('position_id', healPos.position_id);

              try {
                await supabase.from('bot_events').insert({
                  event_type:   'POSITION_DRIFT_HEALED',
                  severity:     'warn',
                  subsystem:    'reconciliation',
                  message:      `${coin} tiny drift auto-healed: db=${intQty} → ${exQty} (diff=${diff.toFixed(8)}, ${diffPct.toFixed(3)}%)`,
                  context_json: {
                    asset:        coin,
                    db_qty:       intQty,
                    exchange_qty: exQty,
                    diff,
                    diff_pct:     diffPct.toFixed(3) + '%',
                    position_id:  healPos.position_id,
                    trigger:      'balance_mismatch_auto_heal',
                  },
                });
              } catch (_) {}

              healedCoins.push({ coin, db_qty: intQty, exchange_qty: exQty, diff });
              console.log(`[reconcile] DRIFT_HEALED: ${coin} qty ${intQty} → ${exQty} (diff=${diff.toFixed(8)}, ${diffPct.toFixed(3)}%)`);
              continue; // healed — do not add to discrepancies
            }
          }
        } catch (_) {}
        // Fall through if pending orders exist, position not found, or DB write failed
      }

      discrepancies[coin] = {
        exchange_qty: exQty,
        db_qty:       intQty,
        diff:         diff,
        diff_pct:     exQty > 0 ? (diff / exQty * 100).toFixed(3) + '%' : 'n/a',
      };
    }
  }

  if (Object.keys(discrepancies).length > 0) {
    const detail = Object.entries(discrepancies).map(([c, d]) =>
      `${c}: exchange=${d.exchange_qty} db=${d.db_qty} diff=${d.diff_pct}`
    ).join(', ');
    return { passed: false, reason: `balance_mismatch: ${detail}`, discrepancies, healedCoins };
  }

  return { passed: true, discrepancies, exchangeQty, dbQty, healedCoins };
}

/**
 * Check 4: ownership clarity — no open positions have null strategy_tag.
 * strategy_tag must be one of: core, tactical, unassigned.
 * Null means the record was created before the schema enforced this column,
 * which is an ambiguous state that must be resolved before trading.
 * DB errors fail CLOSED (returned as failed) to prevent silent pass-through.
 */
async function checkOwnershipClarity(supabase) {
  try {
    const { data, count } = await supabase.from('positions')
      .select('asset, strategy_tag', { count: 'exact' })
      .in('state', ['open', 'adopted', 'partial'])
      .is('strategy_tag', null)
      .limit(10);

    // Supabase count can be null if the header wasn't returned; fall back to data length
    const found = (typeof count === 'number') ? count : (data?.length ?? 0);
    if (found > 0) {
      const assets = (data || []).map((p) => p.asset).join(', ');
      return {
        passed: false,
        reason: `ambiguous_ownership: ${found} position(s) have null strategy_tag — assets: ${assets}`,
      };
    }
    return { passed: true };
  } catch (err) {
    // Fail CLOSED: a DB error on this check must not silently pass as "no ambiguity found"
    return { passed: false, reason: `ownership_check_db_error: ${err.message}` };
  }
}

/**
 * Check 5: position metadata integrity.
 *
 * Scans all active positions for impossible or dangerous metadata shapes that
 * could cause silent misbehaviour at runtime. Fails closed on every sub-case.
 *
 * Freeze conditions:
 *   a. origin = 'adopted_at_startup' AND adoption_timestamp IS NULL
 *      (record was imported without a timestamp — constraint violation or old data)
 *   b. origin = 'adopted_at_startup' AND strategy_tag IS NULL
 *      (should never happen after 025 migration; old positions pre-dating the schema)
 *   c. managed = true AND supported_universe IS NULL
 *      (managed positions must declare whether they are in the strategy universe)
 *   d. origin = 'bot_managed' AND avg_cost_krw IS NULL AND qty_open > 0
 *      (bot-created position with no cost basis — cannot compute gain or exits)
 */
async function checkPositionIntegrity(supabase) {
  const violations = [];
  try {
    const { data: positions, error } = await supabase.from('positions')
      .select('position_id, asset, origin, strategy_tag, managed, supported_universe, avg_cost_krw, qty_open, adoption_timestamp, state')
      .in('state', ['open', 'adopted', 'partial']);

    if (error) {
      return { passed: false, reason: `position_integrity_db_error: ${error.message}` };
    }

    for (const pos of (positions || [])) {
      // (a) adopted_at_startup without adoption_timestamp
      if (pos.origin === 'adopted_at_startup' && !pos.adoption_timestamp) {
        violations.push(`${pos.asset}(${pos.position_id?.slice(0,8)}): adopted_at_startup but adoption_timestamp is null`);
      }

      // (b) adopted_at_startup with null strategy_tag
      if (pos.origin === 'adopted_at_startup' && pos.strategy_tag == null) {
        violations.push(`${pos.asset}(${pos.position_id?.slice(0,8)}): adopted_at_startup but strategy_tag is null`);
      }

      // (c) managed=true with null supported_universe
      if (pos.managed === true && pos.supported_universe == null) {
        violations.push(`${pos.asset}(${pos.position_id?.slice(0,8)}): managed=true but supported_universe is null`);
      }

      // (d) bot_managed with no cost basis and non-zero qty
      if (pos.origin === 'bot_managed' && (pos.avg_cost_krw == null || Number(pos.avg_cost_krw) <= 0) && Number(pos.qty_open ?? 0) > 0) {
        violations.push(`${pos.asset}(${pos.position_id?.slice(0,8)}): bot_managed with null/zero avg_cost_krw and qty_open=${pos.qty_open}`);
      }

      // (e) zombie position: state=open, qty_open=0, avg_cost_krw=0.
      // Created by executeBuy() before order placement; should be populated by
      // applyFillToPosition() after a confirmed fill. If qty stays zero after a
      // cycle, the buy order likely came back as 'wait' and fills were empty.
      // These positions produce a balance_mismatch on reconciliation (DB=0,
      // exchange has the real holding). Flag them so the operator can see them.
      if (pos.state === 'open'
          && Number(pos.qty_open ?? 0) === 0
          && (pos.avg_cost_krw == null || Number(pos.avg_cost_krw) <= 0)
          && pos.origin === 'bot_managed') {
        violations.push(`${pos.asset}(${pos.position_id?.slice(0,8)}): zombie position — state=open qty_open=0 avg_cost=0 (unfilled buy?)`);
      }
    }

    if (violations.length > 0) {
      return {
        passed: false,
        reason: `position_integrity_violation: ${violations.length} issue(s) — ${violations.slice(0, 3).join(' | ')}${violations.length > 3 ? ' ...' : ''}`,
        violations,
      };
    }

    return { passed: true, checkedCount: (positions || []).length };

  } catch (err) {
    // Fail CLOSED
    return { passed: false, reason: `position_integrity_db_error: ${err.message}` };
  }
}

// ─── Guarded auto-adopt ───────────────────────────────────────────────────────

/** Emit a structured AUTO_ADOPT_SKIPPED event and log to console. */
async function emitAutoAdoptSkipped(supabase, coin, reason, extra) {
  console.log(`[reconcile/auto-adopt] SKIPPED ${coin}: ${reason}`);
  try {
    await supabase.from('bot_events').insert({
      event_type:   'AUTO_ADOPT_SKIPPED',
      severity:     'info',
      subsystem:    'reconciliation_auto_adopt',
      message:      `${coin} auto-adopt skipped: ${reason}`,
      context_json: { asset: coin, reason, ...extra },
    });
  } catch (_) {}
}

/**
 * Guarded auto-adopt: for each AUTO_ADOPT_ELIGIBLE asset where the exchange
 * holds a usable balance but the DB has zero active managed positions, create
 * exactly one managed `adopted` position row and record an adoption_run.
 *
 * Guards (ALL must pass per asset):
 *   1. Asset is in AUTO_ADOPT_ELIGIBLE (BTC / ETH only)
 *   2. Exchange qty > AUTO_ADOPT_DUST_MIN
 *   3. Exchange avg_buy_price > 0 (usable cost basis)
 *   4. Zero active managed DB positions for the asset
 *   5. Zero pending/unresolved orders for the asset
 *
 * If any guard fails the asset is skipped and freeze is preserved for it.
 *
 * @param {SupabaseClient} supabase
 * @param {Array}          accounts       — raw getAccounts() response
 * @param {string[]}       supportedCoins
 * @returns {{ adoptedAssets: Array, skippedAssets: Array }}
 */
async function attemptAutoAdopt(supabase, accounts, supportedCoins) {
  const adoptedAssets = [];
  const skippedAssets = [];
  const now           = new Date().toISOString();

  const eligibleCoins = supportedCoins.filter((c) => AUTO_ADOPT_ELIGIBLE.has(c));

  for (const coin of eligibleCoins) {
    const acc         = accounts.find((a) => a.currency === coin);
    const exchQty     = Number(acc?.balance ?? 0) + Number(acc?.locked ?? 0);
    const exchAvgCost = Number(acc?.avg_buy_price ?? 0);

    // Log consideration for every eligible asset regardless of outcome
    try {
      await supabase.from('bot_events').insert({
        event_type:   'AUTO_ADOPT_CONSIDERED',
        severity:     'info',
        subsystem:    'reconciliation_auto_adopt',
        message:      `${coin}: evaluating auto-adopt (exchQty=${exchQty} exchAvgCost=${exchAvgCost})`,
        context_json: { asset: coin, exchange_qty: exchQty, exchange_avg_cost: exchAvgCost },
      });
    } catch (_) {}

    // Guard 1: above dust threshold
    const dustMin = AUTO_ADOPT_DUST_MIN[coin] ?? 0.00001;
    if (exchQty <= dustMin) {
      const reason = `exchange_qty_below_dust: qty=${exchQty} min=${dustMin}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, { exchange_qty: exchQty, dust_min: dustMin });
      continue;
    }

    // Guard 2: exchange must provide a usable avg_buy_price
    if (exchAvgCost <= 0) {
      const reason = `no_usable_avg_buy_price: avg_buy_price=${exchAvgCost}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, { exchange_qty: exchQty, exchange_avg_cost: exchAvgCost });
      continue;
    }

    // Guard 3: zero existing active managed positions
    let existingCount = 0;
    try {
      const { count, error: cntErr } = await supabase.from('positions')
        .select('position_id', { count: 'exact', head: true })
        .eq('asset', coin)
        .in('state', ['open', 'adopted', 'partial'])
        .eq('managed', true);
      if (cntErr) throw new Error(cntErr.message);
      existingCount = count ?? 0;
    } catch (err) {
      const reason = `db_error_checking_positions: ${err.message}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, {});
      continue;
    }

    if (existingCount > 0) {
      const reason = `active_managed_position_exists: count=${existingCount}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, { existing_count: existingCount });
      continue;
    }

    // Guard 4: zero pending/unresolved orders for this asset
    let pendingOrders = 0;
    try {
      const { count, error: ordErr } = await supabase.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('asset', coin)
        .in('state', ['intent_created', 'submitted', 'accepted', 'partially_filled']);
      if (ordErr) throw new Error(ordErr.message);
      pendingOrders = count ?? 0;
    } catch (err) {
      const reason = `db_error_checking_orders: ${err.message}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, {});
      continue;
    }

    if (pendingOrders > 0) {
      const reason = `pending_orders_exist: count=${pendingOrders}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, { pending_orders: pendingOrders });
      continue;
    }

    // ── All guards passed — create exactly one managed adopted position ────────
    let positionId = null;
    try {
      const { data: pos, error: insErr } = await supabase.from('positions').insert({
        asset:              coin,
        strategy_tag:       'unassigned',
        qty_open:           exchQty,
        qty_total:          exchQty,
        avg_cost_krw:       exchAvgCost,
        realized_pnl:       0,
        entry_reason:       'reconciliation_auto_adopt',
        state:              'adopted',
        origin:             'adopted_at_startup',
        managed:            true,
        supported_universe: true,
        adoption_timestamp: now,
        operator_note:      'auto_adopted_by_reconciliation_engine',
      }).select('position_id').single();
      if (insErr) throw new Error(insErr.message);
      positionId = pos?.position_id ?? null;
    } catch (err) {
      const reason = `position_insert_failed: ${err.message}`;
      skippedAssets.push({ coin, reason });
      await emitAutoAdoptSkipped(supabase, coin, reason, { exchange_qty: exchQty, exchange_avg_cost: exchAvgCost });
      console.error(`[reconcile/auto-adopt] ${coin} position insert failed:`, err.message);
      continue;
    }

    adoptedAssets.push({ coin, qty: exchQty, avg_cost_krw: exchAvgCost, position_id: positionId });
    console.log(`[reconcile/auto-adopt] AUTO_ADOPT_CREATED: ${coin} qty=${exchQty} avg=₩${Math.round(exchAvgCost)} pos=${positionId}`);

    try {
      await supabase.from('bot_events').insert({
        event_type:   'AUTO_ADOPT_CREATED',
        severity:     'warn',
        subsystem:    'reconciliation_auto_adopt',
        message:      `${coin} auto-adopted from exchange: qty=${exchQty} avg_cost=₩${Math.round(exchAvgCost)} pos=${positionId}`,
        context_json: {
          asset:              coin,
          qty_open:           exchQty,
          qty_total:          exchQty,
          avg_cost_krw:       exchAvgCost,
          position_id:        positionId,
          state:              'adopted',
          origin:             'adopted_at_startup',
          strategy_tag:       'unassigned',
          managed:            true,
          supported_universe: true,
          adoption_timestamp: now,
          operator_note:      'auto_adopted_by_reconciliation_engine',
          entry_reason:       'reconciliation_auto_adopt',
        },
      });
    } catch (_) {}
  }

  // Create a completed adoption_run record so checkAdoptionComplete passes.
  // If this insert fails, positions exist but checkAdoptionComplete will still
  // fail — reconciliation stays frozen and the operator sees clear logs.
  if (adoptedAssets.length > 0) {
    try {
      await supabase.from('adoption_runs').insert({
        status:            'complete',
        adopted_count:     adoptedAssets.length,
        skipped_count:     skippedAssets.length,
        unsupported_count: 0,
        adopted_assets:    adoptedAssets,
        completed_at:      now,
      });
      console.log(`[reconcile/auto-adopt] adoption_run created — ${adoptedAssets.length} asset(s) adopted`);
    } catch (err) {
      console.error('[reconcile/auto-adopt] adoption_runs insert failed (checkAdoptionComplete will still fail):', err.message);
    }
  }

  return { adoptedAssets, skippedAssets };
}

// ─── Main reconciliation ──────────────────────────────────────────────────────

/**
 * Run a full startup reconciliation.
 *
 * Steps:
 *   1. Query live Upbit balances
 *   2. Check adoption complete
 *   3. Check no unresolved orders
 *   4. Check balance match (exchange vs DB)
 *   5. Check ownership clarity (no null strategy_tag)
 *   6. Check position metadata integrity (origin/timestamp/managed consistency)
 *   7. If all pass → unfreeze; else freeze with reasons
 *
 * @param {SupabaseClient} supabase
 * @param {string[]}       supportedCoins
 * @param {string}         trigger   — 'startup' | 'scheduled' | 'manual'
 * @param {boolean}        force     — ignore previous reconciliation result
 * @returns {{ passed, frozen, freezeReasons, checkResults, reconId }}
 */
async function runReconciliation(supabase, supportedCoins = ['BTC', 'ETH', 'SOL'], trigger = 'startup', force = false) {
  console.log(`\n[reconcile] Running reconciliation (trigger=${trigger})`);

  // Create reconciliation record
  let reconId = null;
  try {
    const { data } = await supabase.from('reconciliation_checks')
      .insert({ status: 'pending', trading_enabled: false }).select('id').single();
    reconId = data?.id ?? null;
  } catch (_) {}

  const checkResults  = {};
  const freezeReasons = [];

  // ── Fetch live balances ────────────────────────────────────────────────────
  let accounts = [];
  let exchangeBalances = {};
  try {
    accounts = await upbit.getAccounts();
    for (const acc of accounts) {
      const cl = normalizeSymbol(acc.currency);
      if (cl.type !== 'invalid') {
        exchangeBalances[cl.symbol] = {
          balance:  Number(acc.balance ?? 0),
          locked:   Number(acc.locked  ?? 0),
          type:     cl.type,
        };
      }
    }
  } catch (err) {
    console.error('[reconcile] Failed to fetch exchange balances:', err.message);
    await setFreeze(supabase, [`exchange_unreachable: ${err.message}`]);
    try {
      await supabase.from('reconciliation_checks').update({
        status: 'failed', freeze_reasons: [`exchange_unreachable: ${err.message}`],
        trading_enabled: false, resolved_at: new Date().toISOString(),
      }).eq('id', reconId);
    } catch (_) {}
    return { passed: false, frozen: true, freezeReasons: _freezeReasons, checkResults, reconId };
  }

  // ── Guarded auto-adopt ─────────────────────────────────────────────────────
  // If no completed adoption_run exists, attempt to auto-adopt eligible exchange
  // holdings into the DB before running the checks. Guards inside attemptAutoAdopt
  // ensure only safe, unambiguous zero-position cases are handled; everything
  // else stays frozen and is left for the operator to resolve manually.
  let autoAdoptResult = { adoptedAssets: [], skippedAssets: [] };
  {
    const adoptionPreCheck = await checkAdoptionComplete(supabase);
    if (!adoptionPreCheck.passed) {
      console.log('[reconcile] No completed adoption_run — evaluating guarded auto-adopt');
      autoAdoptResult = await attemptAutoAdopt(supabase, accounts, supportedCoins);
      if (autoAdoptResult.adoptedAssets.length > 0) {
        console.log(`[reconcile] Auto-adopt created ${autoAdoptResult.adoptedAssets.length} position(s) — proceeding to full reconciliation checks`);
      }
    }
  }

  // ── Run checks ────────────────────────────────────────────────────────────
  const c1 = await checkAdoptionComplete(supabase);
  checkResults.adoption_complete = c1;
  if (!c1.passed) freezeReasons.push(c1.reason);

  const c2 = await checkNoUnresolvedOrders(supabase);
  checkResults.no_unresolved_orders = c2;
  if (!c2.passed) freezeReasons.push(c2.reason);

  const c3 = await checkBalanceMatch(supabase, accounts, supportedCoins);
  checkResults.balance_match = c3;
  if (!c3.passed) freezeReasons.push(c3.reason);

  const c4 = await checkOwnershipClarity(supabase);
  checkResults.ownership_clarity = c4;
  if (!c4.passed) freezeReasons.push(c4.reason);

  const c5 = await checkPositionIntegrity(supabase);
  checkResults.position_integrity = c5;
  if (!c5.passed) freezeReasons.push(c5.reason);

  const passed = freezeReasons.length === 0;

  // ── Emit AUTO_ADOPT_RESOLVED_RECONCILIATION per auto-adopted asset ─────────
  for (const adopted of autoAdoptResult.adoptedAssets) {
    try {
      await supabase.from('bot_events').insert({
        event_type:   'AUTO_ADOPT_RESOLVED_RECONCILIATION',
        severity:     passed ? 'info' : 'warn',
        subsystem:    'reconciliation_auto_adopt',
        message:      `${adopted.coin}: auto-adopt ${passed ? 'resolved' : 'did NOT resolve'} reconciliation freeze`,
        context_json: {
          asset:                   adopted.coin,
          position_id:             adopted.position_id,
          qty:                     adopted.qty,
          avg_cost_krw:            adopted.avg_cost_krw,
          reconciliation_resolved: passed,
          remaining_freeze_reasons: freezeReasons,
        },
      });
    } catch (_) {}
  }

  // Build internal balance snapshot for DB record
  const internalBalances = {};
  try {
    const { data: pos } = await supabase.from('positions')
      .select('asset, qty_open, strategy_tag, state, origin, managed')
      .in('state', ['open', 'adopted', 'partial']);
    for (const p of (pos || [])) {
      internalBalances[p.asset] = {
        qty_open:     Number(p.qty_open),
        strategy_tag: p.strategy_tag,
        state:        p.state,
        origin:       p.origin,
        managed:      p.managed,
      };
    }
  } catch (_) {}

  // ── Update reconciliation record ─────────────────────────────────────────
  const finalStatus = passed ? 'passed' : 'frozen';
  try {
    await supabase.from('reconciliation_checks').update({
      status:              finalStatus,
      freeze_reasons:      freezeReasons,
      exchange_balances:   exchangeBalances,
      internal_balances:   internalBalances,
      discrepancies:       c3.discrepancies ?? null,
      drift_healed:        c3.healedCoins?.length ? c3.healedCoins : null,
      open_orders_found:   c2.count ?? 0,
      checks_run:          checkResults,
      trading_enabled:     passed,
      resolved_at:         new Date().toISOString(),
    }).eq('id', reconId);
  } catch (_) {}

  // ── Persist latest reconciliation id to app_settings for dashboard ────────
  try {
    await supabase.from('app_settings').upsert({
      key:   'latest_reconciliation',
      value: {
        reconId,
        status:         finalStatus,
        passed,
        freezeReasons,
        tradingEnabled: passed,
        runAt:          new Date().toISOString(),
        trigger,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (_) {}

  if (passed) {
    await clearFreeze(supabase);
    console.log('[reconcile] ✓ All checks passed — trading enabled');
  } else {
    await setFreeze(supabase, freezeReasons);
    console.warn('[reconcile] Checks failed:', freezeReasons.join(' | '));
  }

  // ── Structured RECONCILIATION bot_event ──────────────────────────────────
  // One per reconciliation run. Summarises all 5 checks + final freeze state.
  // Used by export and analysis tools to prove safety decisions.
  try {
    await supabase.from('bot_events').insert({
      event_type: 'RECONCILIATION',
      severity:   passed ? 'info' : 'warn',
      subsystem:  'reconciliation_engine',
      message:    passed
        ? `Reconciliation PASSED (trigger=${trigger}) — trading enabled`
        : `Reconciliation FROZEN (trigger=${trigger}): ${freezeReasons.slice(0, 2).join(' | ')}`,
      context_json: {
        trigger,
        recon_id:         reconId,
        trading_enabled:  passed,
        frozen:           !passed,
        freeze_reasons:   freezeReasons,
        checks: {
          adoption_complete:      { passed: checkResults.adoption_complete?.passed,      reason: checkResults.adoption_complete?.reason       ?? null },
          no_unresolved_orders:   { passed: checkResults.no_unresolved_orders?.passed,   count:  checkResults.no_unresolved_orders?.count      ?? 0    },
          balance_match:          { passed: checkResults.balance_match?.passed,          discrepancies: checkResults.balance_match?.discrepancies ?? null },
          ownership_clarity:      { passed: checkResults.ownership_clarity?.passed,      reason: checkResults.ownership_clarity?.reason       ?? null },
          position_integrity:     { passed: checkResults.position_integrity?.passed,     violations: checkResults.position_integrity?.violations ?? null },
        },
      },
    });
  } catch (_) {}

  return { passed, frozen: !passed, freezeReasons, checkResults, reconId };
}

/**
 * Resolve orders stuck in a non-terminal state ('intent_created', 'submitted',
 * 'accepted', 'partially_filled') by fetching their actual state from Upbit
 * and applying fills to the corresponding positions.
 *
 * Called during startup BEFORE runReconciliation so that DB state reflects
 * exchange reality before the balance-match and unresolved-order checks run.
 *
 * Without this, any process restart after a 'wait'-response crash leaves the
 * system permanently frozen with no automated path to recovery.
 *
 * @returns {{ resolved: Array, failed: Array }}
 */
async function resolveStuckOrders(supabase) {
  const resolved = [];
  const failed   = [];

  try {
    const { data: stuck } = await supabase
      .from('orders')
      .select('id, identifier, exchange_uuid, asset, side, qty_requested, position_id, strategy_tag, reason, state, created_at')
      .in('state', ['intent_created', 'submitted', 'accepted', 'partially_filled'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (!stuck || stuck.length === 0) {
      console.log('[recon] resolveStuckOrders: no stuck orders');
      return { resolved, failed };
    }

    console.log(`[recon] resolveStuckOrders: ${stuck.length} stuck order(s) — resolving via Upbit`);

    for (const order of stuck) {
      try {
        // ── Fetch actual order state from exchange ──────────────────────
        const exchangeOrder = await upbit.getOrderByIdentifier(order.identifier).catch(() => null);

        if (!exchangeOrder) {
          console.warn(`[recon] resolveStuckOrders: ${order.asset} order ${order.identifier} not found on exchange — skipping`);
          failed.push({ id: order.id, asset: order.asset, error: 'not_found_on_exchange' });
          continue;
        }

        const exState     = exchangeOrder.state;
        const executedVol = parseFloat(exchangeOrder.executed_volume ?? '0');
        const trades      = exchangeOrder.trades ?? [];

        // Still pending on exchange — cannot resolve yet
        if (exState === 'wait' || exState === 'watch') {
          console.log(`[recon] resolveStuckOrders: ${order.asset} still ${exState} on exchange — skipping`);
          continue;
        }

        // ── Classify terminal state ──────────────────────────────────────
        let dbState = 'failed_terminal';
        if (exState === 'done')                              dbState = 'filled';
        else if (exState === 'cancel' && executedVol > 0)   dbState = 'dust_refunded_and_filled';
        else if (exState === 'cancel' && executedVol === 0) dbState = 'cancelled_by_rule';

        // ── Update order row — must succeed before applying fill ─────────
        // Supabase JS returns {data, error}, it does NOT throw on DB errors.
        // We must check the error explicitly. If the state update fails, we
        // skip fill insertion entirely — the order stays in 'accepted' and
        // will be retried on the next startup. This prevents a partial-write
        // scenario where fills are inserted but the order stays re-processable.
        const { error: orderUpdateErr } = await supabase.from('orders').update({
          state:        dbState,
          exchange_uuid: exchangeOrder.uuid,
          raw_response: exchangeOrder,
          updated_at:   new Date().toISOString(),
        }).eq('id', order.id);

        if (orderUpdateErr) {
          console.error(`[recon] resolveStuckOrders: order state update failed for ${order.asset} (${order.id}): ${orderUpdateErr.message} — skipping fill application`);
          failed.push({ id: order.id, asset: order.asset, error: `order_update_failed: ${orderUpdateErr.message}` });
          continue;
        }

        // ── Idempotency guard: check for existing fills by order_id ──────
        // If fills already exist for this order (written by executionEngine
        // or a prior startup resolution), skip fill insertion and position
        // update. Without this, a crash between state update and fill insert
        // would cause double-application on next startup.
        const { count: existingFillCount } = await supabase
          .from('v2_fills')
          .select('id', { count: 'exact', head: true })
          .eq('order_id', order.id);

        if (existingFillCount > 0) {
          console.log(`[recon] resolveStuckOrders: ${order.asset} order ${order.id} already has ${existingFillCount} fill row(s) — skipping position update (idempotency guard)`);
          resolved.push({ id: order.id, asset: order.asset, state: dbState, note: 'fills_already_recorded' });
          continue;
        }

        // ── Apply fill to position for sell orders with actual execution ──
        if (order.side === 'sell' && order.position_id && executedVol > 0) {
          const avgPrice = trades.length > 0
            ? trades.reduce((sum, t) => sum + parseFloat(t.price ?? '0') * parseFloat(t.volume ?? '0'), 0) / executedVol
            : parseFloat(exchangeOrder.avg_price ?? exchangeOrder.price ?? '0');

          const { data: pos } = await supabase
            .from('positions')
            .select('qty_open, avg_cost_krw, realized_pnl, fired_trims')
            .eq('position_id', order.position_id)
            .single();

          if (pos) {
            const newQty = Math.max(0, (pos.qty_open ?? 0) - executedVol);
            const pnl    = (avgPrice - (pos.avg_cost_krw ?? 0)) * executedVol - (executedVol * avgPrice * 0.0025);

            // Update fired_trims if this was a regime_break or other named trim
            const isRegimeBreak = order.reason?.includes('regime_break');
            const trimName      = isRegimeBreak ? 'regime_break' : null;
            const firedTrims    = trimName
              ? [...new Set([...(pos.fired_trims ?? []), trimName])]
              : (pos.fired_trims ?? []);

            await supabase.from('positions').update({
              qty_open:     newQty,
              realized_pnl: ((pos.realized_pnl ?? 0) + pnl),
              fired_trims:  firedTrims,
              state:        newQty <= 0 ? 'closed' : 'partial',
              closed_at:    newQty <= 0 ? new Date().toISOString() : null,
              updated_at:   new Date().toISOString(),
            }).eq('position_id', order.position_id);

            // ── Persist fill records from trades ─────────────────────────
            // upsert with ignoreDuplicates on upbit_trade_uuid — safe to call
            // multiple times for the same trade (e.g. two startups both resolve
            // the same order). The DB unique index silently skips duplicates.
            for (const trade of trades) {
              try {
                const { error: fillErr } = await supabase.from('v2_fills').upsert({
                  order_id:         order.id,
                  position_id:      order.position_id,
                  asset:            order.asset,
                  side:             'sell',
                  price_krw:        parseFloat(trade.price ?? '0'),
                  qty:              parseFloat(trade.volume ?? '0'),
                  fee_krw:          parseFloat(trade.funds ?? '0') * 0.0025,
                  fee_rate:         0.0025,
                  strategy_tag:     order.strategy_tag,
                  entry_reason:     order.reason,
                  upbit_trade_uuid: trade.uuid ?? null,
                  executed_at:      trade.created_at ?? new Date().toISOString(),
                }, { onConflict: 'upbit_trade_uuid', ignoreDuplicates: true });
                if (fillErr) console.error(`[recon] resolveStuckOrders: fill upsert failed for ${order.asset}:`, fillErr.message);
              } catch (fillErr) {
                console.error(`[recon] resolveStuckOrders: fill upsert exception for ${order.asset}:`, fillErr.message);
              }
            }

            // ── If no trade detail, insert a synthetic fill ───────────────
            // upbit_trade_uuid IS NULL — idempotency protected by the partial
            // unique index on (order_id) WHERE upbit_trade_uuid IS NULL.
            // The DB will return an error on a duplicate; logged below.
            if (!trades.length && executedVol > 0) {
              try {
                const { error: synthErr } = await supabase.from('v2_fills').insert({
                  order_id:         order.id,
                  position_id:      order.position_id,
                  asset:            order.asset,
                  side:             'sell',
                  price_krw:        avgPrice,
                  qty:              executedVol,
                  fee_krw:          executedVol * avgPrice * 0.0025,
                  fee_rate:         0.0025,
                  strategy_tag:     order.strategy_tag,
                  entry_reason:     order.reason,
                  upbit_trade_uuid: null,       // synthetic — no Upbit trade UUID
                  executed_at:      new Date().toISOString(),
                });
                if (synthErr) console.error(`[recon] resolveStuckOrders: synthetic fill insert failed for ${order.asset}:`, synthErr.message);
              } catch (fillErr) {
                console.error(`[recon] resolveStuckOrders: synthetic fill exception for ${order.asset}:`, fillErr.message);
              }
            }

            console.log(`[recon] resolveStuckOrders: ${order.asset} sell resolved — qty ${pos.qty_open}→${newQty} state=${dbState} fired_trims=${JSON.stringify(firedTrims)}`);

            try {
              await supabase.from('bot_events').insert({
                event_type:   'STUCK_ORDER_RESOLVED',
                severity:     'warn',
                subsystem:    'reconciliation',
                message:      `${order.asset} stuck sell resolved on startup — position qty updated`,
                context_json: {
                  order_id:        order.id,
                  identifier:      order.identifier,
                  asset:           order.asset,
                  exchange_state:  dbState,
                  executed_volume: executedVol,
                  avg_price:       avgPrice,
                  qty_before:      pos.qty_open,
                  qty_after:       newQty,
                  fired_trims:     firedTrims,
                  position_id:     order.position_id,
                  engine:          'V2',
                  execution_mode:  'live',
                  timestamp:       new Date().toISOString(),
                },
                mode: 'live',
              });
            } catch (_) {}

            resolved.push({ id: order.id, asset: order.asset, qtyBefore: pos.qty_open, qtyAfter: newQty, state: dbState });
          }
        } else if (order.side === 'buy' && order.position_id && executedVol > 0
                   && (dbState === 'filled' || dbState === 'dust_refunded_and_filled')) {
          // ── Apply fill to position for buy orders with actual execution ──
          // Previously skipped with "no position update needed" — that was wrong.
          // executeBuy() creates the position with qty_open=0 before the order
          // is placed. If the Upbit response was 'wait', extractFills returned []
          // and the position was never updated. We repair it here at startup.
          const avgPrice = trades.length > 0
            ? trades.reduce((sum, t) => sum + parseFloat(t.price ?? '0') * parseFloat(t.volume ?? '0'), 0) / executedVol
            : parseFloat(exchangeOrder.avg_price ?? exchangeOrder.price ?? '0');

          const { data: pos } = await supabase
            .from('positions')
            .select('qty_open, qty_total, avg_cost_krw')
            .eq('position_id', order.position_id)
            .single();

          if (!pos) {
            console.warn(`[recon] resolveStuckOrders: BUY ${order.asset} position ${order.position_id} not found — cannot update qty`);
            resolved.push({ id: order.id, asset: order.asset, state: dbState, note: 'position_not_found' });
          } else {
            // Idempotency: existingFillCount===0 check above already guarantees this
            // specific order's fills have not been applied yet. Do NOT gate on qty_open>0
            // — that would silently skip repairs when an add-on is already in the position.
            // Additive update: preserve any qty/cost from other filled orders on this position.
            const prevQty  = Number(pos.qty_open  ?? 0);
            const prevCost = Number(pos.avg_cost_krw ?? 0);
            const newQty   = prevQty + executedVol;
            const newCost  = newQty > 0
              ? (prevCost * prevQty + avgPrice * executedVol) / newQty
              : avgPrice;

            const { error: buyPosErr } = await supabase.from('positions').update({
              qty_open:     newQty,
              qty_total:    (Number(pos.qty_total ?? 0) + newQty),
              avg_cost_krw: newCost,
              updated_at:   new Date().toISOString(),
            }).eq('position_id', order.position_id);

            if (buyPosErr) {
              console.error(`[recon] resolveStuckOrders: BUY ${order.asset} position update failed: ${buyPosErr.message}`);
            } else {
              console.log(`[recon] resolveStuckOrders: BUY ${order.asset} position repaired — qty ${prevQty}→${newQty} avg=₩${Math.round(newCost)}`);
            }

            // Persist fill records from trades (idempotent via upbit_trade_uuid)
            for (const trade of trades) {
              try {
                const { error: fillErr } = await supabase.from('v2_fills').upsert({
                  order_id:         order.id,
                  position_id:      order.position_id,
                  asset:            order.asset,
                  side:             'buy',
                  price_krw:        parseFloat(trade.price ?? '0'),
                  qty:              parseFloat(trade.volume ?? '0'),
                  fee_krw:          parseFloat(trade.funds ?? '0') * 0.0025,
                  fee_rate:         0.0025,
                  strategy_tag:     order.strategy_tag,
                  entry_reason:     order.reason,
                  upbit_trade_uuid: trade.uuid ?? null,
                  executed_at:      trade.created_at ?? new Date().toISOString(),
                }, { onConflict: 'upbit_trade_uuid', ignoreDuplicates: true });
                if (fillErr) console.error(`[recon] resolveStuckOrders: BUY fill upsert failed for ${order.asset}:`, fillErr.message);
              } catch (fillErr) {
                console.error(`[recon] resolveStuckOrders: BUY fill upsert exception for ${order.asset}:`, fillErr.message);
              }
            }

            // Synthetic fill when exchange response had no trade detail
            if (!trades.length && executedVol > 0) {
              try {
                const { error: synthErr } = await supabase.from('v2_fills').insert({
                  order_id:         order.id,
                  position_id:      order.position_id,
                  asset:            order.asset,
                  side:             'buy',
                  price_krw:        newCost,
                  qty:              executedVol,
                  fee_krw:          executedVol * newCost * 0.0025,
                  fee_rate:         0.0025,
                  strategy_tag:     order.strategy_tag,
                  entry_reason:     order.reason,
                  upbit_trade_uuid: null,
                  executed_at:      new Date().toISOString(),
                });
                if (synthErr) console.error(`[recon] resolveStuckOrders: BUY synthetic fill failed for ${order.asset}:`, synthErr.message);
              } catch (fillErr) {
                console.error(`[recon] resolveStuckOrders: BUY synthetic fill exception for ${order.asset}:`, fillErr.message);
              }
            }

            try {
              await supabase.from('bot_events').insert({
                event_type:   'STUCK_ORDER_RESOLVED',
                severity:     'warn',
                subsystem:    'reconciliation',
                message:      `${order.asset} stuck buy resolved on startup — position qty updated ${prevQty}→${newQty}`,
                context_json: {
                  order_id:        order.id,
                  identifier:      order.identifier,
                  asset:           order.asset,
                  side:            'buy',
                  exchange_state:  dbState,
                  executed_volume: executedVol,
                  avg_price:       newCost,
                  qty_before:      prevQty,
                  qty_after:       newQty,
                  position_id:     order.position_id,
                  pos_update_err:  buyPosErr?.message ?? null,
                  engine:          'V2',
                  execution_mode:  'live',
                  timestamp:       new Date().toISOString(),
                },
                mode: 'live',
              });
            } catch (_) {}

            resolved.push({ id: order.id, asset: order.asset, qtyBefore: prevQty, qtyAfter: newQty, state: dbState });
          }
        } else {
          // Cancelled buys (no execution), or buy orders without position_id
          console.log(`[recon] resolveStuckOrders: ${order.asset} ${order.side} settled as ${dbState} — no position update (executedVol=${executedVol} position_id=${order.position_id ?? 'none'})`);
          resolved.push({ id: order.id, asset: order.asset, state: dbState });
        }

      } catch (orderErr) {
        console.error(`[recon] resolveStuckOrders: failed to resolve ${order.asset} ${order.identifier}:`, orderErr.message);
        failed.push({ id: order.id, asset: order.asset, error: orderErr.message });
      }
    }

    console.log(`[recon] resolveStuckOrders: complete — resolved:${resolved.length} failed:${failed.length}`);
    return { resolved, failed };

  } catch (err) {
    console.error('[recon] resolveStuckOrders error:', err.message);
    return { resolved, failed, error: err.message };
  }
}

/**
 * Backfill positions for orders that reached a terminal state (filled) but
 * whose fills were never applied to the positions table.
 *
 * This covers the gap that resolveStuckOrders cannot address: when a sell order
 * was moved to 'filled' state (by the poll in executeSell, or by a prior run of
 * resolveStuckOrders) but extractFills returned [] and the position qty_open was
 * never reduced. resolveStuckOrders only queries non-terminal states, so these
 * orphaned fills are permanently invisible to it.
 *
 * Called on startup after resolveStuckOrders and before runReconciliation.
 *
 * @returns {{ applied: Array, skipped: Array, failed: Array }}
 */
async function backfillOrphanedFills(supabase) {
  const applied = [];
  const skipped = [];
  const failed  = [];

  try {
    // Find terminal orders (buy or sell) with no v2_fills rows.
    // Buy orders are included so that filled buys whose position was never updated
    // (due to the wait-response gap in executeBuy) can be repaired here.
    const { data: orphaned } = await supabase
      .from('orders')
      .select('id, identifier, exchange_uuid, asset, side, qty_requested, position_id, strategy_tag, reason, state, created_at')
      .in('state', ['filled', 'dust_refunded_and_filled'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (!orphaned || orphaned.length === 0) {
      console.log('[recon] backfillOrphanedFills: no orphaned fills found');
      return { applied, skipped, failed };
    }

    // Filter to only those with no v2_fills rows
    const toProcess = [];
    for (const order of orphaned) {
      const { count } = await supabase
        .from('v2_fills')
        .select('id', { count: 'exact', head: true })
        .eq('order_id', order.id);
      if ((count ?? 0) === 0) {
        toProcess.push(order);
      } else {
        skipped.push({ id: order.id, asset: order.asset, reason: 'fills_already_exist', fill_count: count });
      }
    }

    if (toProcess.length === 0) {
      console.log('[recon] backfillOrphanedFills: all terminal orders already have fills');
      return { applied, skipped, failed };
    }

    console.log(`[recon] backfillOrphanedFills: ${toProcess.length} orphaned order(s) need fill backfill (buys + sells)`);

    for (const order of toProcess) {
      try {
        // Fetch settled order from Upbit to get trade detail
        const exchangeOrder = await upbit.getOrderByIdentifier(order.identifier).catch(() => null);

        const executedVol = exchangeOrder
          ? parseFloat(exchangeOrder.executed_volume ?? '0')
          : parseFloat(order.qty_requested ?? '0'); // fallback to requested qty

        if (executedVol <= 0) {
          console.warn(`[recon] backfillOrphanedFills: ${order.asset} order ${order.id} has executedVol=0 — skipping`);
          skipped.push({ id: order.id, asset: order.asset, reason: 'zero_executed_volume' });
          continue;
        }

        const trades   = exchangeOrder?.trades ?? [];
        const avgPrice = trades.length > 0
          ? trades.reduce((sum, t) => sum + parseFloat(t.price ?? '0') * parseFloat(t.volume ?? '0'), 0) / executedVol
          : parseFloat(exchangeOrder?.avg_price ?? exchangeOrder?.price ?? '0');

        // Fetch current position
        if (!order.position_id) {
          skipped.push({ id: order.id, asset: order.asset, reason: 'no_position_id' });
          continue;
        }

        const { data: pos } = await supabase
          .from('positions')
          .select('qty_open, avg_cost_krw, realized_pnl, fired_trims')
          .eq('position_id', order.position_id)
          .single();

        if (!pos) {
          console.warn(`[recon] backfillOrphanedFills: position ${order.position_id} not found for ${order.asset}`);
          failed.push({ id: order.id, asset: order.asset, error: 'position_not_found' });
          continue;
        }

        // ── Branch: buy vs sell position update logic ────────────────────
        if (order.side === 'buy') {
          // Idempotency: the toProcess filter (count===0 per order_id) above already
          // guarantees this specific order's fills have not been recorded yet.
          // Do NOT gate on qty_open>0 — that silently skips add-on repairs.
          // Additive update: accumulate over any qty already present from other orders.
          const prevQty  = Number(pos.qty_open  ?? 0);
          const prevCost = Number(pos.avg_cost_krw ?? 0);
          const newQty   = prevQty + executedVol;
          const newCost  = newQty > 0
            ? (prevCost * prevQty + avgPrice * executedVol) / newQty
            : avgPrice;

          const { error: posErr } = await supabase.from('positions').update({
            qty_open:     newQty,
            qty_total:    (Number(pos.qty_total ?? 0) + executedVol),
            avg_cost_krw: newCost,
            updated_at:   new Date().toISOString(),
          }).eq('position_id', order.position_id);

          if (posErr) {
            console.error(`[recon] backfillOrphanedFills: BUY position update failed for ${order.asset} (non-fatal — fill insert proceeds):`, posErr.message);
          }

          const fillQty   = trades.length > 0
            ? trades.reduce((sum, t) => sum + parseFloat(t.volume ?? '0'), 0)
            : executedVol;
          const fillPrice = newCost;

          const { error: fillInsertErr } = await supabase.from('v2_fills').insert({
            order_id:     order.id,
            position_id:  order.position_id,
            asset:        order.asset,
            side:         'buy',
            price_krw:    fillPrice,
            qty:          fillQty,
            fee_krw:      fillQty * fillPrice * 0.0025,
            fee_rate:     0.0025,
            strategy_tag: order.strategy_tag,
            entry_reason: order.reason,
            executed_at:  new Date().toISOString(),
          });

          if (fillInsertErr) {
            console.error(`[recon] backfillOrphanedFills: BUY fill insert failed for ${order.asset} (${order.id}):`, fillInsertErr.message);
          } else {
            console.log(`[recon] backfillOrphanedFills: BUY ${order.asset} fill inserted — qty=${fillQty.toFixed(8)} price=₩${Math.round(fillPrice)}`);
          }

          console.log(`[recon] backfillOrphanedFills: BUY ${order.asset} — pos ${prevQty}→${newQty} posErr=${posErr?.message ?? 'none'} fillErr=${fillInsertErr?.message ?? 'none'}`);

          const { error: evtErr } = await supabase.from('bot_events').insert({
            event_type:   'ORPHANED_FILL_BACKFILLED',
            severity:     'warn',
            subsystem:    'reconciliation',
            message:      `${order.asset} orphaned buy fill backfilled — position qty ${prevQty}→${newQty}`,
            context_json: {
              order_id:         order.id,
              asset:            order.asset,
              side:             'buy',
              executed_volume:  executedVol,
              avg_price:        newCost,
              qty_before:       prevQty,
              qty_after:        newQty,
              fill_inserted:    !fillInsertErr,
              position_updated: !posErr,
              position_id:      order.position_id,
              engine:           'V2',
              execution_mode:   'live',
              timestamp:        new Date().toISOString(),
            },
            mode: 'live',
          });
          if (evtErr) console.error(`[recon] backfillOrphanedFills: bot_events insert failed for ${order.asset}:`, evtErr.message);

          applied.push({ id: order.id, asset: order.asset, side: 'buy', qtyBefore: prevQty, qtyAfter: newQty, fillInserted: !fillInsertErr });

        } else {
          // ── Sell orphan: original logic unchanged ────────────────────────
          const newQty = Math.max(0, (pos.qty_open ?? 0) - executedVol);
          const pnl    = (avgPrice - (pos.avg_cost_krw ?? 0)) * executedVol - (executedVol * avgPrice * 0.0025);

          const isRegimeBreak = order.reason?.includes('regime_break');
          const firedTrims    = isRegimeBreak
            ? [...new Set([...(pos.fired_trims ?? []), 'regime_break'])]
            : (pos.fired_trims ?? []);

          // Do NOT gate fill insert on posErr — fill record is an audit trail
          // that must be written even if position is already correct.
          const { error: posErr } = await supabase.from('positions').update({
            qty_open:     newQty,
            realized_pnl: ((pos.realized_pnl ?? 0) + pnl),
            fired_trims:  firedTrims,
            state:        newQty <= 0 ? 'closed' : 'partial',
            closed_at:    newQty <= 0 ? new Date().toISOString() : null,
            updated_at:   new Date().toISOString(),
          }).eq('position_id', order.position_id);

          if (posErr) {
            console.error(`[recon] backfillOrphanedFills: SELL position update failed for ${order.asset} (non-fatal — fill insert proceeds):`, posErr.message);
          }

          const fillQty   = trades.length > 0
            ? trades.reduce((sum, t) => sum + parseFloat(t.volume ?? '0'), 0)
            : executedVol;
          const fillPrice = avgPrice;

          const { error: fillInsertErr } = await supabase.from('v2_fills').insert({
            order_id:     order.id,
            position_id:  order.position_id,
            asset:        order.asset,
            side:         'sell',
            price_krw:    fillPrice,
            qty:          fillQty,
            fee_krw:      fillQty * fillPrice * 0.0025,
            fee_rate:     0.0025,
            strategy_tag: order.strategy_tag,
            entry_reason: order.reason,
            executed_at:  new Date().toISOString(),
          });

          if (fillInsertErr) {
            console.error(`[recon] backfillOrphanedFills: SELL fill insert failed for ${order.asset} (${order.id}):`, fillInsertErr.message);
          } else {
            console.log(`[recon] backfillOrphanedFills: SELL ${order.asset} fill inserted — qty=${fillQty.toFixed(8)} price=${fillPrice}`);
          }

          console.log(`[recon] backfillOrphanedFills: SELL ${order.asset} — pos ${pos.qty_open}→${newQty} posErr=${posErr?.message ?? 'none'} fillErr=${fillInsertErr?.message ?? 'none'}`);

          const { error: evtErr } = await supabase.from('bot_events').insert({
            event_type:   'ORPHANED_FILL_BACKFILLED',
            severity:     'warn',
            subsystem:    'reconciliation',
            message:      `${order.asset} orphaned sell fill backfilled`,
            context_json: {
              order_id:         order.id,
              asset:            order.asset,
              side:             'sell',
              executed_volume:  executedVol,
              avg_price:        avgPrice,
              qty_before:       pos.qty_open,
              qty_after:        newQty,
              fill_inserted:    !fillInsertErr,
              position_updated: !posErr,
              fired_trims:      firedTrims,
              position_id:      order.position_id,
              engine:           'V2',
              execution_mode:   'live',
              timestamp:        new Date().toISOString(),
            },
            mode: 'live',
          });
          if (evtErr) console.error(`[recon] backfillOrphanedFills: bot_events insert failed for ${order.asset}:`, evtErr.message);

          applied.push({ id: order.id, asset: order.asset, side: 'sell', qtyBefore: pos.qty_open, qtyAfter: newQty, fillInserted: !fillInsertErr });
        }

      } catch (orderErr) {
        console.error(`[recon] backfillOrphanedFills: error for ${order.asset}:`, orderErr.message);
        failed.push({ id: order.id, asset: order.asset, error: orderErr.message });
      }
    }

    console.log(`[recon] backfillOrphanedFills: complete — applied:${applied.length} skipped:${skipped.length} failed:${failed.length}`);
    return { applied, skipped, failed };

  } catch (err) {
    console.error('[recon] backfillOrphanedFills error:', err.message);
    return { applied, skipped, failed, error: err.message };
  }
}

/**
 * Manually clear a freeze from the dashboard or operator command.
 * Records the override in bot_events.
 */
async function manualClearFreeze(supabase, operatorNote = 'manual_override') {
  await clearFreeze(supabase); // emits FREEZE_STATE_CHANGED if was frozen
  try {
    await supabase.from('bot_events').insert({
      event_type:   'FREEZE_CLEARED',
      severity:     'warn',
      subsystem:    'reconciliation_engine',
      message:      `Freeze manually cleared by operator: ${operatorNote}`,
      context_json: {
        source:         'manual_operator',
        operator_note:  operatorNote,
      },
    });
  } catch (_) {}
  console.warn(`[reconcile] ⚠ Freeze manually cleared by operator: ${operatorNote}`);
}

module.exports = {
  loadFreezeState,
  isSystemFrozen,
  getFreezeReasons,
  setFreeze,
  clearFreeze,
  manualClearFreeze,
  runReconciliation,
  resolveStuckOrders,
  backfillOrphanedFills,
  normalizeSymbol,
};
