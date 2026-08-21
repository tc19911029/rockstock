export type SanseAlertTone = 'buy' | 'sell';

/**
 * 台股持倉歷史上可能把同一檔存成 .TW 與 .TWO；三色台股 route 也會用裸碼自行探測交易所。
 * 推播層因此以「TW + 裸碼」視為同一標的；陸股保留 .SS/.SZ，避免 000001 之類跨市場撞碼。
 */
export function canonicalSanseInstrument(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (/\.(SS|SZ)$/.test(normalized)) return `CN:${normalized}`;
  return `TW:${normalized.replace(/\.(TW|TWO)$/, '')}`;
}

export function sanseAlertKey(
  date: string,
  symbol: string,
  tone: SanseAlertTone,
  reversal = false,
): string {
  return `${date}:${canonicalSanseInstrument(symbol)}:${tone}${reversal ? ':rev' : ''}`;
}

export function dedupeSanseWatch<T extends { symbol: string }>(watch: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of watch) {
    const key = canonicalSanseInstrument(item.symbol);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}
