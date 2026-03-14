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
  updated_at            TIMESTAMPTZ DEFAULT now()
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
  level             TEXT NOT NULL CHECK (level IN ('50pct', '100pct', '200pct')),
  avg_buy_price_krw NUMERIC,
  trigger_price_krw NUMERIC,
  sold_amount       NUMERIC,
  upbit_order_id    TEXT,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profit_take_log_coin_level ON crypto_profit_take_log(coin, level, triggered_at DESC);

-- RLS
ALTER TABLE crypto_trader_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_trade_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto_profit_take_log  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service" ON crypto_trader_config    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON crypto_trade_log        FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service" ON crypto_profit_take_log  FOR ALL USING (true) WITH CHECK (true);
