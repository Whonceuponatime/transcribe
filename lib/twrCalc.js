'use strict';

// TWR (Time-Weighted Return) computation for bot vs synthetic basket.
// Pure math + one orchestrator that reads from Supabase. No writes.

const SUPPORTED_COINS = ['BTC', 'ETH', 'XRP'];
const WEIGHT_SUM_TOLERANCE = 0.001;
const SNAPSHOT_QUERY_CAP = 50000;
const SEVEN_DAYS_MS  = 7  * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function _toMs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts).getTime();
}

function computeBasketQuantities(inceptionSnapshot, weights) {
  if (!inceptionSnapshot || typeof inceptionSnapshot !== 'object') {
    throw new Error('computeBasketQuantities: inceptionSnapshot is required');
  }
  if (!weights || typeof weights !== 'object') {
    throw new Error('computeBasketQuantities: weights is required');
  }
  for (const coin of SUPPORTED_COINS) {
    if (typeof weights[coin] !== 'number' || !Number.isFinite(weights[coin])) {
      throw new Error(`computeBasketQuantities: weights.${coin} must be a finite number`);
    }
  }
  const sum = weights.BTC + weights.ETH + weights.XRP;
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(`computeBasketQuantities: weights must sum to 1.0 (±${WEIGHT_SUM_TOLERANCE}); got ${sum}`);
  }
  const nav   = Number(inceptionSnapshot.nav_krw);
  const btcPx = Number(inceptionSnapshot.btc_price_krw);
  const ethPx = Number(inceptionSnapshot.eth_price_krw);
  const xrpPx = Number(inceptionSnapshot.xrp_price_krw);
  if (!(nav   > 0)) throw new Error('computeBasketQuantities: inception nav_krw must be > 0');
  if (!(btcPx > 0)) throw new Error('computeBasketQuantities: inception btc_price_krw must be > 0');
  if (!(ethPx > 0)) throw new Error('computeBasketQuantities: inception eth_price_krw must be > 0');
  if (!(xrpPx > 0)) throw new Error('computeBasketQuantities: inception xrp_price_krw must be > 0');
  return {
    qtyBtc: (weights.BTC * nav) / btcPx,
    qtyEth: (weights.ETH * nav) / ethPx,
    qtyXrp: (weights.XRP * nav) / xrpPx,
  };
}

function benchmarkNavAt(snapshot, basketQuantities) {
  if (!snapshot || !basketQuantities) return null;
  const btcPx = Number(snapshot.btc_price_krw);
  const ethPx = Number(snapshot.eth_price_krw);
  const xrpPx = Number(snapshot.xrp_price_krw);
  if (!(btcPx > 0) || !(ethPx > 0) || !(xrpPx > 0)) return null;
  return basketQuantities.qtyBtc * btcPx
       + basketQuantities.qtyEth * ethPx
       + basketQuantities.qtyXrp * xrpPx;
}

function modifiedDietzReturn(startNav, endNav, cashFlows, periodStartTs, periodEndTs) {
  const startMs = _toMs(periodStartTs);
  const endMs   = _toMs(periodEndTs);
  const sNav    = Number(startNav);
  const eNav    = Number(endNav);
  if (!Number.isFinite(sNav) || !Number.isFinite(eNav))     return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (!(sNav > 0))                                          return null;
  const periodMs = endMs - startMs;
  if (!(periodMs > 0))                                      return null;

  let sumCF         = 0;
  let sumWeightedCF = 0;
  const cfList = Array.isArray(cashFlows) ? cashFlows : [];
  for (const cf of cfList) {
    const cfMs = _toMs(cf?.ts);
    const amt  = Number(cf?.signedAmount);
    if (!Number.isFinite(cfMs) || !Number.isFinite(amt)) continue;
    if (cfMs < startMs || cfMs > endMs)                  continue;
    const w = (endMs - cfMs) / periodMs;
    sumCF         += amt;
    sumWeightedCF += amt * w;
  }
  const denom = sNav + sumWeightedCF;
  if (!(denom > 0)) return null;
  return (eNav - sNav - sumCF) / denom;
}

