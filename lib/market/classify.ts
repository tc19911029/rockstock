export type MarketTab = 'all' | 'TW' | 'CN';

export function classifyMarket(symbol: string): 'TW' | 'CN' | 'other' {
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  // 無後綴時依位數猜：6位數字=陸股，4-5位數字=台股
  const digits = symbol.replace(/\D/g, '');
  if (/^\d{6}$/.test(digits) && digits === symbol.trim()) return 'CN';
  if (/^\d{4,5}$/.test(digits) && digits === symbol.trim()) return 'TW';
  return 'other';
}

export function filterByMarket<T extends { symbol: string }>(
  items: T[],
  tab: MarketTab,
): T[] {
  if (tab === 'all') return items;
  return items.filter(i => classifyMarket(i.symbol) === tab);
}

/** Check if a YYYY-MM-DD date string falls on a weekend (not a trading day). */
export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay();
  return day === 0 || day === 6;
}
