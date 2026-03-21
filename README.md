# Crypto Trading Bot — Upbit (KRW)

Automated signal-driven trading bot for BTC, ETH, and SOL on the Korean Upbit exchange.  
Runs 24/7 on a Raspberry Pi. Dashboard hosted on Vercel. Data stored in Supabase.

---

## What It Does

The bot buys coins when they are statistically oversold and sells them when they recover or reach profit targets.  
It checks sell conditions every **2 minutes** and buy conditions every **5 minutes**.  
All decisions are logged to Supabase for analysis and review.

---

## Architecture

```
Raspberry Pi (pi-trader/index.js)
  └── Runs cron jobs 24/7
  └── Calls lib/cryptoTrader.js for every cycle
  └── Writes logs and portfolio snapshots to Supabase

Vercel (api/crypto-trader.js)
  └── Serverless API reads from Supabase
  └── Serves the React dashboard

React Dashboard (client/src/)
  └── Shows portfolio, indicators, logs, settings
  └── Pull & Restart button deploys new code to Pi

Supabase
  └── Config, trade log, bot logs, portfolio snapshot
```

---

## Trading Strategy

### Buy Triggers (checked every 5 min)
| Signal | Condition | Cooldown |
|--------|-----------|----------|
| RSI Extreme Oversold | RSI < 25 | 4h |
| RSI Oversold | RSI < 32 | 3h |
| RSI Pullback Re-entry | RSI 30–50 (after selling) | 4h |
| Bollinger Lower Band | pctB < 0 | 4h |
| MACD Bullish Cross | Crossover signal | 5h |
| VWAP Deep Below | Price >2% below VWAP | 3h |
| Williams %R Oversold | W%R < −85 | 3h |
| CCI Oversold | CCI < −120 | 3h |
| StochRSI Oversold | StochRSI < 20 | 3h |
| ROC Sharp Dip | −5%+ drop in 9 bars | 4h |
| Emergency Dip | 24h drop > 6% | 6h |
| High Composite Score | Score ≥ 3 | 2h |
| DCA (scheduled) | Based on cooldown config | configurable |

### Sell Triggers (checked every 2 min)
| Signal | Condition | Sells | Cooldown |
|--------|-----------|-------|----------|
| Micro profit-take | Gain ≥ +1.5% | 5% | 30 min |
| Profit-take | Gain ≥ +3% | 8% | 1h |
| Profit-take | Gain ≥ +5% | 10% | 2h |
| Profit-take | Gain ≥ +10% | 10% | 12h |
| Profit-take | Gain ≥ +20% | 15% | 24h |
| Profit-take | Gain ≥ +40% | 20% | 48h |
| Profit-take | Gain ≥ +80% | 25% | 96h |
| RSI Overbought | RSI > 68 | 12% | 4h |
| RSI Strong OB | RSI > 78 | 20% | 4h |
| RSI Recovery | RSI > 62 + above VWAP | 8% | 4h |
| Modest Recovery | Gain ≥ 3% + RSI > 58 + MACD+ | 6% | 6h |
| Bollinger Upper | pctB > 1.0 | 12% | 2h |
| MACD Bearish Cross | Crossover signal | 10% | 4h |
| StochRSI Overbought | StochRSI > 85 | 10% | 2h |
| VWAP Deep Above | Price >3% above VWAP | 12% | 2h |
| Williams %R OB | W%R > −5 | 10% | 4h |
| CCI Overbought | CCI > 150 | 10% | 2h |
| Kimchi Premium High | Premium > 4% | 15% | 4h |
| Stop-Loss | Down > X% for > 24h | 50% | 24h |
| Trailing Stop | −20% from 14-day high | 40% | 30d |

### Risk Management
- **Minimum profit gate**: Never signal-sells below +0.70% net gain (covers 0.25% × 2 Upbit fee + 0.20% buffer)
- **Cash reserve floor**: Keeps ≥ 15% of portfolio as KRW at all times; DCA and dip buys skip if floor would be breached
- **Over-cashed guard**: Pauses signal sells when KRW > 40% of portfolio (prioritises buying back in)
- **Relaxed buy gate**: Scales RSI buy threshold higher the more over-cashed the bot is (up to RSI 72 when KRW > 80%)
- **Anti-churn**: Never buys a coin it just sold in the last 30 minutes
- **Fear & Greed gate**: Pauses dip buys and DCA when F&G > 75 (extreme greed)
- **Bear market pause**: Halves budgets when BTC is ≥ 30% below its 90-day high
- **Kill switch**: Stops all trading immediately from the dashboard
- **Stop-loss**: (configurable, default off) Sells 50% of a position that has been down > X% for > 24h

### Indicators Used
RSI (14), RSI (7), MACD (12/26/9), Bollinger Bands (20/2σ), StochRSI, VWAP, ATR, Williams %R,
CCI, OBV Trend, ROC (9), 24h Momentum, Order Book Imbalance, Kimchi Premium, Fear & Greed Index,
Composite Signal Score (combines all of the above)

---

## Project Structure

