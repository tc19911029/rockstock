import type { Candle } from '@/types';

/**
 * 三色 chart route 會在封存日 K 後附加一根盤中 K。
 * 讀取層可能回傳共享的記憶體快取，因此這裡必須先複製，不能讓 request 直接 push 污染 L1 cache。
 * 同時以日期去重，避免舊快取或競態留下的同日雙根讓 CROSS 多算一次。
 */
export function isolateSanseCandles(input: readonly Candle[]): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const source of input) {
    const date = source.date.endsWith('*') ? source.date.slice(0, -1) : source.date;
    byDate.set(date, { ...source, date });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
