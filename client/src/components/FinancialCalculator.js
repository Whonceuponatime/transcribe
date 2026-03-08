import React, { useState, useMemo } from 'react';
import './FinancialCalculator.css';

const fmt = (n, decimals = 0) =>
  Number(n).toLocaleString('ko-KR', { maximumFractionDigits: decimals });

export default function FinancialCalculator() {
  const [usdAmount, setUsdAmount] = useState('');
  const [buyRate, setBuyRate] = useState('');
  const [sellRate, setSellRate] = useState('');
  const [exchangeFee, setExchangeFee] = useState('1.0');
  const [upbitFee, setUpbitFee] = useState('0.05');

  const result = useMemo(() => {
    const usd = parseFloat(usdAmount);
    const buy = parseFloat(buyRate);
    const sell = parseFloat(sellRate);
    const fxFeeRate = parseFloat(exchangeFee) / 100;
    const upbitFeeRate = parseFloat(upbitFee) / 100;

    if (!usd || usd <= 0 || !buy || buy <= 0 || !sell || sell <= 0) return null;
    if (isNaN(fxFeeRate) || isNaN(upbitFeeRate)) return null;

    const costKRW = usd * buy;
    const grossValueKRW = usd * sell;
    const fxFeeAmount = grossValueKRW * fxFeeRate;
    const netValueKRW = grossValueKRW - fxFeeAmount;
    const grossProfit = netValueKRW - costKRW;
    const profitPct = (grossProfit / costKRW) * 100;
    const upbitFeeAmount = grossProfit > 0 ? grossProfit * upbitFeeRate : 0;
    const investable = grossProfit > 0 ? grossProfit - upbitFeeAmount : 0;

    return {
      costKRW,
      grossValueKRW,
      fxFeeAmount,
      netValueKRW,
      grossProfit,
      profitPct,
      upbitFeeAmount,
      investable,
    };
  }, [usdAmount, buyRate, sellRate, exchangeFee, upbitFee]);

  return (
    <div className="fincalc">
      <div className="fincalc__header">
        <h2 className="fincalc__title">Forex → Crypto Calculator</h2>
        <p className="fincalc__subtitle">
          Enter your USD position and exchange rate to see how much KRW you can invest in crypto on Upbit.
        </p>
      </div>

      <div className="fincalc__body">
        {/* ── Inputs ────────────────────────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">Position</h3>

          <div className="fincalc__grid">
            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-usd">
                USD Amount
              </label>
              <div className="fincalc__input-wrap">
                <span className="fincalc__adornment fincalc__adornment--left">$</span>
                <input
                  id="fc-usd"
                  className="fincalc__input fincalc__input--left-adorn"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="1000"
                  value={usdAmount}
                  onChange={e => setUsdAmount(e.target.value)}
                />
              </div>
              <span className="fincalc__hint">How many dollars you currently hold</span>
            </div>

            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-buy">
                Buy Rate
              </label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-buy"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="1,300"
                  value={buyRate}
                  onChange={e => setBuyRate(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">KRW</span>
              </div>
              <span className="fincalc__hint">Rate (KRW per $1) when you bought USD</span>
            </div>

            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-sell">
                Current Rate
              </label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-sell"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="1,400"
                  value={sellRate}
                  onChange={e => setSellRate(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">KRW</span>
              </div>
              <span className="fincalc__hint">Today's selling rate (KRW per $1)</span>
            </div>
          </div>
        </section>

        {/* ── Fees ────────────────────────────────────────── */}
        <section className="fincalc__section card">
          <h3 className="fincalc__section-title">Fees</h3>

          <div className="fincalc__grid fincalc__grid--fees">
            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-fxfee">
                FX Conversion Fee
              </label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-fxfee"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="1.0"
                  value={exchangeFee}
                  onChange={e => setExchangeFee(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">%</span>
              </div>
              <span className="fincalc__hint">Bank or exchange spread when converting USD → KRW</span>
            </div>

            <div className="fincalc__field">
              <label className="fincalc__label" htmlFor="fc-upbit">
                Upbit Commission
              </label>
              <div className="fincalc__input-wrap">
                <input
                  id="fc-upbit"
                  className="fincalc__input fincalc__input--right-adorn"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.05"
                  value={upbitFee}
                  onChange={e => setUpbitFee(e.target.value)}
                />
                <span className="fincalc__adornment fincalc__adornment--right">%</span>
              </div>
              <span className="fincalc__hint">Upbit trading fee (default: 0.05%)</span>
            </div>
          </div>
        </section>

        {/* ── Results ─────────────────────────────────────── */}
        {result && (
          <section className="fincalc__section fincalc__results card">
            <h3 className="fincalc__section-title">Breakdown</h3>

            <div className="fincalc__table">
              <div className="fincalc__row">
                <span className="fincalc__row-label">USD purchase cost</span>
                <span className="fincalc__row-value">₩ {fmt(result.costKRW)}</span>
              </div>

              <div className="fincalc__row">
                <span className="fincalc__row-label">USD value at current rate</span>
                <span className="fincalc__row-value">₩ {fmt(result.grossValueKRW)}</span>
              </div>

              <div className="fincalc__row fincalc__row--fee">
                <span className="fincalc__row-label">FX conversion fee ({exchangeFee}%)</span>
                <span className="fincalc__row-value fincalc__row-value--neg">
                  − ₩ {fmt(result.fxFeeAmount)}
                </span>
              </div>

              <div className="fincalc__row fincalc__row--sub">
                <span className="fincalc__row-label">Net KRW received</span>
                <span className="fincalc__row-value">₩ {fmt(result.netValueKRW)}</span>
              </div>

              <div className="fincalc__divider" />

              <div className={`fincalc__row fincalc__row--profit ${result.grossProfit >= 0 ? 'fincalc__row--pos' : 'fincalc__row--neg'}`}>
                <span className="fincalc__row-label">
                  Gross profit
                </span>
                <span className={`fincalc__row-value ${result.grossProfit >= 0 ? 'fincalc__row-value--pos' : 'fincalc__row-value--neg'}`}>
                  {result.grossProfit >= 0 ? '+ ' : '− '}
                  ₩ {fmt(Math.abs(result.grossProfit))}&ensp;
                  <span className="fincalc__pct">({result.profitPct >= 0 ? '+' : ''}{result.profitPct.toFixed(2)}%)</span>
                </span>
              </div>

              {result.grossProfit > 0 && (
                <>
                  <div className="fincalc__row fincalc__row--fee">
                    <span className="fincalc__row-label">Upbit commission ({upbitFee}%)</span>
                    <span className="fincalc__row-value fincalc__row-value--neg">
                      − ₩ {fmt(result.upbitFeeAmount)}
                    </span>
                  </div>

                  <div className="fincalc__divider" />

                  <div className="fincalc__row fincalc__row--final">
                    <span className="fincalc__row-label">Investable in crypto</span>
                    <span className="fincalc__row-value fincalc__row-value--highlight">
                      ₩ {fmt(result.investable)}
                    </span>
                  </div>
                </>
              )}

              {result.grossProfit <= 0 && (
                <div className="fincalc__notice fincalc__notice--loss">
                  Position is currently at a loss — no profit to invest.
                </div>
              )}
            </div>
          </section>
        )}

        {!result && (usdAmount || buyRate || sellRate) && (
          <div className="fincalc__notice">
            Fill in all three position fields to see results.
          </div>
        )}
      </div>
    </div>
  );
}
