ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS max_xrp_pct numeric DEFAULT 35;

UPDATE bot_config
SET coins       = '["BTC","ETH","XRP"]',
    max_xrp_pct = 35,
    updated_at  = NOW()
WHERE id = (SELECT id FROM bot_config LIMIT 1);
