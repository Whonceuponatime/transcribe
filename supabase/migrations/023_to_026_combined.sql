-- ============================================================
-- COMBINED MIGRATION 023 → 026
-- Run this entire script once in the Supabase SQL Editor.
-- It is fully idempotent — safe to run on any existing database.
-- ============================================================


-- ================================================================
-- 023: bot_config, positions, orders, fills,
--      portfolio_snapshots_v2, bot_events
-- ================================================================

CREATE TABLE IF NOT EXISTS bot_config (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                     TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','shadow','live')),
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  coins                    JSONB NOT NULL DEFAULT '["BTC","ETH","SOL"]'::jsonb,
  core_target_pct          NUMERIC(5,2) NOT NULL DEFAULT 30,
  tactical_target_pct      NUMERIC(5,2) NOT NULL DEFAULT 15,
  krw_min_reserve_pct      NUMERIC(5,2) NOT NULL DEFAULT 12,
  entry_bb_pct_uptrend     NUMERIC(5,3) NOT NULL DEFAULT 0.25,
  entry_rsi_min_uptrend    NUMERIC(5,2) NOT NULL DEFAULT 35,
  entry_rsi_max_uptrend    NUMERIC(5,2) NOT NULL DEFAULT 45,
  entry_bb_pct_range       NUMERIC(5,3) NOT NULL DEFAULT 0.10,
  entry_rsi_max_range      NUMERIC(5,2) NOT NULL DEFAULT 35,
  entry_bb_pct_downtrend   NUMERIC(5,3) NOT NULL DEFAULT 0.05,
  entry_rsi_max_downtrend  NUMERIC(5,2) NOT NULL DEFAULT 28,
  ob_imbalance_min         NUMERIC(5,3) NOT NULL DEFAULT -0.30,
  exit_atr_trim1           NUMERIC(5,2) NOT NULL DEFAULT 1.20,
  exit_atr_trim2           NUMERIC(5,2) NOT NULL DEFAULT 2.00,
  exit_atr_trailing        NUMERIC(5,2) NOT NULL DEFAULT 1.50,
  exit_time_stop_hours     NUMERIC(6,1) NOT NULL DEFAULT 30,
  regime_adx_uptrend       NUMERIC(5,2) NOT NULL DEFAULT 20,
  regime_adx_range_exit    NUMERIC(5,2) NOT NULL DEFAULT 25,
  regime_ema_range_pct     NUMERIC(5,3) NOT NULL DEFAULT 0.02,
  max_btc_pct              NUMERIC(5,2) NOT NULL DEFAULT 35,
  max_eth_pct              NUMERIC(5,2) NOT NULL DEFAULT 25,
  max_sol_pct              NUMERIC(5,2) NOT NULL DEFAULT 10,
  max_risk_per_signal_pct  NUMERIC(5,2) NOT NULL DEFAULT 2,
  max_entries_per_coin_24h INTEGER      NOT NULL DEFAULT 3,
  daily_turnover_cap_pct   NUMERIC(5,2) NOT NULL DEFAULT 35,
  loss_streak_limit        INTEGER      NOT NULL DEFAULT 5,
  drawdown_7d_threshold    NUMERIC(5,2) NOT NULL DEFAULT -4,
  stop_loss_pct            NUMERIC(5,2) NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO bot_config DEFAULT VALUES ON CONFLICT DO NOTHING;

-- positions: created with the full final column set so no ALTER needed below
CREATE TABLE IF NOT EXISTS positions (
  position_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset                   TEXT NOT NULL,
  strategy_tag            TEXT NOT NULL DEFAULT 'unassigned'
                            CHECK (strategy_tag IN ('core','tactical','unassigned')),
  qty_open                NUMERIC(24,10) NOT NULL DEFAULT 0,
  qty_total               NUMERIC(24,10) NOT NULL DEFAULT 0,
  avg_cost_krw            NUMERIC(20,4),
  realized_pnl            NUMERIC(20,4)  NOT NULL DEFAULT 0,
  entry_regime            TEXT CHECK (entry_regime IN ('UPTREND','RANGE','DOWNTREND')),
  entry_reason            TEXT,
  atr_at_entry            NUMERIC(20,4),
  spread_estimate         NUMERIC(10,6),
  usd_proxy_fx            NUMERIC(12,4),
  -- State and origin (024 / 025)
  state                   TEXT NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open','closed','partial','adopted')),
  origin                  TEXT NOT NULL DEFAULT 'bot_managed'
                            CHECK (origin IN ('bot_managed','adopted_at_startup')),
  managed                 BOOLEAN NOT NULL DEFAULT true,
  supported_universe      BOOLEAN NOT NULL DEFAULT true,
  current_mark_price      NUMERIC(20,4),
  estimated_market_value  NUMERIC(20,4),
  adoption_timestamp      TIMESTAMPTZ,
  adoption_run_id         UUID,
  -- Operator classification (026)
  operator_classified_at  TIMESTAMPTZ,
  operator_note           TEXT,
  -- Timestamps
  fired_trims             JSONB,
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Consistency: adopted positions must record when they were imported
  CONSTRAINT positions_adopted_has_timestamp
    CHECK (origin != 'adopted_at_startup' OR adoption_timestamp IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_positions_asset_state ON positions(asset, state);
CREATE INDEX IF NOT EXISTS idx_positions_strategy    ON positions(strategy_tag, state);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier      UUID NOT NULL UNIQUE,
  exchange_uuid   TEXT,
  asset           TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  order_type      TEXT NOT NULL DEFAULT 'market',
  qty_requested   NUMERIC(24,10),
  krw_requested   NUMERIC(20,4),
  price_submitted NUMERIC(20,4),
  strategy_tag    TEXT CHECK (strategy_tag IN ('core','tactical','unassigned')),
  position_id     UUID REFERENCES positions(position_id),
  regime_at_order TEXT CHECK (regime_at_order IN ('UPTREND','RANGE','DOWNTREND')),
  reason          TEXT,
  state           TEXT NOT NULL DEFAULT 'intent_created' CHECK (state IN (
    'intent_created','submitted','accepted','partially_filled',
    'filled','dust_refunded_and_filled','cancelled_by_rule',
    'failed_transient','failed_terminal'
  )),
  raw_response    JSONB,
  mode            TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','shadow','live')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_asset_state ON orders(asset, state);
CREATE INDEX IF NOT EXISTS idx_orders_identifier  ON orders(identifier);
CREATE INDEX IF NOT EXISTS idx_orders_created     ON orders(created_at DESC);

-- v2_fills avoids conflict with the existing live-trading 'fills' table
-- which uses order_request_id (different schema).
CREATE TABLE IF NOT EXISTS v2_fills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id),
  position_id     UUID REFERENCES positions(position_id),
  asset           TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price_krw       NUMERIC(20,4)  NOT NULL,
  qty             NUMERIC(24,10) NOT NULL,
  fee_krw         NUMERIC(20,4)  NOT NULL DEFAULT 0,
  fee_rate        NUMERIC(8,6)   NOT NULL DEFAULT 0.0025,
  strategy_tag    TEXT CHECK (strategy_tag IN ('core','tactical','unassigned')),
  entry_regime    TEXT,
  entry_reason    TEXT,
  atr_at_entry    NUMERIC(20,4),
  spread_estimate NUMERIC(10,6),
  usd_proxy_fx    NUMERIC(12,4),
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_v2_fills_order_id   ON v2_fills(order_id);
CREATE INDEX IF NOT EXISTS idx_v2_fills_asset_time ON v2_fills(asset, executed_at DESC);

CREATE TABLE IF NOT EXISTS portfolio_snapshots_v2 (
  id              BIGSERIAL PRIMARY KEY,
  nav_krw         NUMERIC(20,4) NOT NULL,
  nav_usd_proxy   NUMERIC(20,4),
  usdt_krw_rate   NUMERIC(12,4),
  krw_balance     NUMERIC(20,4),
  krw_pct         NUMERIC(6,2),
  btc_value_krw   NUMERIC(20,4),
  btc_pct         NUMERIC(6,2),
  eth_value_krw   NUMERIC(20,4),
  eth_pct         NUMERIC(6,2),
  sol_value_krw   NUMERIC(20,4),
  sol_pct         NUMERIC(6,2),
  regime          TEXT CHECK (regime IN ('UPTREND','RANGE','DOWNTREND')),
  alpha_vs_btc    NUMERIC(10,4),
  circuit_breakers JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_created ON portfolio_snapshots_v2(created_at DESC);

CREATE TABLE IF NOT EXISTS bot_events (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info'
                 CHECK (severity IN ('debug','info','warn','error','critical')),
  subsystem    TEXT NOT NULL,
  message      TEXT NOT NULL,
  context_json JSONB,
  regime       TEXT,
  mode         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_events_created  ON bot_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_events_type_sev ON bot_events(event_type, severity);


-- ================================================================
-- 024: adoption_runs table
-- ================================================================

CREATE TABLE IF NOT EXISTS adoption_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','complete','failed')),
  adopted_count       INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  unsupported_count   INTEGER NOT NULL DEFAULT 0,
  unsupported_assets  JSONB,
  adopted_assets      JSONB,
  error_message       TEXT,
  reconciliation_id   UUID,
  run_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_adoption_runs_status ON adoption_runs(status, run_at DESC);


-- ================================================================
-- 025 + 026: reconciliation_checks table
-- ================================================================

CREATE TABLE IF NOT EXISTS reconciliation_checks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','passed','frozen','failed')),
  freeze_reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  exchange_balances    JSONB,
  internal_balances    JSONB,
  discrepancies        JSONB,
  open_orders_found    INTEGER NOT NULL DEFAULT 0,
  checks_run           JSONB,
  trading_enabled      BOOLEAN NOT NULL DEFAULT false,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recon_checks_run_at  ON reconciliation_checks(run_at DESC);


-- ================================================================
-- Columns that may already exist if any individual migration ran —
-- all use ADD COLUMN IF NOT EXISTS so they are safe to re-run.
-- ================================================================

-- From 025: position metadata columns
ALTER TABLE positions ADD COLUMN IF NOT EXISTS current_mark_price     NUMERIC(20,4);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS estimated_market_value NUMERIC(20,4);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS adoption_timestamp     TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS adoption_run_id        UUID;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'bot_managed';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS supported_universe BOOLEAN NOT NULL DEFAULT true;

-- From 026: operator classification columns
ALTER TABLE positions ADD COLUMN IF NOT EXISTS operator_classified_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS operator_note          TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS fired_trims            JSONB;

-- adoption_runs ↔ reconciliation_checks link
ALTER TABLE adoption_runs ADD COLUMN IF NOT EXISTS reconciliation_id UUID;

-- ================================================================
-- Constraints — drop first so re-running is safe
-- ================================================================

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_state_check;
ALTER TABLE positions ADD  CONSTRAINT positions_state_check
  CHECK (state IN ('open','closed','partial','adopted'));

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_strategy_tag_check;
ALTER TABLE positions ADD  CONSTRAINT positions_strategy_tag_check
  CHECK (strategy_tag IN ('core','tactical','unassigned'));

-- origin enum (skip if column was just created above with inline CHECK)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'positions' AND column_name = 'origin'
    AND column_default IS NOT NULL
  ) THEN
    ALTER TABLE positions ALTER COLUMN origin SET DEFAULT 'bot_managed';
  END IF;
END $$;

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_origin_check;
ALTER TABLE positions ADD  CONSTRAINT positions_origin_check
  CHECK (origin IN ('bot_managed','adopted_at_startup'));

-- strategy_tag default
ALTER TABLE positions ALTER COLUMN strategy_tag SET DEFAULT 'unassigned';

-- Consistency: adopted_at_startup must have adoption_timestamp
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_adopted_has_timestamp;
ALTER TABLE positions ADD  CONSTRAINT positions_adopted_has_timestamp
  CHECK (origin != 'adopted_at_startup' OR adoption_timestamp IS NOT NULL);


-- ================================================================
-- RLS — enable + service-role policy on every new table
-- ================================================================

ALTER TABLE bot_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_fills               ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE adoption_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_checks  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service" ON bot_config;
CREATE POLICY "Allow all for service" ON bot_config             FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON positions;
CREATE POLICY "Allow all for service" ON positions              FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON orders;
CREATE POLICY "Allow all for service" ON orders                 FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON v2_fills;
CREATE POLICY "Allow all for service" ON v2_fills               FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON portfolio_snapshots_v2;
CREATE POLICY "Allow all for service" ON portfolio_snapshots_v2 FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON bot_events;
CREATE POLICY "Allow all for service" ON bot_events             FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON adoption_runs;
CREATE POLICY "Allow all for service" ON adoption_runs          FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON reconciliation_checks;
CREATE POLICY "Allow all for service" ON reconciliation_checks  FOR ALL USING (true) WITH CHECK (true);
