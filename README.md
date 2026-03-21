# Crypto Trading Bot v2 — Upbit (KRW)

Automated signal-driven trading bot for BTC, ETH, and SOL on the Korean Upbit exchange.  
Runs 24/7 on a Raspberry Pi. Dashboard hosted on Vercel. Data stored in Supabase.

**Primary objective: grow USD-proxy NAV, not KRW balance.**  
The thesis is KRW weakness relative to USD and crypto. Measuring in KRW is circular — a coin that holds its USD value while KRW weakens looks like a gain in the wrong scorecard. All performance tracking uses USD-proxy (KRW ÷ USDT/KRW rate).

---

## Architecture

```
Raspberry Pi (pi-trader/index.js)
  └── Cron jobs every 2 min (sell) / 5 min (buy)
  └── Calls lib/cryptoTrader.js for every cycle
  └── Writes structured logs + portfolio snapshots to Supabase

Vercel (api/crypto-trader.js)
  └── Serverless API reads from Supabase
  └── Serves the React dashboard

React Dashboard (client/src/)
  └── Portfolio, indicators, logs, settings
  └── Pull & Restart deploys new code to Pi remotely
  └── Export Logs downloads 7 days of data for AI analysis

Supabase
  └── Config, trade log, bot logs, portfolio snapshots
```

---

## Performance Scoreboard (what actually matters)

Every cycle tracks three equity curves:

| Metric | Description |
|--------|-------------|
| `nav_krw` | Raw KRW value of portfolio |
| `nav_usd_proxy` | `nav_krw ÷ (USDT/KRW rate)` — true USD-equivalent |
| `alpha_vs_btc_hold` | nav_usd_proxy minus what you'd have if you just held BTC |

If `nav_usd_proxy` is growing, the bot is working. If it's flat or negative while BTC goes up, the bot is underperforming a simple hold strategy.

---

## Portfolio Structure (v2)

Four buckets instead of "KRW cash + coins":

| Bucket | Target % | Asset | Purpose |
|--------|----------|-------|---------|
| USD-proxy reserve | 35–50% | USDT | Protects against KRW weakness; deployed in downtrend exits *(Phase 2)* |
| Core exposure | 25–40% | BTC, ETH | Long-term directional positions |
| Tactical rotation | 10–20% | BTC, ETH, SOL | Active swing trades based on regime signals |
| KRW execution cash | 10% | KRW | Fees, minimum orders, immediate entries only |

> **Phase 1 (current):** USDT bucket is replaced by a hard 15% KRW cash reserve floor while USDT trading is being built.  
> **Phase 2:** Bot routes downtrend sell proceeds into USDT instead of KRW.

---

## Regime Engine (runs before every signal)

The bot classifies market regime once per cycle from BTC 4h data. All buy and sell logic branches from this.

### Uptrend
- BTC 4h close > EMA200
- EMA50 > EMA200
- ADX > 20 (trending, not just choppy)
- **Allowed:** Pullback buys on BTC, ETH, SOL — 50% size first, 1 add allowed
- **Entry condition:** z-score ≤ −1.5 OR price ≤ VWAP − 1.2×ATR, AND RSI 35–45

### Range
- EMA50 and EMA200 within 2% of each other
- ADX < 20 (low trend strength, mean-reverting)
- **Allowed:** Mean-reversion scalps — smaller size
- **Entry condition:** z-score ≤ −2.0 AND BB %B < 0.05 AND RSI < 35

### Downtrend
- BTC 4h close < EMA200
- EMA50 < EMA200
- **Disabled:** SOL buys entirely
- **Allowed:** BTC and ETH only, half size, extreme oversold + reversal confirmation required
- **On sell:** Proceeds rotate toward USDT (Phase 2) or KRW reserve
- **Never:** Average down after regime flips to downtrend

> **Replaces:** The current "bear market pause" which only fires when BTC is already 30% below its 90-day high — that is deep bear territory, weeks too late.

