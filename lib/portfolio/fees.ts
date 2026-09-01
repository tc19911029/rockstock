import { classifyMarket, isFundSymbol } from '@/lib/market/classify';

// 交易成本（買進+賣出），用券商 app 3661 反推驗證過
// TW: 手續費 0.1425% × 2 + 證交稅 0.3%
// CN: 手續費 0.03% × 2 + 印花稅 0.05%（賣出）+ 過戶費 0.001% × 2
export const FEE_RATES = {
  TW: { buy: 0.001425, sell: 0.001425 + 0.003 },
  CN: { buy: 0.00031, sell: 0.00031 + 0.0005 },
} as const;

/** 台股券商帳務以整數元入帳：手續費無條件捨去、單筆最低 20 元。 */
function twCommission(amount: number): number {
  return Math.max(20, Math.floor(amount * FEE_RATES.TW.buy));
}

/** 台股證交稅以整數元無條件捨去。 */
function twTransactionTax(amount: number): number {
  return Math.floor(amount * 0.003);
}

export function marketOf(symbol: string): 'TW' | 'CN' {
  return classifyMarket(symbol) === 'CN' ? 'CN' : 'TW';
}

/** 目前部位的實際／估算投入成本（含買進手續費）。 */
export function calcInvestedCost(
  symbol: string,
  shares: number,
  costPrice: number,
  investedCost?: number,
): number {
  if (investedCost != null && Number.isFinite(investedCost) && investedCost >= 0) return investedCost;
  const gross = shares * costPrice;
  if (isFundSymbol(symbol) || gross <= 0) return gross;
  return marketOf(symbol) === 'TW'
    ? gross + twCommission(gross)
    : gross * (1 + FEE_RATES.CN.buy);
}

/** 淨損益：含買賣手續費+交易稅扣除，與券商 app 顯示口徑一致 */
export function calcNetPnL(
  symbol: string,
  shares: number,
  costPrice: number,
  currentPrice: number,
  investedCost?: number,
) {
  if (currentPrice <= 0) return { pnl: 0, pnlPct: 0 };
  // 場外基金（C 類持有滿期免贖回費）以「單位淨值 × 份額」計未實現損益、不扣股票交易稅費，
  // 與銀行／券商 App 顯示的「持倉收益（未實現、毛額）」口徑一致。
  if (isFundSymbol(symbol)) {
    const costTotal = calcInvestedCost(symbol, shares, costPrice, investedCost);
    const pnl = shares * currentPrice - costTotal;
    return { pnl, pnlPct: costTotal > 0 ? (pnl / costTotal) * 100 : 0 };
  }
  const market = marketOf(symbol);
  const marketTotal = shares * currentPrice;
  if (market === 'TW') {
    const costBasis = calcInvestedCost(symbol, shares, costPrice, investedCost);
    const liquidationValue = marketTotal - twCommission(marketTotal) - twTransactionTax(marketTotal);
    const pnl = liquidationValue - costBasis;
    return { pnl, pnlPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0 };
  }
  const sellFee = marketTotal * FEE_RATES.CN.sell;
  const costBasis = calcInvestedCost(symbol, shares, costPrice, investedCost);
  const pnl = marketTotal - sellFee - costBasis;
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
  return { pnl, pnlPct };
}

/** 顯示成本/均價：至少 2 位、最多 4 位（陸股均價常見 4 位小數如 302.9453） */
export function formatPrice(v: number): string {
  return v.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
