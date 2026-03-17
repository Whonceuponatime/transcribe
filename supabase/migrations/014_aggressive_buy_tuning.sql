-- Migration 014: Aggressive buy tuning for higher risk / higher reward profile.
--
-- Changes applied in bot code (lib/cryptoTrader.js):
--   • convictionMult: 2.0/1.6/1.3/1.1 → 2.5/2.0/1.5/1.2 across score tiers
--   • dcaCooldownDays: shortens at score ≥4 (was ≥6) and score ≥1 → 4d (was ≥3 → 5d); max 6d (was 7d)
--   • Dip thresholds loosened: 24h mom -8→-6%, VWAP -3→-2%, Williams -90→-85,
--     CCI -150→-120, RSI <30→<32, StochRSI <15→<20, ROC -6→-5%
--   • MACD cooldown reduced 6h→5h; CCI/RSI/ROC cooldowns 4h→3h
--   • 3 new dip signals added: DIP_RSI7_EXTREME_OS, DIP_HIGH_SCORE (score≥5), DIP_BB_NEAR_LOWER
--   • trailing_stop_pct default: 30 → 20 (protect gains tighter)
--
-- This migration applies the trailing_stop_pct change to the live config row.

UPDATE crypto_trader_config
SET trailing_stop_pct = 20,
    updated_at = NOW()
WHERE trailing_stop_pct IS NULL OR trailing_stop_pct >= 30;
