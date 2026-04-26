# KRW → USD → Crypto: Full Strategy & Next Steps
### How to use this app to build real wealth from Korea

---

## THE CORE IDEA (read this first)

You are in Korea. Your money sits in KRW. KRW has depreciated roughly 30–40% against USD over the past 10 years and will continue to do so structurally (aging population, export dependency, geopolitical risk). This is not a prediction — it is the baseline.

**The play:**
1. Convert KRW → USD at the RIGHT TIME (when USD is cheap relative to recent history)
2. Hold USD — you are now protected from KRW depreciation
3. Use that USD to buy crypto — you now have upside from crypto ON TOP of the KRW/USD gain
4. When you eventually convert back to KRW, you benefit from BOTH the USD appreciation AND the crypto gain

**Example of how this compounds:**
- You convert ₩10,000,000 at ₩1,400/$ = $7,142
- KRW weakens to ₩1,500/$ (very common — happened multiple times)
- Your $7,142 is now worth ₩10,713,000 — a ₩713,000 gain just from holding USD (+7.1%)
- If BTC also went up 30% during that period, your total gain is ~37% in KRW terms
- You did not need to be a crypto genius. You just converted at the right time.

---

## PART 1 — GETTING THE APP FULLY WORKING

### Step 1: Get your FRED API key (10 minutes, free)

This is the most important step. Without FRED, the signal has no historical data.

1. Go to: https://fred.stlouisfed.org/docs/api/api_key.html
2. Create a free account at research.stlouisfed.org
3. Go to Account → API Keys → Request API Key
4. Copy the key (looks like: `abcdef1234567890abcdef1234567890`)
5. In Vercel → Your Project → Settings → Environment Variables:
   - Add: `FRED_API_KEY` = your key
   - Set to: Production, Preview, Development
6. Redeploy (Vercel → Deployments → Redeploy)

**What this unlocks:**
- 2 years of daily USD/KRW history
- 14 additional macro series (VIX, oil, gold, Fed rate, etc.)
- Moving averages (MA20, MA60, MA120)
- Buy/sell scoring with full context
- The "Buy planner" dip targets

### Step 2: Run your first Check Now

1. Open the app → Utilities → "Buy USD → Crypto"
2. Enter your available KRW in the capital field (e.g. 5000000 for ₩5M)
3. Press **Check Now**
4. Wait ~10 seconds (fetches Yahoo Finance + 15 FRED series)
5. You will see: BUY NOW or SCALE IN with exact amounts

### Step 3: Set up Supabase (if not done)

The app needs Supabase to store your trades and signals.

1. Go to https://supabase.com → create free project
2. In the SQL editor, run migrations in order:
   - supabase/migrations/001_ethernet_jobs.sql
   - supabase/migrations/002_ethernet_storage.sql
   - supabase/migrations/003_forex_snapshots.sql
   - supabase/migrations/004_fx_advisor.sql
   - supabase/migrations/005_live_trading.sql
   - supabase/migrations/006_analyzer.sql
3. Add env vars to Vercel:
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY
   - REACT_APP_SUPABASE_URL
   - REACT_APP_SUPABASE_ANON_KEY

---

## PART 2 — HOW TO READ THE SIGNAL

### What the badge means

| Badge | Meaning | Action |
|-------|---------|--------|
| **BUY NOW — 100%** | Rate is historically cheap, strong macro tailwind | Convert your full planned amount today |
| **BUY NOW — 50%** | Good conditions but not perfect | Convert half, save half for a dip |
| **SCALE IN — 30%** | Neutral to slightly good | Convert 30%, set alerts for dip |
| **SCALE IN — 15%** | Rate is elevated, but keep accumulating | Small buy to stay on schedule |
| **SCALE IN — 10%** | Rate is high, not ideal | Tiny buy just to not miss the trend |

**There is no WAIT signal.** KRW depreciates long-term. Even at "expensive" rates, small accumulation is better than holding KRW.

### What score means what

The signal engine scores 0–10+ across 10 macro factors:

| Score | Allocation | Meaning |
|-------|-----------|---------|
| 7+ | 100% | Very rare. All signals aligned. Convert everything. |
| 5–6 | 50% | Strong. Good entry. |
| 3–4 | 30% | Decent. Buy a meaningful amount. |
| 1–2 | 15% | Neutral. Keep accumulating slowly. |
| 0 | 10% | Expensive. Buy a little to stay on schedule. |

