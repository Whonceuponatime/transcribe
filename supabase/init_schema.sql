-- init_schema.sql -- Full consolidated schema (all migrations in order)
-- Run this on a fresh Supabase project to set up the complete database.

-- ================================================================
-- 001_ethernet_jobs.sql
-- ================================================================
-- Ethernet cable extraction jobs and results
CREATE TABLE IF NOT EXISTS ethernet_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  vessel_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  error_msg TEXT,
  results JSONB,
  file_names TEXT[],
  storage_paths TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ethernet_jobs_user_id ON ethernet_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ethernet_jobs_status ON ethernet_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ethernet_jobs_created_at ON ethernet_jobs(created_at DESC);

-- RLS: users can read/insert their own jobs
ALTER TABLE ethernet_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own ethernet jobs" ON ethernet_jobs;
CREATE POLICY "Users can view own ethernet jobs"
  ON ethernet_jobs FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Users can insert ethernet jobs" ON ethernet_jobs;
CREATE POLICY "Users can insert ethernet jobs"
  ON ethernet_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Users can update own ethernet jobs" ON ethernet_jobs;
CREATE POLICY "Users can update own ethernet jobs"
  ON ethernet_jobs FOR UPDATE
  USING (auth.uid() = user_id OR user_id IS NULL);


-- ================================================================
-- 002_ethernet_storage.sql
-- ================================================================
-- Storage bucket for Ethernet PDF uploads (avoids Vercel payload limit)
-- Run this in Supabase SQL Editor, or create bucket manually: Storage ??New bucket ??id: ethernet-pdfs, Private, 50MB, PDF only
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'ethernet-pdfs',
  'ethernet-pdfs',
  false,
  52428800,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = 52428800,
  allowed_mime_types = ARRAY['application/pdf'];

-- Allow authenticated users to upload
DROP POLICY IF EXISTS "Authenticated users can upload ethernet PDFs" ON storage.objects;
CREATE POLICY "Authenticated users can upload ethernet PDFs"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'ethernet-pdfs');

-- Allow authenticated users to read their uploads (for cleanup)
DROP POLICY IF EXISTS "Authenticated users can read ethernet PDFs" ON storage.objects;
CREATE POLICY "Authenticated users can read ethernet PDFs"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'ethernet-pdfs');

-- Service role bypasses RLS for server-side downloads


