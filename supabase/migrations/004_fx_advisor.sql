-- FX Advisor MVP: market snapshots, advice runs, conversions, manual flags
-- FRED-only automated KRW→USD advisor

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

CREATE POLICY "Allow all for service role" ON fx_market_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON fx_advice_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON fx_conversions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON fx_manual_flags FOR ALL USING (true) WITH CHECK (true);