```
transcribe/
├── pi-trader/
│   └── index.js          ← Raspberry Pi entry point (cron jobs, logging, deploy)
├── lib/
│   ├── cryptoTrader.js   ← Core trading engine (buy/sell logic, all indicators)
│   ├── indicators.js     ← Pure indicator functions (RSI, MACD, BB, VWAP, etc.)
│   └── upbit.js          ← Upbit API client (prices, orders, accounts)
├── api/
│   └── crypto-trader.js  ← Vercel serverless API (status, config, logs, export)
├── client/src/
│   └── components/
│       └── CryptoTraderDashboard.js  ← React dashboard
└── supabase/
    ├── init_schema.sql   ← Full database schema
    └── migrations/       ← Incremental DB changes
```

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `crypto_trader_config` | Bot settings (enabled, coins, budgets, thresholds) |
| `crypto_trade_log` | Every buy and sell executed |
| `crypto_profit_take_log` | Profit-take cooldown tracker |
| `crypto_bot_logs` | All bot log entries (trades, snapshots, hourly digests, errors) |
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
1. Create a Supabase project at [supabase.com](https://supabase.com)
2. Run the full schema: **SQL Editor → paste contents of `supabase/init_schema.sql` → Run**
3. Run all migrations in `supabase/migrations/` in order (001 → 022)
4. Copy your `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

### 2. Upbit API
1. Log into [upbit.com](https://upbit.com) → My page → Open API
2. Create a key with **trade permission** for KRW-BTC, KRW-ETH, KRW-SOL
3. Whitelist your Raspberry Pi's IP address
4. Copy your `UPBIT_ACCESS_KEY` and `UPBIT_SECRET_KEY`

### 3. Raspberry Pi
```bash
# Clone the repo
git clone https://github.com/your-repo/transcribe.git
cd transcribe

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env and add your keys

# Install PM2 (process manager)
npm install -g pm2

# Start the bot
pm2 start pi-trader/index.js --name crypto-trader
pm2 save
pm2 startup   # makes it start on reboot
```

### 4. Vercel (Dashboard)
1. Import the repo in [vercel.com](https://vercel.com)
2. Add environment variables:  
   - `SUPABASE_URL`  
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Deploy. Dashboard is live at `https://your-project.vercel.app`

---

## Dashboard

The single-page dashboard at `/crypto-bot` shows:

- **Portfolio** — live KRW balance, each coin's value, avg buy price, gain/loss %
- **Indicators** — RSI, StochRSI, MACD, BB, VWAP deviation, CCI, Williams %R per coin
- **Fear & Greed** — macro sentiment gate
- **Settings** — DCA frequency, buy/sell percentages, stop-loss, kill switch
- **Bot Logs** — real-time log feed from the Pi
- **Sell Diagnostics** — per-coin analysis: why sells are or aren't firing
- **↓ Pull & Restart** — deploys latest code from GitHub to the Pi remotely
- **⬇ Export Logs** — downloads last 7 days of structured logs as JSON for AI analysis

---

## Log System

The bot writes structured logs to `crypto_bot_logs` in Supabase:

| Tag | Frequency | Contents |
|-----|-----------|----------|
| `trade` | Every trade | Coin, side, amount, reason, all indicators at time of trade |
| `active` | Every ~10 min | Brief status + how far each coin is from triggering a sell |
| `sell_diag` | Every ~14 min | Per-coin: gain%, what's blocking the sell, which signals are met |
| `snapshot` | Every ~30 min | Full cycle: all indicators, portfolio state, every decision made |
| `hourly` | Every hour | P&L delta, trade count, near-miss summary |
| `error` | On failure | Error message + stack trace |

**To analyse and improve the bot:**
1. Wait at least 24-48 hours after starting
2. Click **⬇ Export Logs** in the dashboard
3. Share the downloaded `bot-logs-7d.json` with me

---

## Configuration (via Dashboard)

| Setting | Default | Description |
|---------|---------|-------------|
| DCA frequency | 0.5 days | How often to run a scheduled DCA buy |
| DCA % | 10% | What % of available KRW to spend per DCA |
| Dip buy % | 8% | What % of available KRW to spend per dip buy signal |
| Stop-loss % | 0 (off) | Sell 50% if a position is down this % for > 24h |
| Kill switch | OFF | Stops all trading immediately |
| Fear & Greed gate | ON | Blocks buys when F&G > 75 (extreme greed) |
| Bear market pause | ON | Halves budgets when BTC is in a deep bear |

---

## Fees

Upbit charges **0.25% per trade** (buy and sell).  
Round-trip cost = **0.50%**.  
The bot requires a minimum net gain of **0.70%** before any signal sell executes,  
ensuring every sale is always profitable after fees.

---

## Limitations / Known Behaviours

- **Upbit IP restriction**: The Pi's public IP must be whitelisted in Upbit API settings. If IP changes, trading stops.
- **Slow recovery from drawdowns**: When all positions are underwater, the bot holds until recovery (no stop-loss by default). Enable stop-loss % in settings to auto-cut losses.
- **Min order size**: Upbit requires ≥ ₩5,000 per order. Very small positions may not trigger.
- **Sell % is a portion**: Sells are always a % of the position (e.g. 8%), never a full exit, to keep averaging in over time.
- **API rate limit**: Upbit allows ~600 market-data requests/min. Each cycle uses ~11, so the 2/5-min schedule is safe.
