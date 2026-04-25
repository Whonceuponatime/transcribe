CREATE TABLE IF NOT EXISTS cash_movements (
  id                bigserial PRIMARY KEY,
  uuid              text,
  type              text NOT NULL CHECK (type IN ('deposit','withdraw')),
  currency          text NOT NULL,
  txid              text,
  state             text NOT NULL,
  transaction_type  text,
  net_type          text,
  amount            numeric NOT NULL,
  fee               numeric NOT NULL DEFAULT 0,
  is_cancelable     boolean,
  upbit_created_at  timestamptz NOT NULL,
  upbit_done_at     timestamptz,
  inserted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_movements_uuid
  ON cash_movements(uuid) WHERE uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_movements_uuid_full
  ON cash_movements(uuid);
CREATE INDEX IF NOT EXISTS idx_cash_movements_done_at
  ON cash_movements(upbit_done_at);

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS cash_poller_enabled          boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS cash_poll_interval_ms        integer DEFAULT 300000,
  ADD COLUMN IF NOT EXISTS cash_backfill_window_days    integer DEFAULT 90,
  ADD COLUMN IF NOT EXISTS cash_settled_states_deposit  text[]  DEFAULT ARRAY['ACCEPTED'],
  ADD COLUMN IF NOT EXISTS cash_settled_states_withdraw text[]  DEFAULT ARRAY['DONE'];

UPDATE bot_config
SET cash_poller_enabled          = false,
    cash_poll_interval_ms        = 300000,
    cash_backfill_window_days    = 90,
    cash_settled_states_deposit  = ARRAY['ACCEPTED'],
    cash_settled_states_withdraw = ARRAY['DONE'],
    updated_at = NOW()
WHERE id = (SELECT id FROM bot_config LIMIT 1);
