import { classifyMarket } from '@/lib/market/classify';

// 交易成本（買進+賣出），用券商 app 3661 反推驗證過
// TW: 手續費 0.1425% × 2 + 證交稅 0.3%
// CN: 手續費 0.03% × 2 + 印花稅 0.05%（賣出）+ 過戶費 0.001% × 2
export const FEE_RATES = {
  TW: { buy: 0.001425, sell: 0.001425 + 0.003 },
  CN: { buy: 0.00031, sell: 0.00031 + 0.0005 },
} as const;

export function marketOf(symbol: string): 'TW' | 'CN' {
  return classifyMarket(symbol) === 'CN' ? 'CN' : 'TW';
}

/** 淨損益：含買賣手續費+交易稅扣除，與券商 app 顯示口徑一致 */
export function calcNetPnL(symbol: string, shares: number, costPrice: number, currentPrice: number) {
  if (currentPrice <= 0) return { pnl: 0, pnlPct: 0 };
  const rates = FEE_RATES[marketOf(symbol)];
  const costTotal = shares * costPrice;
  const marketTotal = shares * currentPrice;
  const buyFee = costTotal * rates.buy;
  const sellFee = marketTotal * rates.sell;
  const pnl = marketTotal - costTotal - buyFee - sellFee;
  const pnlPct = costTotal > 0 ? (pnl / costTotal) * 100 : 0;
  return { pnl, pnlPct };
}

/** 顯示成本/均價：至少 2 位、最多 4 位（陸股均價常見 4 位小數如 302.9453） */
export function formatPrice(v: number): string {
  return v.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
