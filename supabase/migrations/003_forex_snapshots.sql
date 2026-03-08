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

CREATE POLICY "Users can view own forex snapshots"
  ON forex_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own forex snapshots"
  ON forex_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own forex snapshots"
  ON forex_snapshots FOR DELETE
  USING (auth.uid() = user_id);
