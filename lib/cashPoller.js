/**
 * Cash movements poller — fetches Upbit deposit/withdraw history into the
 * cash_movements ledger. Idempotent via uuid unique index.
 *
 * Phase A scope: KRW only. Crypto in/out is currently zero historical
 * volume; CURRENCIES is structured to permit expansion without schema
 * changes (Phase B+).
 *
 * Contract: NEVER throws. Parent setInterval relies on this — any thrown
 * error would crash the pi-trader process. All failure paths log + write
 * { last_run_status: 'error', last_run_error } to app_settings.
 */

const { getDeposits, getWithdraws } = require('./upbit');

// Phase A: KRW only. See Phase B for crypto in/out support.
const CURRENCIES = ['KRW'];
const POLLER_STATE_KEY = 'cash_poller_state';

async function pollCashMovements(supabase, { mode = 'incremental', forceRun = false } = {}) {
  const startedAt = new Date().toISOString();
  void mode; // accepted for future hook (e.g. 'backfill'); unused in Phase A

  try {
    // ── Read bot_config ──────────────────────────────────────────────────
    let cfg;
    try {
      const { data, error } = await supabase
        .from('bot_config')
        .select('cash_poller_enabled, cash_poll_interval_ms, cash_backfill_window_days, cash_settled_states_deposit, cash_settled_states_withdraw')
        .limit(1)
        .single();
      if (error) throw error;
      cfg = data ?? {};
    } catch (err) {
      console.error('[cash-poller] bot_config read failed:', err.message);
      await writeState(supabase, {
        last_run_status: 'error',
        last_run_error:  `bot_config read failed: ${err.message}`,
        last_run_at:     startedAt,
      });
      return { inserted: 0, skipped_duplicates: 0, errors: [err.message] };
    }

    if (!cfg.cash_poller_enabled && !forceRun) {
      console.log('[cash-poller] Skipped — cash_poller_enabled=false');
      return { skipped: true, reason: 'disabled' };
    }

    const settledDeposit  = cfg.cash_settled_states_deposit  ?? ['ACCEPTED'];
    const settledWithdraw = cfg.cash_settled_states_withdraw ?? ['DONE'];
    const backfillDays    = Number(cfg.cash_backfill_window_days ?? 90);

    // ── Read cursor ──────────────────────────────────────────────────────
    let state = null;
    try {
      const { data } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', POLLER_STATE_KEY)
        .single();
      state = data?.value ?? null;
    } catch (_) {
      state = null;
    }

    const isFirstRun = !state?.last_synced_at;
    const since = isFirstRun
      ? new Date(Date.now() - backfillDays * 86_400_000).toISOString()
      : state.last_synced_at;
    const sinceMs = new Date(since).getTime();

    console.log(`[cash-poller] Starting (${isFirstRun ? 'first-run backfill' : 'incremental'}) since=${since}`);

    // ── Fetch + filter + upsert per currency ─────────────────────────────
    let totalInserted = 0;
    let totalSkipped  = 0;
    const errors = [];
    let lastSeenDeposit      = state?.last_seen_deposit_uuid  ?? null;
    let lastSeenDepositTime  = 0;
    let lastSeenWithdraw     = state?.last_seen_withdraw_uuid ?? null;
    let lastSeenWithdrawTime = 0;

    for (const currency of CURRENCIES) {
      // Deposits
      try {
        const recs = await getDeposits({ currency, limit: 100 });
        const settled = (recs || [])
          .filter((r) => settledDeposit.includes(r.state))
          .filter((r) => r.created_at && new Date(r.created_at).getTime() >= sinceMs);

        for (const r of settled) {
          if (!r.done_at) {
            console.warn(`[cash-poller] WARN deposit ${r.uuid} state=${r.state} but done_at is null`);
          }
          const t = r.created_at ? new Date(r.created_at).getTime() : 0;
          if (r.uuid && t > lastSeenDepositTime) {
            lastSeenDepositTime = t;
            lastSeenDeposit     = r.uuid;
          }
        }

        const rows = settled.map(toRow);
        if (rows.length > 0) {
          const { data: inserted, error } = await supabase
            .from('cash_movements')
            .upsert(rows, { onConflict: 'uuid', ignoreDuplicates: true })
            .select('uuid');
          if (error) {
            errors.push(`deposits ${currency} upsert: ${error.message}`);
          } else {
            const insertedCount = (inserted || []).length;
            totalInserted += insertedCount;
            totalSkipped  += rows.length - insertedCount;
          }
        }
      } catch (err) {
        console.error(`[cash-poller] getDeposits(${currency}) failed:`, err.message);
        errors.push(`getDeposits(${currency}): ${err.message}`);
      }

      // Withdraws
      try {
        const recs = await getWithdraws({ currency, limit: 100 });
        const settled = (recs || [])
          .filter((r) => settledWithdraw.includes(r.state))
          .filter((r) => r.created_at && new Date(r.created_at).getTime() >= sinceMs);

        for (const r of settled) {
          if (!r.done_at) {
            console.warn(`[cash-poller] WARN withdraw ${r.uuid} state=${r.state} but done_at is null`);
          }
          const t = r.created_at ? new Date(r.created_at).getTime() : 0;
          if (r.uuid && t > lastSeenWithdrawTime) {
            lastSeenWithdrawTime = t;
            lastSeenWithdraw     = r.uuid;
          }
        }

        const rows = settled.map(toRow);
        if (rows.length > 0) {
          const { data: inserted, error } = await supabase
            .from('cash_movements')
            .upsert(rows, { onConflict: 'uuid', ignoreDuplicates: true })
            .select('uuid');
          if (error) {
            errors.push(`withdraws ${currency} upsert: ${error.message}`);
          } else {
            const insertedCount = (inserted || []).length;
            totalInserted += insertedCount;
            totalSkipped  += rows.length - insertedCount;
          }
        }
      } catch (err) {
        console.error(`[cash-poller] getWithdraws(${currency}) failed:`, err.message);
        errors.push(`getWithdraws(${currency}): ${err.message}`);
      }
    }

    // ── Write final state ────────────────────────────────────────────────
    const finishedAt = new Date().toISOString();
    if (errors.length > 0) {
      await writeState(supabase, {
        last_synced_at:          state?.last_synced_at ?? null,
        last_seen_deposit_uuid:  lastSeenDeposit,
        last_seen_withdraw_uuid: lastSeenWithdraw,
        last_run_status:         'error',
        last_run_error:          errors.slice(0, 5).join(' | '),
        last_run_at:             finishedAt,
      });
    } else {
      await writeState(supabase, {
        last_synced_at:          startedAt,
        last_seen_deposit_uuid:  lastSeenDeposit,
        last_seen_withdraw_uuid: lastSeenWithdraw,
        last_run_status:         'ok',
        last_run_error:          null,
        last_run_at:             finishedAt,
      });
    }

    console.log(`[cash-poller] Done — inserted=${totalInserted} skipped=${totalSkipped} errors=${errors.length}`);
    return { inserted: totalInserted, skipped_duplicates: totalSkipped, errors };
  } catch (err) {
    console.error('[cash-poller] Unhandled error:', err.message);
    await writeState(supabase, {
      last_run_status: 'error',
      last_run_error:  `unhandled: ${err.message}`,
      last_run_at:     new Date().toISOString(),
    }).catch(() => {});
    return { inserted: 0, skipped_duplicates: 0, errors: [err.message] };
  }
}

function toRow(rec) {
  return {
    uuid:             rec.uuid,
    type:             rec.type,
    currency:         rec.currency,
    txid:             rec.txid,
    state:            rec.state,
    transaction_type: rec.transaction_type,
    net_type:         rec.net_type,
    amount:           parseFloat(rec.amount),
    fee:              parseFloat(rec.fee ?? '0'),
    is_cancelable:    rec.is_cancelable ?? null,
    upbit_created_at: rec.created_at,
    upbit_done_at:    rec.done_at,
  };
}

async function writeState(supabase, value) {
  try {
    await supabase.from('app_settings').upsert({
      key:        POLLER_STATE_KEY,
      value,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
  } catch (err) {
    console.error('[cash-poller] writeState failed:', err.message);
  }
}

module.exports = { pollCashMovements };