### The 10 scoring factors explained

1. **USD/KRW vs 20-day average** — Is today's rate cheap or expensive vs recent history?
2. **Dollar Index trend** — Is USD strengthening globally? (more pressure on KRW)
3. **VIX (fear index)** — High VIX = global panic = USD surges = buy before it gets worse
4. **NASDAQ trend** — Tech selloffs weaken risk appetite = USD strengthens
5. **Yield curve (10Y - 2Y spread)** — Inverted curve = recession risk = USD demand rises
6. **Oil price** — Korea is an oil importer. Rising oil = trade deficit = KRW weakens
7. **Gold trend** — Rising gold = safe-haven demand = KRW under pressure
8. **Korea equities (KOSPI proxy)** — Falling KOSPI = foreign capital leaving Korea = KRW sells off
9. **Inflation + Fed rate** — High US rates = USD attractive globally = KRW weakens
10. **Structural trend** — Is spot > MA60 > MA120? KRW in confirmed downtrend?

### The "Buy Planner" section

After the main signal, the Buy Planner shows:
- **Checklist**: 3 green/yellow/red signals at a glance
- **Stats**: How far today's rate is from the 20d, 60d averages in %
- **Dip targets**: If rate drops to ₩X,XXX (the 20d or 60d avg), how much to deploy

Use dip targets to set price alerts in your banking app or exchange. When the rate hits the target, buy more.

---

## PART 3 — THE USD → CRYPTO STRATEGY

### Why convert USD profit into crypto (not back to KRW)

Once your USD is worth more KRW than you paid (e.g. you bought at ₩1,400 and rate is now ₩1,490):
- **Don't convert back to KRW** — that resets your protection
- **Move the profit portion into BTC/ETH** — you are now compounding

Your base stays protected in USD. The profit goes into higher-upside assets.

### The allocation

| Asset | % of your USD | Why |
|-------|--------------|-----|
| **Bitcoin (BTC)** | 50% | Hardest asset, most liquid, safest crypto bet. Institutional adoption growing. Store of value against all fiat including KRW. |
| **Ethereum (ETH)** | 30% | Smart contract layer. Powers DeFi, NFTs, most new apps. Outperforms BTC in bull markets. |
| **High-upside altcoin** | 20% | SOL, ARB, NEAR, or similar. Higher risk, higher reward. Only use money you can lose. |
| **USD cash reserve** | 10–20% buffer | Keep this for dip-buying. Never go 100% in. |

### When to buy crypto with your USD

Do NOT buy crypto randomly. Wait for these conditions:

