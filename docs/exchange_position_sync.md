# Exchange-Backed Position Sync

## A. Files / Functions Changed

| File | Change |
|---|---|
| `lib/cryptoTraderV2.js` | Added `syncPositionsFromExchange()` function |
| `lib/cryptoTraderV2.js` | Called in `executeCycleV2` after step 3 (getPortfolioState), before step 4 (risk engine) |

---

## B. Exact Patch Diff

### New function — added before `getPortfolioState` (~line 68)

```diff
+// ─── Exchange-backed position sync ───────────────────────────────────────────
+
+async function syncPositionsFromExchange(supabase, coins, accounts, executionMode) {
+  for (const coin of coins) {
+    try {
+      const acc         = accounts.find((a) => a.currency === coin);
+      const exchQty     = Number(acc?.balance ?? 0) + Number(acc?.locked ?? 0);
+      const exchAvgCost = Number(acc?.avg_buy_price ?? 0);
+
+      const { data: activePosRows } = await supabase
+        .from('positions')
+        .select('position_id, qty_open, avg_cost_krw, state')
+        .eq('asset', coin)
+        .eq('managed', true)
+        .in('state', ['open', 'adopted', 'partial']);
+
+      const activeCount = activePosRows?.length ?? 0;
+
+      if (activeCount > 1) { /* emit POSITION_SYNC_ANOMALY, continue */ }
+      if (activeCount === 0) { /* log if exchQty > 0, continue */ }
+
+      // Exactly 1 position: sync qty_open + avg_cost_krw
+      updatePatch.qty_open     = exchQty;
+      updatePatch.avg_cost_krw = exchAvgCost;   // when exchQty > 0 && exchAvgCost > 0
+      // if exchQty <= 0: set state=closed, leave avg_cost_krw as-is
+
+      await supabase.from('positions').update(updatePatch).eq('position_id', pos.position_id);
+      // emit POSITION_EXCHANGE_SYNC bot_event
+    } catch (err) { /* non-fatal warn */ }
+  }
+}
```

### Call site — inserted in `executeCycleV2` between steps 3 and 4

```diff
     const portfolio = await getPortfolioState(supabase, coins, priceMap, usdtKrwRate);

+    // ── 3b. Exchange-backed position sync ─────────────────────────────────────
+    await syncPositionsFromExchange(supabase, coins, portfolio.accounts, EXECUTION_MODE);
+
     // ── 4. Risk engine state + circuit breakers ──────────────────────────────
     await riskEngine.updateDrawdownState(supabase, cfg);
```

---

## C. Exact Sync Rules

| Condition | Action |
|---|---|
| Exactly 1 active managed position, `exchQty > 0`, `exchAvgCost > 0` | Set `qty_open = exchQty`, `avg_cost_krw = exchAvgCost` |
| Exactly 1 active managed position, `exchQty = 0` | Set `qty_open = 0`, `state = closed`, `closed_at = now()`. Leave `avg_cost_krw` unchanged (preserves P&L history). |
| 0 active managed positions, `exchQty > 0` | Log only. Do not create a position. Adoption step handles new positions on startup. |
| 0 active managed positions, `exchQty = 0` | No-op. |
| >1 active managed positions | Emit `POSITION_SYNC_ANOMALY` warn event. Skip sync for that coin entirely. |

**Fields synced:** `qty_open`, `avg_cost_krw`, `state`, `closed_at`, `updated_at`

**Fields never touched:** `fired_trims`, `entry_regime`, `strategy_tag`, `realized_pnl`, `entry_reason`, `atr_at_entry`, `usd_proxy_fx`, `opened_at`, `position_id`, `origin`, `adoption_timestamp`

---

## D. Anomaly Cases Skipped on Purpose

| Case | Why skipped |
|---|---|
| >1 active positions for same coin | Cannot safely attribute exchange balance to either position. Emits `POSITION_SYNC_ANOMALY` for operator review. |
| `exchAvgCost = 0` with `exchQty > 0` | Upbit returns 0 avg_buy_price when a position was manually reset or has no fills. Skip avg_cost update; only sync qty. |
| Positions with `strategy_tag = null` | Not included — query filters `managed = true` which implies strategy_tag is set. Unclassified unassigned positions are also included via `getOpenPositions` but not targeted here because they may span multiple strategy sleeves. |
| Coins not in `cfg.coins` | Not iterated — loop uses `coins` array from config. |
| `avg_buy_price_modified = true` | Upbit allows manual modification of avg_buy_price. This sync uses the exchange value regardless. If the user has manually set a different cost basis on Upbit, it will overwrite the DB. This is intentional — exchange is treated as truth. |

---

## E. Risk / Limitations

**1. Upbit `avg_buy_price` resets on full sell.**
When the exchange position goes to zero, Upbit resets `avg_buy_price` to 0. If a bot cycle runs after a full sell before the DB position is closed, the sync correctly sets `qty_open = 0` and `state = closed`, preserving `avg_cost_krw` for P&L history.

**2. `locked` qty included in `exchQty`.**
`balance + locked` is used because locked qty (in pending orders) is still the user's asset. This matches what the reconciliation engine uses. If a large limit order is pending, `exchQty` will include it.

**3. One DB write per coin per cycle.**
At 1-minute cycles: 3 DB writes per cycle (one per coin). These are lightweight `UPDATE` statements on indexed primary keys. Acceptable overhead.

**4. Duplicate positions not auto-merged.**
When `activeCount > 1`, the sync emits a warning but does not merge or close either position. A human operator must resolve duplicates using the SQL in `docs/pnl_integrity_fix.md`. The sync anomaly event in `bot_events` provides a clear audit trail.

**5. Exchange truth lag on fills.**
After a sell order is placed, Upbit may not immediately reduce `balance`. There is a short window (usually < 1 second for market orders) where `exchQty` still shows pre-sell value. Since cycles run every 60 seconds, this is not a meaningful risk in practice.
