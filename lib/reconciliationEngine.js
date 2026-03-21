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

// Assets the strategy actively manages (supported universe).
const UPBIT_SYMBOL_MAP = {
  BTC: 'BTC', ETH: 'ETH', SOL: 'SOL',
};

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
  _frozenInMemory = true;
  _freezeReasons  = Array.isArray(reasons) ? reasons : [reasons];
  console.warn(`[reconcile] ⛔ SYSTEM FROZEN — ${_freezeReasons.join('; ')}`);
  await persistFreezeState(supabase, true, _freezeReasons);
}

async function clearFreeze(supabase) {
  _frozenInMemory = false;
  _freezeReasons  = [];
  console.log('[reconcile] ✓ System unfreeze — trading enabled');
  await persistFreezeState(supabase, false, []);
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
    return { passed: false, reason: `balance_mismatch: ${detail}`, discrepancies };
  }

  return { passed: true, discrepancies, exchangeQty, dbQty };
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

// ─── Main reconciliation ──────────────────────────────────────────────────────

/**
 * Run a full startup reconciliation.
 *
 * Steps:
 *   1. Query live Upbit balances
 *   2. Check adoption complete
 *   3. Check no unresolved orders
 *   4. Check balance match (exchange vs DB)
 *   5. Check ownership clarity
 *   6. If all pass → unfreeze; else freeze with reasons
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
    await supabase.from('reconciliation_checks').update({
      status: 'failed', freeze_reasons: [`exchange_unreachable: ${err.message}`],
      trading_enabled: false, resolved_at: new Date().toISOString(),
    }).eq('id', reconId).catch(() => {});
    return { passed: false, frozen: true, freezeReasons: _freezeReasons, checkResults, reconId };
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

  const passed = freezeReasons.length === 0;

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
  await supabase.from('reconciliation_checks').update({
    status:              finalStatus,
    freeze_reasons:      freezeReasons,
    exchange_balances:   exchangeBalances,
    internal_balances:   internalBalances,
    discrepancies:       c3.discrepancies ?? null,
    open_orders_found:   c2.count ?? 0,
    checks_run:          checkResults,
    trading_enabled:     passed,
    resolved_at:         new Date().toISOString(),
  }).eq('id', reconId).catch(() => {});

  // ── Persist latest reconciliation id to app_settings for dashboard ────────
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
  }, { onConflict: 'key' }).catch(() => {});

  if (passed) {
    await clearFreeze(supabase);
    console.log('[reconcile] ✓ All checks passed — trading enabled');
  } else {
    await setFreeze(supabase, freezeReasons);
    console.warn('[reconcile] Checks failed:', freezeReasons.join(' | '));
  }

  return { passed, frozen: !passed, freezeReasons, checkResults, reconId };
}

/**
 * Manually clear a freeze from the dashboard or operator command.
 * Records the override in bot_events.
 */
async function manualClearFreeze(supabase, operatorNote = 'manual_override') {
  await clearFreeze(supabase);
  await supabase.from('bot_events').insert({
    event_type:   'FREEZE_CLEARED',
    severity:     'warn',
    subsystem:    'reconciliation_engine',
    message:      `Freeze manually cleared: ${operatorNote}`,
  }).catch(() => {});
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
  normalizeSymbol,
};
