/**
 * 股票顯示身分的純函式單一事實來源。
 *
 * 代號可以作為 secondary label，但絕不能冒充中文名稱寫入資料或當主標顯示。
 * 這支檔案不含 Node/API 依賴，可安全給 Client Component 與 server 共用。
 */

export const UNRESOLVED_STOCK_NAME = '名稱待補';

export function stockCodeOf(symbol: string): string {
  return symbol.trim().replace(/\.(TW|TWO|SS|SZ|OF)$/i, '');
}

export function isPlaceholderStockName(name: unknown, symbol: string): boolean {
  if (typeof name !== 'string') return true;
  const normalized = name.trim();
  if (!normalized || normalized === UNRESOLVED_STOCK_NAME) return true;
  const upperName = normalized.toUpperCase();
  const upperSymbol = symbol.trim().toUpperCase();
  return upperName === upperSymbol || upperName === stockCodeOf(upperSymbol).toUpperCase();
}

/** 回傳可當主標顯示的名稱；查無時用明確狀態文案，不以代號偽裝名稱。 */
export function stockDisplayName(name: unknown, symbol: string): string {
  return isPlaceholderStockName(name, symbol) ? UNRESOLVED_STOCK_NAME : (name as string).trim();
}

/** 中文名主標 + 代號輔助；名稱未解析時只顯示明確狀態與代號。 */
export function stockDisplayLabel(name: unknown, symbol: string): string {
  const displayName = stockDisplayName(name, symbol);
  return `${displayName}（${symbol.trim()}）`;
}
