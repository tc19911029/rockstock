import { calcInvestedCost, calcNetPnL } from '@/lib/portfolio/fees';

export interface UnrealizedHoldingInput {
  symbol: string;
  shares: number;
  costPrice: number;
  /** 券商「投入成本」（含實際買進手續費／拆單最低費），有值時優先於均價估算。 */
  investedCost?: number;
}

export interface UnrealizedSummary {
  totalCost: number;
  totalValue: number;
  totalPnL: number;
  returnPct: number | null;
  pricedCount: number;
  missingPriceCount: number;
  hasZeroCostHolding: boolean;
}

/**
 * 彙總目前仍持有部位的未實現損益；不讀取、也不包含任何已賣出交易。
 *
 * 零成本配股可以計算損益金額，但報酬率沒有合法成本分母，因此整體報酬率回傳 null，
 * 避免把零成本部位的獲利除以其他股票成本後顯示成看似精確、其實無意義的百分比。
 */
export function calculateUnrealizedSummary(
  holdings: UnrealizedHoldingInput[],
  priceOf: (symbol: string) => number | null | undefined,
): UnrealizedSummary {
  let totalCost = 0;
  let totalValue = 0;
  let totalPnL = 0;
  let pricedCount = 0;
  let missingPriceCount = 0;
  let hasZeroCostHolding = false;

  for (const holding of holdings) {
    const cost = calcInvestedCost(
      holding.symbol,
      holding.shares,
      holding.costPrice,
      holding.investedCost,
    );
    totalCost += cost;
    if (holding.costPrice <= 0) hasZeroCostHolding = true;

    const currentPrice = priceOf(holding.symbol) ?? 0;
    if (!(currentPrice > 0)) {
      missingPriceCount += 1;
      continue;
    }

    pricedCount += 1;
    totalValue += holding.shares * currentPrice;
    totalPnL += calcNetPnL(
      holding.symbol,
      holding.shares,
      holding.costPrice,
      currentPrice,
      holding.investedCost,
    ).pnl;
  }

  const returnPct = missingPriceCount === 0 && !hasZeroCostHolding && totalCost > 0
    ? (totalPnL / totalCost) * 100
    : null;

  return {
    totalCost,
    totalValue,
    totalPnL,
    returnPct,
    pricedCount,
    missingPriceCount,
    hasZeroCostHolding,
  };
}
