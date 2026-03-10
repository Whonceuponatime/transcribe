/**
 * Portfolio helpers: total KRW converted, total USD, average buy rate, unrealized KRW value.
 */

/**
 * @param {Array<{ krw_amount: number, usd_amount: number, fx_rate: number }>} conversions
 * @returns {{ totalKrwConverted: number, totalUsdAcquired: number, averageBuyRate: number }}
 */
function portfolioFromConversions(conversions) {
  if (!conversions || !conversions.length) {
    return { totalKrwConverted: 0, totalUsdAcquired: 0, averageBuyRate: 0 };
  }
  const totalKrwConverted = conversions.reduce((s, c) => s + Number(c.krw_amount || 0), 0);
  const totalUsdAcquired = conversions.reduce((s, c) => s + Number(c.usd_amount || 0), 0);
  const averageBuyRate = totalUsdAcquired > 0 ? totalKrwConverted / totalUsdAcquired : 0;
  return {
    totalKrwConverted,
    totalUsdAcquired,
    averageBuyRate,
  };
}

/**
 * Unrealized KRW value of USD holdings at a given spot rate.
 * @param {number} totalUsdAcquired
 * @param {number} usdkrwSpot
 * @returns {number}
 */
function unrealizedKrwValue(totalUsdAcquired, usdkrwSpot) {
  if (totalUsdAcquired == null || usdkrwSpot == null) return 0;
  return totalUsdAcquired * usdkrwSpot;
}

module.exports = {
  portfolioFromConversions,
  unrealizedKrwValue,
};