-- ================================================================
-- 003_forex_snapshots.sql
-- ================================================================
-- Forex calculator snapshots for statistical tracking
CREATE TABLE IF NOT EXISTS forex_snapshots (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Inputs
  usd_amount     NUMERIC     NOT NULL,
  buy_rate       NUMERIC     NOT NULL,
  sell_rate      NUMERIC     NOT NULL,
  fx_fee_pct     NUMERIC     NOT NULL,
  upbit_fee_pct  NUMERIC     NOT NULL,

  -- Computed results
  cost_krw          NUMERIC  NOT NULL,
  gross_value_krw   NUMERIC  NOT NULL,
  fx_fee_amount     NUMERIC  NOT NULL,
  net_value_krw     NUMERIC  NOT NULL,
  gross_profit      NUMERIC  NOT NULL,
  profit_pct        NUMERIC  NOT NULL,
  upbit_fee_amount  NUMERIC  NOT NULL,
  investable_krw    NUMERIC  NOT NULL,

  note           TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forex_snapshots_user_id   ON forex_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_forex_snapshots_created_at ON forex_snapshots(created_at DESC);

ALTER TABLE forex_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own forex snapshots" ON forex_snapshots;
CREATE POLICY "Users can view own forex snapshots"
  ON forex_snapshots FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own forex snapshots" ON forex_snapshots;
CREATE POLICY "Users can insert own forex snapshots"
  ON forex_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own forex snapshots" ON forex_snapshots;
CREATE POLICY "Users can delete own forex snapshots"
  ON forex_snapshots FOR DELETE
  USING (auth.uid() = user_id);


-- ================================================================
-- 004_fx_advisor.sql
-- ================================================================
-- FX Advisor MVP: market snapshots, advice runs, conversions, manual flags
-- FRED-only automated KRW?뭊SD advisor

-- A. fx_market_snapshots
CREATE TABLE IF NOT EXISTS fx_market_snapshots (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date                   DATE UNIQUE NOT NULL,
  usdkrw_spot                     NUMERIC NOT NULL,
  usd_broad_index_proxy           NUMERIC,
  nasdaq100                       NUMERIC,
  korea_equity_proxy              NUMERIC,
  vix                            NUMERIC,
  us2y                           NUMERIC,
  kr_rate_proxy                   NUMERIC,
  usdkrw_ma20                     NUMERIC,
  usdkrw_ma60                     NUMERIC,
  usdkrw_ma120                    NUMERIC,
  usdkrw_zscore_20                NUMERIC,
  usdkrw_percentile_252           NUMERIC,
  usd_broad_index_proxy_ma20      NUMERIC,
  usd_broad_index_proxy_ma60      NUMERIC,
  usd_broad_index_proxy_zscore_20 NUMERIC,
  nasdaq100_return_20d             NUMERIC,
  korea_equity_proxy_return_20d   NUMERIC,
  vix_change_5d                   NUMERIC,
  rate_spread_us_minus_kr         NUMERIC,
  korea_rate_is_forward_filled    BOOLEAN DEFAULT FALSE,
  manual_event_risk_flag          BOOLEAN DEFAULT FALSE,
  manual_event_risk_note          TEXT,
  source_dates                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload                    JSONB,
  created_at                      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_market_snapshots_snapshot_date ON fx_market_snapshots(snapshot_date DESC);

-- B. fx_advice_runs
CREATE TABLE IF NOT EXISTS fx_advice_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date       DATE NOT NULL REFERENCES fx_market_snapshots(snapshot_date) ON DELETE CASCADE,
  decision            TEXT NOT NULL CHECK (decision IN ('BUY_NOW', 'SCALE_IN', 'WAIT')),
  allocation_pct      NUMERIC NOT NULL,
  confidence          NUMERIC NOT NULL,
  score               NUMERIC NOT NULL,
  valuation_label     TEXT NOT NULL CHECK (valuation_label IN ('CHEAP', 'FAIR', 'EXPENSIVE')),
  summary             TEXT NOT NULL,
  why                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  red_flags           JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_trigger_to_watch JSONB NOT NULL DEFAULT '[]'::jsonb,
  advisor_version     TEXT NOT NULL DEFAULT 'fred-v1',
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fx_advice_runs_snapshot_date ON fx_advice_runs(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_fx_advice_runs_created_at ON fx_advice_runs(created_at DESC);

-- C. fx_conversions
CREATE TABLE IF NOT EXISTS fx_conversions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_at    TIMESTAMPTZ DEFAULT now(),
  advice_run_id  UUID REFERENCES fx_advice_runs(id) ON DELETE SET NULL,
  krw_amount     NUMERIC NOT NULL,
  usd_amount     NUMERIC NOT NULL,
  fx_rate        NUMERIC NOT NULL,
  fees_krw       NUMERIC NOT NULL DEFAULT 0,
  broker         TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fx_conversions_executed_at ON fx_conversions(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_fx_conversions_advice_run_id ON fx_conversions(advice_run_id);

-- D. fx_manual_flags
CREATE TABLE IF NOT EXISTS fx_manual_flags (
  flag_date       DATE PRIMARY KEY,
  event_risk_flag BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS: service role can do everything; optionally restrict for future auth
ALTER TABLE fx_market_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_advice_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_manual_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service role" ON fx_market_snapshots;
CREATE POLICY "Allow all for service role" ON fx_market_snapshots FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service role" ON fx_advice_runs;
CREATE POLICY "Allow all for service role" ON fx_advice_runs FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service role" ON fx_conversions;
CREATE POLICY "Allow all for service role" ON fx_conversions FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service role" ON fx_manual_flags;
CREATE POLICY "Allow all for service role" ON fx_manual_flags FOR ALL USING (true) WITH CHECK (true);


-- ================================================================
-- 005_live_trading.sql
-- ================================================================
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

DROP POLICY IF EXISTS "Allow all for service" ON market_ticks;
CREATE POLICY "Allow all for service" ON market_ticks FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON market_bars_1m;
CREATE POLICY "Allow all for service" ON market_bars_1m FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON signal_runs;
CREATE POLICY "Allow all for service" ON signal_runs FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON order_requests;
CREATE POLICY "Allow all for service" ON order_requests FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON order_events;
CREATE POLICY "Allow all for service" ON order_events FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON fills;
CREATE POLICY "Allow all for service" ON fills FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON portfolio_snapshots;
CREATE POLICY "Allow all for service" ON portfolio_snapshots FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON risk_events;
CREATE POLICY "Allow all for service" ON risk_events FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON app_settings;
CREATE POLICY "Allow all for service" ON app_settings FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON provider_health;
CREATE POLICY "Allow all for service" ON provider_health FOR ALL USING (true) WITH CHECK (true);


-- ================================================================
-- 006_analyzer.sql
-- ================================================================
-- Analyzer-only KRW?뭊SD advisor: no execution, manual trading only.
-- Live quotes (Massive/Finnhub), 1m bars, snapshots, signals, manual trade journal.

-- 1. fx_live_quotes
CREATE TABLE IF NOT EXISTS fx_live_quotes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  bid         NUMERIC,
  ask         NUMERIC,
  mid         NUMERIC,
  spread      NUMERIC,
  quote_ts    TIMESTAMPTZ NOT NULL,
  received_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_stale    BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fx_live_quotes_quote_ts ON fx_live_quotes(quote_ts DESC);
CREATE INDEX IF NOT EXISTS idx_fx_live_quotes_symbol ON fx_live_quotes(symbol, quote_ts DESC);

-- 2. fx_bars_1m
CREATE TABLE IF NOT EXISTS fx_bars_1m (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  provider    TEXT NOT NULL,
  bucket_ts   TIMESTAMPTZ NOT NULL,
  open        NUMERIC NOT NULL,
  high        NUMERIC NOT NULL,
  low         NUMERIC NOT NULL,
  close       NUMERIC NOT NULL,
  source_count INTEGER DEFAULT 0,
  raw_payload JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(symbol, provider, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_fx_bars_1m_bucket_ts ON fx_bars_1m(symbol, bucket_ts DESC);

-- 3. fx_analyzer_snapshots (valuation + macro context per snapshot)
CREATE TABLE IF NOT EXISTS fx_analyzer_snapshots (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_ts             TIMESTAMPTZ NOT NULL UNIQUE,
  symbol                  TEXT NOT NULL,
  live_provider           TEXT NOT NULL,
  spot                    NUMERIC NOT NULL,
  bid                     NUMERIC,
  ask                     NUMERIC,
  spread                  NUMERIC,
  ma20                    NUMERIC,
  ma60                    NUMERIC,
  ma120                   NUMERIC,
  zscore20                NUMERIC,
  percentile252           NUMERIC,
  usd_broad_index_proxy   NUMERIC,
  usd_broad_index_proxy_ma20 NUMERIC,
  nasdaq100               NUMERIC,
  nasdaq100_return_20d    NUMERIC,
  vix                     NUMERIC,
  vix_change_5d           NUMERIC,
  macro_payload           JSONB,
  source_dates            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fx_analyzer_snapshots_ts ON fx_analyzer_snapshots(snapshot_ts DESC);

-- 4. fx_signal_runs (analyzer decisions)
CREATE TABLE IF NOT EXISTS fx_signal_runs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_ts            TIMESTAMPTZ NOT NULL UNIQUE,
  symbol               TEXT NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('BUY_NOW', 'SCALE_IN', 'WAIT')),
  allocation_pct       NUMERIC NOT NULL,
  confidence           NUMERIC NOT NULL,
  score                NUMERIC NOT NULL,
  valuation_label      TEXT NOT NULL,
  live_provider        TEXT NOT NULL,
  quote_timestamp      TIMESTAMPTZ,
  is_stale             BOOLEAN NOT NULL DEFAULT FALSE,
  summary              TEXT NOT NULL,
  why                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  red_flags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_trigger_to_watch JSONB NOT NULL DEFAULT '[]'::jsonb,
  levels               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fx_signal_runs_signal_ts ON fx_signal_runs(signal_ts DESC);

-- 5. fx_manual_trades (user logs trades manually)
CREATE TABLE IF NOT EXISTS fx_manual_trades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  action            TEXT NOT NULL CHECK (action IN ('BUY_USD', 'SELL_USD')),
  krw_amount        NUMERIC,
  usd_amount        NUMERIC,
  fx_rate           NUMERIC,
  fees_krw          NUMERIC DEFAULT 0,
  note              TEXT,
  related_signal_id UUID REFERENCES fx_signal_runs(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fx_manual_trades_trade_ts ON fx_manual_trades(trade_ts DESC);

-- 6. provider_health (reuse if exists from 005)
CREATE TABLE IF NOT EXISTS provider_health (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  checked_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  latency_ms   INTEGER,
  stale_seconds INTEGER,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_health_provider_checked ON provider_health(provider, checked_at DESC);

-- 7. crypto_purchases (log crypto buys made with USD)
CREATE TABLE IF NOT EXISTS crypto_purchases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bought_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  coin        TEXT NOT NULL,
  usd_spent   NUMERIC NOT NULL,
  coin_amount NUMERIC NOT NULL,
  price_usd   NUMERIC NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crypto_purchases_bought_at ON crypto_purchases(bought_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_purchases_coin ON crypto_purchases(coin);

ALTER TABLE fx_live_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_bars_1m ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_analyzer_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_signal_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_manual_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service" ON fx_live_quotes;
CREATE POLICY "Allow all for service" ON fx_live_quotes FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON fx_bars_1m;
CREATE POLICY "Allow all for service" ON fx_bars_1m FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON fx_analyzer_snapshots;
CREATE POLICY "Allow all for service" ON fx_analyzer_snapshots FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON fx_signal_runs;
CREATE POLICY "Allow all for service" ON fx_signal_runs FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON fx_manual_trades;
CREATE POLICY "Allow all for service" ON fx_manual_trades FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON provider_health;
CREATE POLICY "Allow all for service" ON provider_health FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE crypto_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service" ON crypto_purchases;
CREATE POLICY "Allow all for service" ON crypto_purchases FOR ALL USING (true) WITH CHECK (true);


-- ================================================================
-- 007_crypto_trader.sql
-- ================================================================
-- Crypto trader: DCA config, trade log, profit-take log

-- Config: one active row, updated in place
CREATE TABLE IF NOT EXISTS crypto_trader_config (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dca_enabled           BOOLEAN NOT NULL DEFAULT true,
  weekly_budget_krw     NUMERIC NOT NULL DEFAULT 100000,
  coins                 JSONB NOT NULL DEFAULT '["BTC","ETH","SOL"]'::jsonb,
  split                 JSONB NOT NULL DEFAULT '{"BTC":50,"ETH":30,"SOL":20}'::jsonb,
  profit_take_enabled   BOOLEAN NOT NULL DEFAULT true,
  signal_boost_enabled  BOOLEAN NOT NULL DEFAULT true,
  last_dca_run          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  -- Stop-loss: sell 50% if position drops this % and held >24h (0 = disabled)
  stop_loss_pct         NUMERIC(5,2) NOT NULL DEFAULT 0
);

-- Seed default config row
INSERT INTO crypto_trader_config (dca_enabled, weekly_budget_krw, coins, split, profit_take_enabled, signal_boost_enabled)
VALUES (true, 100000, '["BTC","ETH","SOL"]'::jsonb, '{"BTC":50,"ETH":30,"SOL":20}'::jsonb, true, true)
ON CONFLICT DO NOTHING;

-- Every trade the bot executes (buy or sell)
CREATE TABLE IF NOT EXISTS crypto_trade_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin           TEXT NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  krw_amount     NUMERIC,
  coin_amount    NUMERIC,
  price_krw      NUMERIC,
  reason         TEXT NOT NULL,
  upbit_order_id TEXT,
  signal_score   NUMERIC,
  executed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crypto_trade_log_executed ON crypto_trade_log(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_trade_log_coin ON crypto_trade_log(coin, executed_at DESC);

-- Profit-take trigger log (prevents re-firing same level)
CREATE TABLE IF NOT EXISTS crypto_profit_take_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coin              TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN (
                      '1.5pct','3pct','5pct',
                      '10pct','20pct','40pct','80pct',
                      'rsi_ob','rsi_ob_strong','rsi_recovery',
                      'bb_upper','macd_bear','stochrsi_ob',
                      'vwap_above','williams_ob','cci_ob','kimchi_high',
                      'modest_recovery','trailing_stop','stop_loss'
                    )),
  avg_buy_price_krw NUMERIC,
  trigger_price_krw NUMERIC,
  sold_amount       NUMERIC,
  upbit_order_id    TEXT,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profit_take_log_coin_level ON crypto_profit_take_log(coin, level, triggered_at DESC);

-- Bot log table (Pi writes cycle summaries; dashboard reads last N rows)
CREATE TABLE IF NOT EXISTS crypto_bot_logs (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  tag        TEXT,
  message    TEXT NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_logs_created ON crypto_bot_logs(created_at DESC);

-- RLS
ALTER TABLE crypto_trader_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_trade_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_profit_take_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_bot_logs         ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for service" ON crypto_trader_config;
CREATE POLICY "Allow all for service" ON crypto_trader_config    FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON crypto_trade_log;
CREATE POLICY "Allow all for service" ON crypto_trade_log        FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON crypto_profit_take_log;
CREATE POLICY "Allow all for service" ON crypto_profit_take_log  FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all for service" ON crypto_bot_logs;
CREATE POLICY "Allow all for service" ON crypto_bot_logs         FOR ALL USING (true) WITH CHECK (true);


-- ================================================================
-- 023_v2_schema.sql
-- ================================================================
-- Bot v2: bot_config, positions, orders, fills, portfolio_snapshots_v2, bot_events

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

CREATE TABLE IF NOT EXISTS positions (
  position_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset           TEXT NOT NULL,
  strategy_tag    TEXT NOT NULL DEFAULT 'unassigned' CHECK (strategy_tag IN ('core','tactical','unassigned')),
  qty_open        NUMERIC(24,10) NOT NULL DEFAULT 0,
  qty_total       NUMERIC(24,10) NOT NULL DEFAULT 0,
  avg_cost_krw    NUMERIC(20,4)  NOT NULL DEFAULT 0,
  realized_pnl    NUMERIC(20,4)  NOT NULL DEFAULT 0,
  entry_regime    TEXT CHECK (entry_regime IN ('UPTREND','RANGE','DOWNTREND')),
  entry_reason    TEXT,
  atr_at_entry    NUMERIC(20,4),
  spread_estimate NUMERIC(10,6),
  usd_proxy_fx    NUMERIC(12,4),
  state                   TEXT     NOT NULL DEFAULT 'open'        CHECK (state    IN ('open','closed','partial','adopted')),
  origin                  TEXT     NOT NULL DEFAULT 'bot_managed'  CHECK (origin   IN ('bot_managed','adopted_at_startup')),
  managed                 BOOLEAN  NOT NULL DEFAULT true,
  supported_universe      BOOLEAN  NOT NULL DEFAULT true,
  current_mark_price      NUMERIC(20,4),
  estimated_market_value  NUMERIC(20,4),
  adoption_timestamp      TIMESTAMPTZ,
  adoption_run_id         UUID,
  operator_classified_at  TIMESTAMPTZ,
  operator_note           TEXT,
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
CREATE INDEX IF NOT EXISTS idx_orders_asset_state ON orders(asset, state);
CREATE INDEX IF NOT EXISTS idx_orders_identifier  ON orders(identifier);
CREATE INDEX IF NOT EXISTS idx_orders_created     ON orders(created_at DESC);

-- v2_fills: renamed from 'fills' to avoid conflict with live-trading fills table
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
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warn','error','critical')),
  subsystem    TEXT NOT NULL,
  message      TEXT NOT NULL,
  context_json JSONB,
  regime       TEXT,
  mode         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_events_created  ON bot_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_events_type_sev ON bot_events(event_type, severity);

ALTER TABLE bot_config             ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE v2_fills               ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_events             ENABLE ROW LEVEL SECURITY;

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

-- ================================================================
-- 024_portfolio_adoption.sql
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

ALTER TABLE adoption_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service" ON adoption_runs;
CREATE POLICY "Allow all for service" ON adoption_runs FOR ALL USING (true) WITH CHECK (true);

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
CREATE INDEX IF NOT EXISTS idx_recon_checks_run_at ON reconciliation_checks(run_at DESC);

ALTER TABLE reconciliation_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for service" ON reconciliation_checks;
CREATE POLICY "Allow all for service" ON reconciliation_checks FOR ALL USING (true) WITH CHECK (true);
