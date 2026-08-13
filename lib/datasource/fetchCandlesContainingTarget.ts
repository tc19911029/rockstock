import type { Candle } from '@/types';

interface HistoricalCandleProvider {
  getHistoricalCandles(symbol: string, period?: string): Promise<unknown>;
  getCandlesRange?(symbol: string, startDate: string, endDate: string): Promise<unknown>;
}

function toCandles(value: unknown): Candle[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is Candle =>
    !!c && typeof c === 'object' && typeof (c as { date?: unknown }).date === 'string',
  );
}

function mergeCandles(...groups: Candle[][]): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const group of groups) for (const candle of group) byDate.set(candle.date, candle);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 騰訊 qfq 對長區間查詢偶爾只回到前一交易日，但同一代號的短區間已含最新棒。
 * 補漏時不能把「有歷史資料」等同「有目標日」；長窗缺目標日就用窄窗重試，
 * 再交給下一個 provider。
 */
export async function fetchCandlesContainingTarget(
  symbol: string,
  targetDate: string,
  providers: HistoricalCandleProvider[],
): Promise<Candle[] | null> {
  const targetMs = new Date(`${targetDate}T12:00:00Z`).getTime();
  // 實測部分上海代號查 14 天仍只回到昨日，但查 3 天已包含目標日；使用最小
  // 足夠跨過一般週末的窄窗，目的只在補齊目標棒，不拿它取代完整歷史。
  const narrowStart = new Date(targetMs - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const provider of providers) {
    try {
      const longWindow = toCandles(await provider.getHistoricalCandles(symbol, '3mo'));
      if (longWindow.some((c) => c.date === targetDate)) return longWindow;
      if (provider.getCandlesRange) {
        const narrowWindow = toCandles(await provider.getCandlesRange(symbol, narrowStart, targetDate));
        if (narrowWindow.some((c) => c.date === targetDate)) return mergeCandles(longWindow, narrowWindow);
      }
    } catch { /* try next provider */ }
  }
  return null;
}