---

## Signal Stack (simplified — 4 factors only)

Too many correlated indicators inflate confidence without adding edge. RSI, StochRSI, Williams %R, and CCI all measure the same thing. The live decision engine uses exactly 4 signal buckets:

| Bucket | Indicator | Purpose |
|--------|-----------|---------|
| **Trend** | EMA50/EMA200 slope, MACD slope | Is the market going somewhere or drifting? |
| **Stretch** | Bollinger %B (single choice) | How far from mean? |
| **Momentum** | RSI (14) only | Overbought / oversold confirmation |
| **Execution** | Order book imbalance, spread estimate | Is now a good time to fill? |

All other indicators (StochRSI, Williams %R, CCI, ROC, OBV, Kimchi Premium) are **still logged** for research and analysis but do not drive live buy/sell decisions.

**Why Bollinger %B over z-score:** %B is already normalized 0–1 and directly comparable across coins and time. z-score requires rolling window calibration to be meaningful.

---

## Entry Logic (by regime)

### Uptrend — pullback entries only
```
Conditions (ALL required):
  z-score ≤ -1.5  OR  price ≤ VWAP - 1.2 × ATR
  RSI 35–45
  No fresh 4h breakdown (price not making lower lows on 4h)
  Order book imbalance not strongly negative

Sizing:
  First entry: 50% of signal budget
  One add allowed: if price drops another 0.8–1.0 ATR AND regime unchanged
  Never a third add
```

### Range — mean-reversion scalps
```
Conditions (ALL required):
  z-score ≤ -2.0
  BB %B < 0.05
  RSI < 35

Sizing:
  60% of uptrend entry size (smaller — edge is lower in range)
```

### Downtrend — extreme oversold only
```
Conditions (ALL required):
  z-score ≤ -2.5
  RSI < 28
  Volume spike confirming capitulation (relative volume > 2×)
  BTC/ETH only — no SOL

Sizing:
  50% of uptrend entry size
```

> **Removes:** The "relaxed buy gate" that allowed buying at RSI 72 when over-cashed. That was momentum chasing in disguise. Over-cashed in a downtrend means wait or hold KRW/USDT, not lower the buy threshold.

---

## Exit Logic (ATR-based, replaces static % ladder)

Dynamic exits based on actual market volatility. ATR adjusts automatically — tight when market is calm, wide when volatile.

```
required_edge = fee (0.25% × 2) + spread_estimate + 0.20% safety buffer = ~0.70% minimum

Exit structure (per position):
  Tranche 1 (25%): at +1.2 × ATR gain
  Tranche 2 (35%): at +2.0 × ATR gain  OR  RSI > 65
  Tranche 3 (40%): 1.5 × ATR trailing stop from peak

Time stop:
  If trade open > 30h AND gain < +0.5%: exit 50% to recycle capital
  Capital tied up in flat trades blocks better entries

Regime break exit:
  If BTC flips from uptrend → downtrend:
    Cut SOL tactical sleeve immediately (100%)
    Reduce tactical BTC/ETH by 50%
    Rotate proceeds to USDT (Phase 2) or KRW reserve
```

**Stop-loss (hard limit):**  
If position is down > configurable % for > 24h: sell 50%.  
Default off — enable in dashboard settings.

> **Replaces:** The static staircase (+1.5%, +3%, +5%, +10%, +20%, +40%, +80%). Those are reasonable targets but are completely blind to whether the market is calm or volatile. ATR makes them adapt.

---

## Risk Rules (portfolio-level)

Trade-level limits are not enough. These rules apply across the whole portfolio:

| Rule | Limit |
|------|-------|
| Max BTC exposure | 35% of NAV |
| Max ETH exposure | 25% of NAV |
| Max SOL exposure | 10% of NAV |
| Max new risk per signal | 2% of NAV |
| Max entries per coin per 24h | 3 |
| Daily turnover cap | 30–40% of NAV |
| Consecutive losing exits circuit breaker | 5 in a row → pause tactical buys 24h |
| 7-day realized drawdown circuit breaker | < −4% NAV → halve tactical size |
| Never average down | After regime flips to downtrend |

