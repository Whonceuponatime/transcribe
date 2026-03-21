**Crypto Trading Bot MVP Specification**

Solid MVP for an Upbit-based KRW trading bot optimized for USD-proxy growth, frequent rotation, and operational safety.

| **Version <br>**v1.0 | **Prepared for <br>**Whouldny Youwannna | **Focus <br>**Upbit KRW trading bot for USD-proxy growth |
| -------------------- | --------------------------------------- | -------------------------------------------------------- |

**Document intent  
**This document is written to be buildable. It removes conflicting rules, keeps the live strategy small enough to implement safely, and separates product decisions from engineering detail.

# 1\. Purpose

• Define the smallest live trading product that can be implemented safely and evaluated honestly.

• Align the product with the thesis that KRW weakens over time, while still avoiding reckless overtrading.

• Keep the strategy narrow enough to ship, monitor, and improve without building a research platform first.

# 2\. Core thesis and design principles

• The scorecard is USD-proxy NAV, not KRW balance.

• The bot is a spot-only rotation engine on Upbit KRW markets for BTC, ETH, and SOL.

• The bot should trade often enough to realize gains, but never force trades only because cash is available.

• The live engine must be simpler than the research layer. Extra indicators may be logged, but not used for live triggers.

• Operational safety beats aggressiveness. A bot that survives is more valuable than a bot that looks smart on paper.

## 3\. MVP design decisions

| **Decision**      | **Chosen MVP rule**                                   | **Why this is the right cut**                                                      |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Primary metric    | USD-proxy NAV                                         | Matches the anti-KRW thesis and prevents false comfort from KRW-denominated gains. |
| Tradable assets   | BTC, ETH, SOL only                                    | Enough variety for tactical rotation without spreading logic too thin.             |
| Live signal stack | Trend + stretch + momentum + execution                | Small, auditable, and easier to debug than a large indicator bundle.               |
| Stretch indicator | Bollinger %B only                                     | Removes the prior conflict between %B and z-score.                                 |
| Position model    | Separate core and tactical sleeves                    | Prevents short-term exits from accidentally liquidating long-term inventory.       |
| Reserve model     | KRW execution cash in MVP, USDT reserve as next phase | Keeps the first implementation realistic while preserving the longer-term thesis.  |
| Order style       | Market-first with strong guardrails                   | Faster to ship than a maker-style engine and easier to reconcile early on.         |

# 4\. What is inside the MVP

• One live bot running on Raspberry Pi.

• One dashboard for status, config, logs, and manual pause/resume.

• Supabase-backed persistence for config, orders, fills, portfolio snapshots, and bot events.

• A regime engine, a tactical entry engine, ATR-based exits, and portfolio-level risk controls.

• Paper mode and shadow mode before full live mode.

## Out of scope for MVP

• Cross-exchange execution or arbitrage.

• Shorting, leverage, borrowing, or derivatives.

• Automatic on-chain withdrawals and self-custody routing.

• AI-generated live trading decisions.

• A fully global USD reference engine as a hard dependency. That can come in v1.1 after the local engine is stable.

## 5\. Portfolio structure

| **Sleeve**             | **Target range**   | **Role**                                                        |
| ---------------------- | ------------------ | --------------------------------------------------------------- |
| Core                   | 25% to 40% of NAV  | Directional BTC and ETH holdings that survive short-term churn. |
| Tactical               | 10% to 20% of NAV  | Frequent rotation sleeve for BTC, ETH, and SOL.                 |
| KRW execution cash     | 10% to 15% of NAV  | Fees, minimum order flexibility, and immediate entries.         |
| Deferred reserve phase | Future USDT sleeve | Phase after MVP once USDT routing and operations are stable.    |

**Note:** Every fill must be tagged as either core or tactical. Tactical exits are never allowed to consume core inventory.

# 6\. Regime engine

• The regime engine is driven by BTC 4-hour candles on Upbit KRW markets.

• Regime updates occur only on new 4-hour candle close or a controlled periodic refresh, not every minute.

• A regime switch requires hysteresis: one set of thresholds to enter a regime and a slightly looser set to leave it.

• The three live regimes are Uptrend, Range, and Downtrend.

## Regime definitions

| **Regime** | **Entry definition**                                                         | **Allowed behavior**                                             |
| ---------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Uptrend    | BTC 4h close above EMA200, EMA50 above EMA200, ADX confirming trend strength | Buy pullbacks. BTC, ETH, and SOL tactical entries allowed.       |
| Range      | EMA50 and EMA200 close together and ADX weak                                 | Mean-reversion scalps only. Smaller sizing.                      |
| Downtrend  | BTC 4h close below EMA200 and EMA50 below EMA200                             | No new SOL buys. BTC and ETH only, smaller and stricter entries. |

