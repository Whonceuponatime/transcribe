-- Migration 049: TWR benchmark configuration
--
-- Phase B: dashboard panel showing rolling TWR for actual bot NAV
-- vs a synthetic 33/33/33 BTC/ETH/XRP basket bought at inception.
-- These columns make the inception anchor, master switch, and
-- basket weights tunable from the dashboard (per the
-- "minimize manual SQL" rule).
--
-- Defaults: inception=1607 (snapshot row from 2026-04-27 11:12 UTC,
-- the first row landed after Phase 0 migration 048 unblocked the
-- writer; nav ₩3,241,457). enabled=false so the panel ships cold;
-- Sam flips it on from the dashboard after the panel renders.
-- Weights sum to exactly 1.0 (0.334 absorbs the rounding so the
-- normalized basket math stays clean).

ALTER TABLE bot_config
  ADD COLUMN IF NOT EXISTS benchmark_enabled              boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS benchmark_inception_snapshot_id bigint,
  ADD COLUMN IF NOT EXISTS benchmark_basket_weights       jsonb   DEFAULT '{"BTC":0.333,"ETH":0.333,"XRP":0.334}'::jsonb;

UPDATE bot_config
SET benchmark_enabled               = false,
    benchmark_inception_snapshot_id = 1607,
    benchmark_basket_weights        = '{"BTC":0.333,"ETH":0.333,"XRP":0.334}'::jsonb,
    updated_at                      = NOW()
WHERE id = (SELECT id FROM bot_config LIMIT 1);