---

## Engineering Requirements

These are not optional. The current bot has assumptions that will cause silent failures in production:

| Fix | Problem | Solution |
|-----|---------|----------|
| Dynamic fee | Hardcoded 0.25% — Upbit fee can vary by market or promotional period | Store fee per market; compute required edge dynamically |
| Tick-size normalization | Upbit KRW tick policy changed in 2025; unnormalized prices cause order rejects | Normalize to correct tick before every order |
| Cancel ≠ failure | Upbit returns `cancel` on market-buy when a dust residual is refunded — currently logged as failure | Classify "filled with dust refund" separately from true failure |
| Order idempotency | Retries without a unique identifier create duplicate orders | Use Upbit's `identifier` field on every order; check for existing open order before placing |
| Retry with backoff | Upbit's stabilization system rejects valid requests even under rate limit | Exponential backoff (100ms → 200ms → 400ms → 800ms), max 3 retries |
| Self-match prevention | SMP flag needed if bot ever moves to limit orders | Add `smp_type` param to order creation layer now so it's ready |

---

## Cycle Flow (v2)

```
Every 2 min (sell check):
  1. Classify regime (BTC EMA50/200, ADX)
  2. Get current positions + indicators
  3. Check ATR-based exit conditions per position
  4. Check time stops (flat trades > 30h)
  5. Check hard circuit breakers (consecutive losses, drawdown)
  6. Execute strongest qualifying sell only (one per coin per cycle)
  7. Log full context + update USD-proxy NAV

Every 5 min (buy check):
  6. Same regime classification
  7. Check portfolio-level exposure limits
  8. Check 4-factor signal conditions for current regime
  9. Check anti-churn (no buy if sold same coin < 30 min ago)
  10. Size order (50% first entry, conviction multiplier)
  11. Normalize tick, attach idempotency key, submit with retry
  12. Log full context
```

---

## Project Structure

```
transcribe/
├── pi-trader/
│   └── index.js          ← Raspberry Pi entry point (cron, logging, deploy)
├── lib/
│   ├── cryptoTrader.js   ← Core trading engine (regime, signals, entries, exits)
│   ├── indicators.js     ← Pure functions (RSI, MACD, BB, VWAP, ATR, EMA, ADX)
│   └── upbit.js          ← Upbit API client (prices, orders, accounts, tick normalization)
├── api/
│   └── crypto-trader.js  ← Vercel API (status, config, logs, export)
├── client/src/
│   └── components/
│       └── CryptoTraderDashboard.js  ← React dashboard
└── supabase/
    ├── init_schema.sql
    └── migrations/
```

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `crypto_trader_config` | Settings (regime thresholds, exposure limits, circuit breakers) |
| `crypto_trade_log` | Every buy and sell executed |
| `crypto_profit_take_log` | Exit cooldown tracker |
| `crypto_bot_logs` | Structured logs: trades, snapshots, hourly digests, errors |
| `app_settings` | Key-value store (heartbeat, portfolio snapshot, last cycle, indicators) |

---

## Environment Variables

```env
# Supabase (required on both Pi and Vercel)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Upbit (required on Pi only — never expose to frontend)
UPBIT_ACCESS_KEY=your_access_key
UPBIT_SECRET_KEY=your_secret_key
```

---

## Setup

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com)
2. Run **`supabase/init_schema.sql`** in the SQL editor
3. Run all migrations in `supabase/migrations/` in order (001 → 022)

