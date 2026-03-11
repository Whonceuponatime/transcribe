-- Live trading: market data, signals, orders, fills, risk, settings, provider health
-- PAPER mode default; LIVE requires explicit env.

-- market_ticks
CREATE TABLE IF NOT EXISTS market_ticks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  bid         NUMERIC,
  ask         NUMERIC,
  mid         NUMERIC,
  spread      NUMERIC,
  event_ts    TIMESTAMPTZ NOT NULL,
  received_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_event_ts ON market_ticks(symbol, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_market_ticks_provider ON market_ticks(provider, event_ts DESC);

-- market_bars_1m
CREATE TABLE IF NOT EXISTS market_bars_1m (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  bucket_ts   TIMESTAMPTZ NOT NULL,
  open        NUMERIC NOT NULL,
  high        NUMERIC NOT NULL,
  low         NUMERIC NOT NULL,
  close       NUMERIC NOT NULL,
  volume      NUMERIC,
  trade_count INTEGER,
  source      JSONB,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(provider, symbol, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_market_bars_1m_symbol_bucket ON market_bars_1m(symbol, bucket_ts DESC);

-- signal_runs
CREATE TABLE IF NOT EXISTS signal_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol         TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('paper', 'live', 'backtest')),
  score          NUMERIC,
  decision       TEXT NOT NULL CHECK (decision IN ('BUY_NOW', 'SCALE_IN', 'WAIT', 'BLOCKED_BY_RISK')),
  allocation_pct NUMERIC,
  confidence     NUMERIC,
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  safeguards     JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot       JSONB,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signal_runs_signal_ts ON signal_runs(signal_ts DESC);
CREATE INDEX IF NOT EXISTS idx_signal_runs_decision ON signal_runs(decision, signal_ts DESC);

-- order_requests
CREATE TABLE IF NOT EXISTS order_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_order_id  TEXT NOT NULL UNIQUE,
  signal_run_id    UUID REFERENCES signal_runs(id) ON DELETE SET NULL,
  broker           TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type       TEXT NOT NULL,
  quantity         NUMERIC NOT NULL,
  notional_krw    NUMERIC,
  limit_price      NUMERIC,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'filled', 'partial', 'cancelled', 'rejected', 'unknown')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_requests_idempotency ON order_requests(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_order_requests_created_at ON order_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_requests_signal_run_id ON order_requests(signal_run_id);

-- order_events
CREATE TABLE IF NOT EXISTS order_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_request_id UUID NOT NULL REFERENCES order_requests(id) ON DELETE CASCADE,
  broker_order_id  TEXT,
  event_type       TEXT NOT NULL,
  event_ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload          JSONB,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_events_order_request_id ON order_events(order_request_id);

-- fills
CREATE TABLE IF NOT EXISTS fills (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_request_id UUID NOT NULL REFERENCES order_requests(id) ON DELETE CASCADE,
  broker_fill_id   TEXT,
  fill_ts          TIMESTAMPTZ NOT NULL,
  quantity         NUMERIC NOT NULL,
  price            NUMERIC NOT NULL,
  fees             NUMERIC DEFAULT 0,
  liquidity        TEXT,
  payload          JSONB,
  created_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fills_order_request_id ON fills(order_request_id);
CREATE INDEX IF NOT EXISTS idx_fills_fill_ts ON fills(fill_ts DESC);

-- portfolio_snapshots
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  krw_cash          NUMERIC NOT NULL DEFAULT 0,
  usd_cash          NUMERIC NOT NULL DEFAULT 0,
  avg_buy_rate      NUMERIC,
  unrealized_pnl_krw NUMERIC,
  realized_pnl_krw  NUMERIC,
  source            JSONB,
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_snapshot_ts ON portfolio_snapshots(snapshot_ts DESC);

-- risk_events
CREATE TABLE IF NOT EXISTS risk_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity   TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  category   TEXT NOT NULL,
  message    TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_events_event_ts ON risk_events(event_ts DESC);

-- app_settings (key-value for kill_switch, mode, caps, etc.)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- provider_health
CREATE TABLE IF NOT EXISTS provider_health (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  latency_ms    INTEGER,
  stale_seconds NUMERIC,
  details       JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_health_provider_checked ON provider_health(provider, checked_at DESC);

-- Seed default app_settings
INSERT INTO app_settings (key, value, updated_at) VALUES
  ('kill_switch', '{"enabled": false}'::jsonb, now()),
  ('trading_mode', '{"mode": "paper"}'::jsonb, now()),
  ('max_daily_notional_krw', '{"value": 10000000}'::jsonb, now()),
  ('max_single_order_krw', '{"value": 2000000}'::jsonb, now()),
  ('order_cooldown_seconds', '{"value": 300}'::jsonb, now()),
  ('stale_data_seconds', '{"value": 60}'::jsonb, now()),
  ('max_spread_bps', '{"value": 50}'::jsonb, now()),
  ('circuit_breaker_failures', '{"value": 5}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

ALTER TABLE market_ticks ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_bars_1m ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE fills ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service" ON market_ticks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON market_bars_1m FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON signal_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON order_requests FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON order_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON fills FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON portfolio_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON risk_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON app_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON provider_health FOR ALL USING (true) WITH CHECK (true);
