-- Analyzer-only KRW→USD advisor: no execution, manual trading only.
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

CREATE POLICY "Allow all for service" ON fx_live_quotes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON fx_bars_1m FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON fx_analyzer_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON fx_signal_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON fx_manual_trades FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON provider_health FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE crypto_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service" ON crypto_purchases FOR ALL USING (true) WITH CHECK (true);
