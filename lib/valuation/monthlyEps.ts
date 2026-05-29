/**
 * 用月營收 × 上一季淨利率 / 股數 推估單月 EPS。
 * 注意：這是估算，非公司正式 EPS。UI 必須標註。
 */
export function estimateMonthlyEps(
  monthlyRevenue: number,
  netMargin: number,
  sharesOutstanding: number
): number {
  if (!sharesOutstanding || sharesOutstanding <= 0) return 0;
  if (!netMargin || netMargin <= 0) return 0;
  const monthlyNetIncome = monthlyRevenue * netMargin;
  return monthlyNetIncome / sharesOutstanding;
}

/**
 * 如果沒有明確股數，用 季稅後淨利 / 季 EPS 反推股數。
 * 注意：正式 EPS 用加權平均股數；快速估算可接受。
 */
export function inferSharesFromEps(quarterlyNetIncome: number, quarterlyEps: number): number {
  if (!quarterlyEps || quarterlyEps <= 0) return 0;
  return quarterlyNetIncome / quarterlyEps;
}