**Good time to buy crypto:**
- VIX drops below 20 (calm markets, risk-on)
- NASDAQ has been rising for 2+ weeks (tech momentum = crypto momentum)
- BTC has pulled back 10–20% from recent high (dip entry)
- Fear & Greed Index is below 40 (available at: https://alternative.me/crypto/fear-and-greed-index/)

**Wait or buy less:**
- VIX above 30 (panic — crypto will likely drop more first)
- Fed just raised rates (risk assets sell off short-term)
- BTC has just run up 30%+ (buy the dip, not the top)

### Dollar-cost averaging (DCA) — the safest method

Do NOT try to time crypto perfectly. Instead:

1. Decide your total crypto budget (e.g. $1,000)
2. Split into 4 equal buys: $250/week for 4 weeks
3. You automatically buy some at low prices and some at high prices
4. Your average entry is smoothed out
5. Repeat every time you convert a new batch of KRW→USD

This is the strategy used by most serious long-term crypto investors.

### Where to buy crypto from Korea

| Exchange | Pros | Cons |
|---------|------|------|
| **Upbit** | Korean, KRW deposits easy, regulated | Limited coins, higher fees |
| **Binance** | Largest, cheapest fees, all coins | Needs USD wire or crypto transfer |
| **Coinbase** | Most trusted, good for USD deposits | Higher fees than Binance |
| **OKX / Bybit** | Low fees, many coins | Less regulated |

**Recommended flow from Korea:**
1. Convert KRW → USD at your bank or wire to Binance
2. Buy BTC/ETH on Binance (lowest fees)
3. Log the purchase in the app (Log crypto purchase section)
4. Track your P&L in the portfolio section

---

## PART 4 — PROFIT TAKING STRATEGY

### When to sell crypto back to USD

Do NOT sell everything at once. Use these targets:

**Partial profit-taking levels:**
- Sell 20% of your BTC when it is up 50% from your average buy price
- Sell another 20% when it is up 100% (2x)
- Sell another 20% when it is up 200% (3x)
- Keep the remaining 40% as a long-term hold

This "staircase selling" locks in real profits while keeping exposure for further upside.

### When to convert USD back to KRW

Only convert USD back to KRW when:
- You need the money for a specific Korean purchase
- OR USD/KRW has dropped significantly from your buy level (unlikely long-term)

Otherwise: **stay in USD or crypto.** KRW will continue to weaken.

### Tax in Korea

- Korea imposes a **22% capital gains tax** on crypto profits above ₩2.5M/year (as of 2025)
- Keep records of every buy/sell (the app logs your trades)
- Consult a Korean tax accountant if your crypto profits exceed ₩5M/year

---

## PART 5 — REALISTIC TIMELINE & EXPECTATIONS

### Conservative scenario (low-risk, steady accumulation)
- Monthly KRW→USD conversion: ₩500,000–₩1,000,000
- 60% stays as USD cash, 40% into BTC/ETH via DCA
- Expected 1-year return: 10–25% in KRW terms (USD appreciation + modest crypto gains)
- Risk: Low. Even if crypto is flat, KRW depreciation gives you ~5–10%/year.

### Moderate scenario (balanced)
- Monthly conversion: ₩1,000,000–₩3,000,000
- 40% USD cash, 40% BTC/ETH, 20% altcoins
- Expected 1-year return: 20–60% in KRW terms (in a normal crypto year)
- Risk: Medium. Crypto adds volatility but also real upside.

### Aggressive scenario (for those with risk appetite)
- Convert large amounts when BUY NOW 100% signal fires
- 20% USD cash, 40% BTC, 20% ETH, 20% altcoins
- Expected 1-year return in a bull market: 50–200% in KRW terms
- Risk: High. Crypto can drop 50–80% in a bear market.

**Golden rule:** Only invest what you can leave untouched for 2+ years. Crypto is illiquid emotionally — you will want to sell at the bottom.

---

## PART 6 — DAILY / WEEKLY ROUTINE

### Daily (2 minutes)
- Check BTC price — is it up or down vs your buy?
- Check USD/KRW rate — is it near a dip target?

### Weekly (5 minutes)
- Press **Check Now** in the app
- If signal says BUY NOW and you have KRW available → convert
- If you have USD sitting idle → do your weekly DCA crypto buy
- Log any purchases in the app

### Monthly (15 minutes)
- Review portfolio section in app — total P&L in KRW
- Check if any crypto position is up 50%+ → consider partial profit-take
- Decide next month's KRW→USD budget

### Quarterly (30 minutes)
- Review your average USD buy rate vs current rate
- Review total KRW invested vs current total value
- Adjust allocation if needed

---

## PART 7 — SIGNALS TO WATCH OUTSIDE THE APP

These external signals are worth checking when making big decisions:

| Signal | Where to check | What it means |
|--------|---------------|---------------|
| **Fed rate decision** | federalreserve.gov | Rate hike = USD stronger, buy more USD |
| **Korea trade balance** | bok.or.kr | Deficit = KRW weakens, buy USD |
| **Fear & Greed Index** | alternative.me/crypto | Below 30 = good crypto buy |
| **Bitcoin dominance** | coinmarketcap.com | Rising dominance = altcoins weakening, buy BTC |
| **KOSPI** | krx.co.kr | Sharp KOSPI drop often = KRW selloff follows |
| **DXY (Dollar Index)** | tradingview.com | DXY rising = buy more USD now |

---

## SUMMARY — THE COMPLETE FLOW

```
Every week:
  1. Open app → press Check Now
  2. Signal says BUY NOW?
     YES → go to your bank → convert the recommended KRW amount
     NO (SCALE IN) → convert the smaller recommended amount
  3. You now have USD. Log the buy in the app.

When USD is up vs your avg buy price:
  4. Take the profit portion → buy BTC/ETH/altcoin (DCA, not all at once)
  5. Log the crypto buy in the app

When crypto is up 50%+:
  6. Sell 20% of that position back to USD
  7. Repeat from step 3

Your wealth grows through:
  KRW depreciation gain + USD interest (SGOV ~5%) + crypto upside
```

---

*Document generated from the Sad Dagger project.*
*App lives at: /api/analyzer + client/src/components/AnalyzerDashboard.js*
*For API setup see: API_REQUIREMENTS.txt*
