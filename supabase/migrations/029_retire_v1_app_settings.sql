-- Migration 029: Delete stale V1 app_settings keys.
-- These keys were written by the V1 engine which is now fully retired.
-- Nothing in the V2 runtime or API reads or writes them any more.
-- Deleting them prevents the dashboard from ever showing stale V1 data.

DELETE FROM app_settings WHERE key IN (
  'crypto_portfolio_snapshot',  -- V1 portfolio (replaced by v2_portfolio_snapshot)
  'last_cycle_result',          -- V1 cycle result (V2 cycle state is in bot_events)
  'coin_indicators',            -- V1 indicator cache (V2 uses bot_events.DECISION_CYCLE)
  'last_cycle_detail'           -- V1 full cycle detail blob
);

-- Verify remaining V2 keys are intact (informational)
-- SELECT key FROM app_settings ORDER BY key;
-- Expected V2 keys: adoption_status, current_regime, latest_reconciliation,
--   pi_heartbeat, risk_engine_state, system_freeze, v2_portfolio_snapshot,
--   kill_switch, crypto_manual_trigger, crypto_deploy_trigger,
--   reconcile_trigger, adoption_status, peak_price_BTC/ETH/SOL, etc.