### 2. Upbit API
1. Log into [upbit.com](https://upbit.com) → My page → Open API
2. Create a key with **trade permission** for KRW-BTC, KRW-ETH, KRW-SOL
3. Whitelist your Raspberry Pi's IP address

### 3. Raspberry Pi
```bash
git clone https://github.com/your-repo/transcribe.git
cd transcribe
npm install
cp .env.example .env   # fill in keys
npm install -g pm2
pm2 start pi-trader/index.js --name crypto-trader
pm2 save && pm2 startup
```

### 4. Vercel (Dashboard)
1. Import repo at [vercel.com](https://vercel.com)
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as env vars
3. Deploy

---

## Dashboard

| Section | Shows |
|---------|-------|
| Portfolio | Live KRW + USD-proxy NAV, each coin value, avg buy, gain/loss |
| Regime | Current BTC regime (Uptrend / Range / Downtrend) + EMA50/200 |
| Indicators | RSI, BB %B, VWAP deviation, order book imbalance per coin |
| Fear & Greed | Macro sentiment gate |
| Settings | Regime thresholds, exposure limits, stop-loss, kill switch |
| Bot Logs | Real-time feed from Pi |
| Sell Diagnostics | Why each coin's sell is or isn't firing |
| ↓ Pull & Restart | Deploys latest GitHub code to Pi |
| ⬇ Export Logs | Downloads 7 days of structured JSON for analysis |

---

## Log System

| Tag | Frequency | Contents |
|-----|-----------|----------|
| `trade` | Every trade | Side, amount, reason, all indicators, regime at time of trade |
| `active` | Every ~10 min | Regime, how far each coin is from triggering exit |
| `sell_diag` | Every ~14 min | Per-coin: gain%, blockers, signals met |
| `snapshot` | Every ~30 min | Full cycle: regime, all indicators, every decision |
| `hourly` | Every hour | P&L delta, USD-proxy NAV change, trade count, near-misses |
| `error` | On failure | Error message + stack trace |

**To share logs for analysis:** Click **⬇ Export Logs** → share `bot-logs-7d.json`

---

## Fees & Minimums

- Upbit charges **0.25% per side** (stored dynamically, not hardcoded in v2)
- Minimum order: **₩5,000 KRW**
- Round-trip cost: **~0.50%**
- Minimum net gain to sell: **~0.70%** (fees + 0.20% safety buffer, computed dynamically)

---

## Implementation Roadmap

### Phase 1 — Strategy rewrite (current priority)
- [ ] Regime engine (BTC EMA50/200 + ADX replacing bear market pause)
- [ ] USD-proxy NAV tracking in logs and dashboard
- [ ] ATR-based exits replacing static % staircase
- [ ] Simplify buy signals to 4-factor stack
- [ ] Portfolio-level circuit breakers (exposure caps, consecutive loss pause, drawdown limit)
- [ ] Time stop (exit flat trades after 30h)
- [ ] Remove relaxed RSI buy gate (replace with regime-aware entry)

### Phase 2 — Engineering hardening
- [ ] Dynamic fee per market (not hardcoded 0.25%)
- [ ] Tick-size normalization before every order
- [ ] Order idempotency (Upbit `identifier` field)
- [ ] Retry with exponential backoff (stabilization failures)
- [ ] Cancel ≠ failure classification

### Phase 3 — USDT reserve
- [ ] Add KRW-USDT trading pair
- [ ] Route downtrend exit proceeds to USDT
- [ ] Track USDT bucket separately in portfolio and dashboard
- [ ] Full 4-bucket portfolio structure

---

## Limitations & Known Behaviours

- **Upbit IP restriction**: Pi's public IP must be whitelisted. If IP changes, trading stops.
- **Sells are partial**: Always a % of the position (e.g. 25% first tranche), not a full exit, to maintain averaging capability.
- **Min order size**: ₩5,000 minimum. Very small positions may not trigger an order.
- **USDT reserve**: Phase 3 only. Currently the KRW cash reserve serves this role.
- **API rate limit**: Upbit allows ~600 market-data req/min. Each cycle uses ~11 — current 2/5-min schedule is safe.
