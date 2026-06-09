export type MarketTab = 'all' | 'TW' | 'CN';

/**
 * 場外開放式基金代號：6 碼數字 + `.OF` 後綴（開放式基金 open-end fund 慣例），
 * 例如 `000217.OF`（華安黃金ETF聯接C）。場外基金以「單位淨值(NAV)×份額」計價、
 * 人民幣計算，故 classifyMarket 歸在 CN（陸股 tab + ¥ 幣別 + CN 費率）顯示。
 *
 * 跟交易所股票（.SS/.SZ）刻意分一個後綴：報價走天天基金 NAV 而非騰訊行情、
 * 數量單位是「份」而非「手」、且不進任何選股／K 線資料流（基金沒有日 K）。
 */
export function isFundSymbol(symbol: string): boolean {
  return /\.OF$/i.test(symbol.trim());
}

export function classifyMarket(symbol: string): 'TW' | 'CN' | 'other' {
  if (/\.(TW|TWO)$/i.test(symbol)) return 'TW';
  if (/\.(SS|SZ)$/i.test(symbol)) return 'CN';
  if (/\.OF$/i.test(symbol)) return 'CN'; // 場外基金（人民幣淨值）歸 CN 顯示
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