# 7\. Live signal stack

## Indicators that may drive live entries and exits

| **Bucket** | **Live metric**                          | **Purpose**                                                                   |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| Trend      | EMA structure and MACD slope             | Confirms whether the market is advancing, flat, or weakening.                 |
| Stretch    | Bollinger %B                             | Measures how extended price is within its recent band.                        |
| Momentum   | RSI(14)                                  | Confirms oversold and overbought states without stacking similar oscillators. |
| Execution  | Spread estimate and order book imbalance | Blocks low-quality fills and choppy chase entries.                            |

**Note:** z-score, StochRSI, Williams %R, CCI, ROC, and similar indicators can still be logged for later research, but they are not part of the MVP live trigger set.

# 8\. Entry rules

## Uptrend tactical entry

• All conditions required: Bollinger %B below the pullback threshold, RSI in the pullback zone, no fresh 4-hour breakdown, and execution quality acceptable.

• First entry uses 50% of the tactical signal budget.

• Only one add is permitted, and only if price extends further by a controlled ATR amount while the regime stays intact.

## Range tactical entry

• Use a tighter mean-reversion rule: deeper %B compression, lower RSI, smaller size, and faster time stop.

• Range entries are smaller than uptrend entries because edge quality is lower.

## Downtrend tactical entry

• Only BTC and ETH are allowed.

• Require deeper oversold conditions plus a reversal clue such as stabilization or a relative-volume spike.

• Sizing is reduced versus uptrend entries, and no averaging down is allowed after the regime has turned bearish.

# 9\. Exit rules

• Use ATR-based partial exits instead of a static profit ladder.

• Minimum required edge must cover buy fee, sell fee, expected spread, expected slippage, and a safety buffer.

• First trim takes risk off quickly; later trims allow winners to run with a trailing stop.

• A time stop removes flat positions so tactical capital does not get stuck.

## Tactical exit structure

| **Exit stage** | **Rule**                                                                            | **Intent**                                                    |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Trim 1         | Sell part of the tactical sleeve at roughly +1.2 ATR after required edge is cleared | Bank small wins early and reduce emotional pressure.          |
| Trim 2         | Sell another part at roughly +2.0 ATR or other trend-aware stretch condition        | Capture a larger move without exiting too early on RSI alone. |
| Runner         | Use a trailing stop on the remaining tactical portion                               | Keep upside exposure in stronger moves.                       |
| Time stop      | Reduce or close trades that stay flat for too many bars                             | Recycle capital into better opportunities.                    |
| Regime break   | Immediately reduce tactical risk when BTC flips down                                | Protect against getting trapped after the backdrop changes.   |

# 10\. Risk management

## Portfolio-level controls

| **Control**                  | **MVP limit**                                                     | **Purpose**                                            |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| Max BTC exposure             | 35% of NAV                                                        | Prevents concentration.                                |
| Max ETH exposure             | 25% of NAV                                                        | Prevents concentration.                                |
| Max SOL exposure             | 10% of NAV                                                        | Caps highest-volatility asset exposure.                |
| Max new risk per signal      | 2% of NAV                                                         | Limits damage from one bad idea.                       |
| Max entries per coin per 24h | 3                                                                 | Blocks revenge trading and churn.                      |
| Daily turnover cap           | 30% to 40% of NAV                                                 | Preserves frequent trading without turning into noise. |
| Loss streak breaker          | Pause tactical buys after 5 losing exits                          | Forces a reset when conditions degrade.                |
| Drawdown breaker             | Halve tactical size after 7-day realized drawdown below threshold | Reduces damage during bad runs.                        |

# 11\. MVP acceptance criteria

**1\.** The bot can run in paper mode, shadow mode, and live mode using the same decision engine.

**2\.** Every order, fill, and state transition is persisted and reconstructable from the database.

**3\.** Every fill is tagged to a sleeve and the cost basis is tracked separately for core and tactical positions.

**4\.** The dashboard shows NAV in KRW and USD-proxy, current regime, open tactical positions, recent decisions, and circuit-breaker state.

**5\.** Order overlap, duplicate intents, and unresolved state mismatches are prevented by locks and reconciliation.

**6\.** The system can survive restart and rebuild its state from exchange data and persisted records.

**7\.** The bot can be evaluated against simple benchmarks such as passive BTC hold and passive USD-proxy conversion.

# 12\. Post-MVP roadmap

• Introduce a real USDT reserve sleeve and allow downtrend exits to rotate there instead of KRW.

• Add a USD-reference filter so the bot separates crypto trend from KRW FX effects more cleanly.

• Add maker-style or best-limit execution only after market-first execution is stable and reconciled.

• Add parameter experiments only after walk-forward evaluation is in place.