async function computeTWRSummary(supabase, opts = {}) {
  try {
    // 1. Config
    const { data: cfg, error: cfgErr } = await supabase
      .from('bot_config')
      .select('benchmark_enabled, benchmark_inception_snapshot_id, benchmark_basket_weights')
      .limit(1)
      .single();
    if (cfgErr) throw new Error(`bot_config read failed: ${cfgErr.message}`);
    if (!cfg?.benchmark_enabled) {
      return { enabled: false, reason: 'disabled' };
    }
    const inceptionId = cfg.benchmark_inception_snapshot_id;
    if (inceptionId == null) {
      return { enabled: false, reason: 'inception_missing' };
    }
    const weights = cfg.benchmark_basket_weights;

    // 2. Inception snapshot
    const { data: inceptionRow, error: incErr } = await supabase
      .from('portfolio_snapshots_v2')
      .select('id, created_at, nav_krw, btc_price_krw, eth_price_krw, xrp_price_krw')
      .eq('id', inceptionId)
      .single();
    if (incErr) throw new Error(`inception snapshot read failed: ${incErr.message}`);
    if (!inceptionRow) return { enabled: false, reason: 'inception_missing' };
    const incNav = Number(inceptionRow.nav_krw);
    if (!(incNav > 0)
        || !(Number(inceptionRow.btc_price_krw) > 0)
        || !(Number(inceptionRow.eth_price_krw) > 0)
        || !(Number(inceptionRow.xrp_price_krw) > 0)) {
      return { enabled: false, reason: 'inception_missing' };
    }
    const inceptionMs = _toMs(inceptionRow.created_at);

    // 3. Basket quantities
    const basketQuantities = computeBasketQuantities(inceptionRow, weights);

    // 4. Snapshots from inception forward
    const { data: snaps, error: snapErr } = await supabase
      .from('portfolio_snapshots_v2')
      .select('id, created_at, nav_krw, btc_price_krw, eth_price_krw, xrp_price_krw')
      .gte('id', inceptionId)
      .order('id', { ascending: true })
      .limit(SNAPSHOT_QUERY_CAP);
    if (snapErr) throw new Error(`snapshots read failed: ${snapErr.message}`);
    if (!snaps || snaps.length === 0) {
      return { enabled: false, reason: 'no_snapshots' };
    }

    // 5. Cash movements from inception forward.
    // transaction_type 'internal' (e.g. Upbit interest) is filtered client-side
    // because PostgREST .neq is null-unsafe — rows with NULL transaction_type
    // would be incorrectly excluded.
    const inceptionIso = new Date(inceptionMs).toISOString();
    const { data: cashRows, error: cashErr } = await supabase
      .from('cash_movements')
      .select('type, amount, fee, state, transaction_type, upbit_done_at')
      .gte('upbit_done_at', inceptionIso)
      .in('state', ['ACCEPTED', 'DONE'])
      .order('upbit_done_at', { ascending: true });
    if (cashErr) throw new Error(`cash_movements read failed: ${cashErr.message}`);
    const cashFlows = (cashRows || [])
      .filter((r) => r.transaction_type !== 'internal')
      .map((r) => {
        const amt = Number(r.amount) || 0;
        const fee = Number(r.fee)    || 0;
        if (r.type === 'deposit')  return { ts: r.upbit_done_at, signedAmount: amt };
        if (r.type === 'withdraw') return { ts: r.upbit_done_at, signedAmount: -(amt + fee) };
        return null;
      })
      .filter(Boolean);

    // 6. Series — chronological, benchmark-NAV-required
    const series = snaps
      .map((s) => ({
        ts:           s.created_at,
        botNav:       Number(s.nav_krw),
        benchmarkNav: benchmarkNavAt(s, basketQuantities),
      }))
      .filter((p) => p.benchmarkNav != null && Number.isFinite(p.botNav));

    if (series.length === 0) {
      return { enabled: false, reason: 'no_valid_series' };
    }

    // 7. Three TWR windows ending at the latest snapshot
    const endPoint = series[series.length - 1];
    const endMs    = _toMs(endPoint.ts);

    const findStart = (cutoffMs) => {
      for (const p of series) {
        if (_toMs(p.ts) >= cutoffMs) return p;
      }
      return null;
    };

    const computeWindow = (startPoint) => {
      if (!startPoint || startPoint === endPoint) {
        return { botTWR: null, benchmarkTWR: null, alpha: null };
      }
      const startMs = _toMs(startPoint.ts);
      const cfsInWindow = cashFlows.filter((cf) => {
        const m = _toMs(cf.ts);
        return m >= startMs && m <= endMs;
      });
      const botTWR = modifiedDietzReturn(
        startPoint.botNav, endPoint.botNav,
        cfsInWindow, startPoint.ts, endPoint.ts,
      );
      const benchmarkTWR = modifiedDietzReturn(
        startPoint.benchmarkNav, endPoint.benchmarkNav,
        [], startPoint.ts, endPoint.ts,
      );
      const alpha = (botTWR != null && benchmarkTWR != null)
        ? botTWR - benchmarkTWR
        : null;
      return { botTWR, benchmarkTWR, alpha };
    };

    const startInception = series[0];
    const start7d  = findStart(endMs - SEVEN_DAYS_MS)  ?? startInception;
    const start30d = findStart(endMs - THIRTY_DAYS_MS) ?? startInception;

    const w7d  = computeWindow(start7d);
    const w30d = computeWindow(start30d);
    const wInc = computeWindow(startInception);

    return {
      enabled: true,
      inception: {
        id:      inceptionRow.id,
        ts:      inceptionRow.created_at,
        nav:     incNav,
        weights,
      },
      botTWR: {
        since7d:        w7d.botTWR,
        since30d:       w30d.botTWR,
        sinceInception: wInc.botTWR,
      },
      benchmarkTWR: {
        since7d:        w7d.benchmarkTWR,
        since30d:       w30d.benchmarkTWR,
        sinceInception: wInc.benchmarkTWR,
      },
      alpha: {
        since7d:        w7d.alpha,
        since30d:       w30d.alpha,
        sinceInception: wInc.alpha,
      },
      series,
    };
  } catch (err) {
    console.error('[twrCalc] computeTWRSummary failed:', err.message);
    return { enabled: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  computeBasketQuantities,
  benchmarkNavAt,
  modifiedDietzReturn,
  computeTWRSummary,
};

if (require.main === module) {
  const APPROX = (a, b, tol) => Math.abs(a - b) <= tol;
  const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };
  const ok   = (label, value) => console.log(`PASS: ${label} = ${value}`);

  // Test 1: basket quantities
  const inception = {
    id: 1,
    created_at: '2026-04-27T11:00:00.000Z',
    nav_krw:       1000,
    btc_price_krw: 100,
    eth_price_krw: 10,
    xrp_price_krw: 1,
  };
  const weights = { BTC: 0.333, ETH: 0.333, XRP: 0.334 };
  const qty = computeBasketQuantities(inception, weights);
  // Expected: qtyBtc = 3.33, qtyEth = 33.3, qtyXrp = 334.0
  if (!APPROX(qty.qtyBtc, 3.33,  0.001)) fail(`qtyBtc expected ~3.33, got ${qty.qtyBtc}`);
  if (!APPROX(qty.qtyEth, 33.3,  0.001)) fail(`qtyEth expected ~33.3, got ${qty.qtyEth}`);
  if (!APPROX(qty.qtyXrp, 334.0, 0.001)) fail(`qtyXrp expected ~334.0, got ${qty.qtyXrp}`);
  ok('qtyBtc', qty.qtyBtc);
  ok('qtyEth', qty.qtyEth);
  ok('qtyXrp', qty.qtyXrp);

  // Test 2: benchmark NAV at later point with each price 2x'd
  const later = {
    id: 2,
    created_at: '2026-04-28T11:00:00.000Z',
    btc_price_krw: 200,
    eth_price_krw: 20,
    xrp_price_krw: 2,
  };
  const benchNav = benchmarkNavAt(later, qty);
  // Expected: 2 * 1000 = 2000
  if (!APPROX(benchNav, 2000, 1)) fail(`benchmarkNavAt expected ~2000, got ${benchNav}`);
  ok('benchmarkNavAt(2x prices)', benchNav);

  // Test 3: Modified Dietz
  // start=1000, end=2200, +100 deposit at midpoint
  // w = 0.5; numerator = 2200 - 1000 - 100 = 1100; denom = 1000 + 50 = 1050
  // R = 1100 / 1050 ≈ 1.04762  (≈ +104.76%)
  // (Spec text said "roughly +10%" which contradicts the parenthetical
  // "1100 of which 100 was capital, weighted at ~0.5"; the parenthetical
  // is the correct math.)
  const startTs = '2026-04-27T00:00:00.000Z';
  const midTs   = '2026-04-27T12:00:00.000Z';
  const endTs   = '2026-04-28T00:00:00.000Z';
  const r = modifiedDietzReturn(
    1000, 2200,
    [{ ts: midTs, signedAmount: 100 }],
    startTs, endTs,
  );
  if (r == null || !(r > 0))         fail(`modifiedDietzReturn expected positive, got ${r}`);
  if (!APPROX(r, 1.04762, 0.001))    fail(`modifiedDietzReturn expected ~1.04762, got ${r}`);
  ok('modifiedDietzReturn(1000, 2200, +100 mid)', `${r} (${(r * 100).toFixed(2)}%)`);

  // Test 4: edge — zero cashflow benchmark (mirrors the production basket call)
  const r2 = modifiedDietzReturn(1000, 2000, [], startTs, endTs);
  if (!APPROX(r2, 1.0, 0.0001))      fail(`modifiedDietzReturn(zero CF, 2x) expected 1.0, got ${r2}`);
  ok('modifiedDietzReturn(1000, 2000, [])', `${r2} (${(r2 * 100).toFixed(2)}%)`);

  // Test 5: degenerate — startNav 0 returns null
  const r3 = modifiedDietzReturn(0, 100, [], startTs, endTs);
  if (r3 !== null) fail(`modifiedDietzReturn(0 start) expected null, got ${r3}`);
  ok('modifiedDietzReturn(0 start)', 'null');

  // Test 6: benchmarkNavAt with NULL price returns null
  const incomplete = { btc_price_krw: 100, eth_price_krw: null, xrp_price_krw: 1 };
  const bn2 = benchmarkNavAt(incomplete, qty);
  if (bn2 !== null) fail(`benchmarkNavAt(NULL eth) expected null, got ${bn2}`);
  ok('benchmarkNavAt(NULL eth)', 'null');

  console.log('\nAll self-tests passed.');
}
