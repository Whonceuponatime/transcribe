-- Migration 023: Bot v2 schema
-- Adds: bot_config, positions, orders, fills, portfolio_snapshots (v2), bot_events
-- These tables support the v2 regime engine, sleeve-tracked positions,
-- execution state machine, and USD-proxy NAV tracking.
-- The existing v1 tables (crypto_trader_config, crypto_trade_log, etc.) are NOT removed
-- so the v1 bot can continue running while v2 is verified in paper mode.

-- ── bot_config ────────────────────────────────────────────────────────────────
-- Single-row v2 config. mode controls paper/shadow/live behaviour.
CREATE TABLE IF NOT EXISTS bot_config (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                     TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','shadow','live')),
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  -- Tradable assets
  coins                    JSONB NOT NULL DEFAULT '["BTC","ETH","SOL"]'::jsonb,
  -- Sleeve target ranges (% of NAV)
  core_target_pct          NUMERIC(5,2) NOT NULL DEFAULT 30,
  tactical_target_pct      NUMERIC(5,2) NOT NULL DEFAULT 15,
  krw_min_reserve_pct      NUMERIC(5,2) NOT NULL DEFAULT 12,
  -- Entry signal thresholds (tunable without code changes)
  entry_bb_pct_uptrend     NUMERIC(5,3) NOT NULL DEFAULT 0.25,
  entry_rsi_min_uptrend    NUMERIC(5,2) NOT NULL DEFAULT 35,
  entry_rsi_max_uptrend    NUMERIC(5,2) NOT NULL DEFAULT 45,
  entry_bb_pct_range       NUMERIC(5,3) NOT NULL DEFAULT 0.10,
  entry_rsi_max_range      NUMERIC(5,2) NOT NULL DEFAULT 35,
  entry_bb_pct_downtrend   NUMERIC(5,3) NOT NULL DEFAULT 0.05,
  entry_rsi_max_downtrend  NUMERIC(5,2) NOT NULL DEFAULT 28,
  ob_imbalance_min         NUMERIC(5,3) NOT NULL DEFAULT -0.30,
  -- ATR exit multipliers
  exit_atr_trim1           NUMERIC(5,2) NOT NULL DEFAULT 1.20,
  exit_atr_trim2           NUMERIC(5,2) NOT NULL DEFAULT 2.00,
  exit_atr_trailing        NUMERIC(5,2) NOT NULL DEFAULT 1.50,
  exit_time_stop_hours     NUMERIC(6,1) NOT NULL DEFAULT 30,
  -- Regime engine hysteresis thresholds
  regime_adx_uptrend       NUMERIC(5,2) NOT NULL DEFAULT 20,
  regime_adx_range_exit    NUMERIC(5,2) NOT NULL DEFAULT 25,
  regime_ema_range_pct     NUMERIC(5,3) NOT NULL DEFAULT 0.02,
  -- Risk/exposure caps
  max_btc_pct              NUMERIC(5,2) NOT NULL DEFAULT 35,
  max_eth_pct              NUMERIC(5,2) NOT NULL DEFAULT 25,
  max_sol_pct              NUMERIC(5,2) NOT NULL DEFAULT 10,
  max_risk_per_signal_pct  NUMERIC(5,2) NOT NULL DEFAULT 2,
  max_entries_per_coin_24h INTEGER      NOT NULL DEFAULT 3,
  daily_turnover_cap_pct   NUMERIC(5,2) NOT NULL DEFAULT 35,
  loss_streak_limit        INTEGER      NOT NULL DEFAULT 5,
  drawdown_7d_threshold    NUMERIC(5,2) NOT NULL DEFAULT -4,
  -- Stop-loss
  stop_loss_pct            NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- Timestamps
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed one default config row
INSERT INTO bot_config DEFAULT VALUES ON CONFLICT DO NOTHING;

-- ── positions ─────────────────────────────────────────────────────────────────
-- Tracks open and historical sleeve positions separately.
-- Tactical exits may never consume core quantity.
CREATE TABLE IF NOT EXISTS positions (
  position_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset          TEXT NOT NULL,
  strategy_tag   TEXT NOT NULL CHECK (strategy_tag IN ('core','tactical')),
  qty_open       NUMERIC(24,10) NOT NULL DEFAULT 0,
  qty_total      NUMERIC(24,10) NOT NULL DEFAULT 0,
  avg_cost_krw   NUMERIC(20,4)  NOT NULL DEFAULT 0,
  realized_pnl   NUMERIC(20,4)  NOT NULL DEFAULT 0,
  entry_regime   TEXT CHECK (entry_regime IN ('UPTREND','RANGE','DOWNTREND')),
  entry_reason   TEXT,
  atr_at_entry   NUMERIC(20,4),
  spread_estimate NUMERIC(10,6),
  usd_proxy_fx   NUMERIC(12,4),
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','partial')),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_asset_state ON positions(asset, state);
CREATE INDEX IF NOT EXISTS idx_positions_strategy    ON positions(strategy_tag, state);

-- ── orders ────────────────────────────────────────────────────────────────────
-- Every order intent and its exchange lifecycle.
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier      UUID NOT NULL UNIQUE,  -- client-side idempotency key, sent to Upbit
  exchange_uuid   TEXT,                  -- Upbit's uuid returned on acceptance
  asset           TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  order_type      TEXT NOT NULL DEFAULT 'market',
  qty_requested   NUMERIC(24,10),
  krw_requested   NUMERIC(20,4),
  price_submitted NUMERIC(20,4),
  strategy_tag    TEXT CHECK (strategy_tag IN ('core','tactical')),
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
CREATE INDEX IF NOT EXISTS idx_orders_asset_state    ON orders(asset, state);
CREATE INDEX IF NOT EXISTS idx_orders_identifier     ON orders(identifier);
CREATE INDEX IF NOT EXISTS idx_orders_created        ON orders(created_at DESC);

-- ── fills ─────────────────────────────────────────────────────────────────────
-- Atomic executions — one row per partial or full fill.
CREATE TABLE IF NOT EXISTS fills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id),
  position_id     UUID REFERENCES positions(position_id),
  asset           TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price_krw       NUMERIC(20,4)  NOT NULL,
  qty             NUMERIC(24,10) NOT NULL,
  fee_krw         NUMERIC(20,4)  NOT NULL DEFAULT 0,
  fee_rate        NUMERIC(8,6)   NOT NULL DEFAULT 0.0025,
  strategy_tag    TEXT CHECK (strategy_tag IN ('core','tactical')),
  entry_regime    TEXT,
  entry_reason    TEXT,
  atr_at_entry    NUMERIC(20,4),
  spread_estimate NUMERIC(10,6),
  usd_proxy_fx    NUMERIC(12,4),
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fills_order_id   ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_asset_time ON fills(asset, executed_at DESC);

-- ── portfolio_snapshots (v2) ───────────────────────────────────────────────────
-- Point-in-time NAV with USD-proxy tracking.
-- Separate from app_settings so it's a queryable time-series.
CREATE TABLE IF NOT EXISTS portfolio_snapshots_v2 (
  id              BIGSERIAL PRIMARY KEY,
  nav_krw         NUMERIC(20,4) NOT NULL,
  nav_usd_proxy   NUMERIC(20,4),           -- nav_krw / usdt_krw_rate
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
  alpha_vs_btc    NUMERIC(10,4),           -- % gain vs passive BTC hold from session start
  circuit_breakers JSONB,                  -- which brakes are currently active
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_created ON portfolio_snapshots_v2(created_at DESC);

-- ── bot_events ────────────────────────────────────────────────────────────────
-- Structured audit log. Replaces crypto_bot_logs for v2 subsystems.
-- v1 crypto_bot_logs is kept untouched.
CREATE TABLE IF NOT EXISTS bot_events (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warn','error','critical')),
  subsystem    TEXT NOT NULL,
  message      TEXT NOT NULL,
  context_json JSONB,
  regime       TEXT,
  mode         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_events_created   ON bot_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_events_type_sev  ON bot_events(event_type, severity);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE bot_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE fills                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_events             ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service" ON bot_config;
CREATE POLICY "Allow all for service" ON bot_config             FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON positions;
CREATE POLICY "Allow all for service" ON positions              FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON orders;
CREATE POLICY "Allow all for service" ON orders                 FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON fills;
CREATE POLICY "Allow all for service" ON fills                  FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON portfolio_snapshots_v2;
CREATE POLICY "Allow all for service" ON portfolio_snapshots_v2 FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON bot_events;
CREATE POLICY "Allow all for service" ON bot_events             FOR ALL USING (true) WITH CHECK (true);
