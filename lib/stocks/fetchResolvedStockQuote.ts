import { isPlaceholderStockName } from './stockIdentity';

export interface ResolvedStockQuote {
  requestedSymbol: string;
  canonicalSymbol: string;
  name: string;
  price: number;
  changePercent: number;
}

/** Client 共用的「輸入代號 → 正式代號 + 名稱 + 報價」唯一入口。 */
export async function fetchResolvedStockQuote(rawSymbol: string): Promise<ResolvedStockQuote> {
  const requestedSymbol = rawSymbol.trim().toUpperCase();
  if (!requestedSymbol) throw new Error('請輸入股票代號');

  const response = await fetch(`/api/portfolio/quotes?symbols=${encodeURIComponent(requestedSymbol)}`, { cache: 'no-store' });
  const json = await response.json().catch(() => ({})) as {
    error?: string;
    quotes?: Array<{
      symbol: string;
      canonicalSymbol?: string;
      price: number;
      changePercent?: number;
      name?: string;
      stale?: boolean;
      staleReason?: string;
    }>;
  };
  if (!response.ok) throw new Error(json.error ?? `查詢失敗（HTTP ${response.status}）`);

  const quote = json.quotes?.find(item => item.price > 0);
  if (!quote) throw new Error('找不到股票，請確認代號是否正確');
  if (quote.stale) throw new Error(quote.staleReason ?? '行情尚未更新，請稍後再試');
  const canonicalSymbol = quote.canonicalSymbol ?? quote.symbol ?? requestedSymbol;
  if (isPlaceholderStockName(quote.name, canonicalSymbol)) {
    throw new Error(`已找到 ${canonicalSymbol} 的行情，但中文名稱尚未解析完成，請稍後再試`);
  }

  return {
    requestedSymbol,
    canonicalSymbol,
    name: quote.name!.trim(),
    price: quote.price,
    changePercent: quote.changePercent ?? 0,
  };
}
