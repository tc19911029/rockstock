import type { Candle } from '@/types';
import { saveLocalCandles } from './LocalCandleStore';
import type { Market, VendorQuote } from './eodSettle';

export const MAX_INLINE_READ_REPAIRS = 10;
const MIN_FULL_REPAIR_CANDLES = 30;

type SaveCandles = typeof saveLocalCandles;

/**
 * Verify 發現讀不到既有檔時，先抓完整歷史重建，再由本輪官方收盤值覆蓋目標日。
 * 只有拿到至少 30 根歷史 K 才允許 replace，避免用單根資料截斷損壞但仍可救回的舊檔。
 */
export async function repairReadFailedSymbols({
  market,
  date,
  symbols,
  fetchCandles,
  officialQuotes,
  saveCandles = saveLocalCandles,
}: {
  market: Market;
  date: string;
  symbols: string[];
  fetchCandles(symbol: string, asOfDate?: string): Promise<Candle[]>;
  officialQuotes: ReadonlyMap<string, VendorQuote>;
  saveCandles?: SaveCandles;
}): Promise<{ attempted: number; repaired: number; failed: string[] }> {
  const targets = symbols.slice(0, MAX_INLINE_READ_REPAIRS);
  const failed: string[] = [];
  let repaired = 0;

  for (const symbol of targets) {
    try {
      const candles = await fetchCandles(symbol, date);
      if (candles.length < MIN_FULL_REPAIR_CANDLES) {
        failed.push(symbol);
        continue;
      }
      await saveCandles(symbol, market, candles, { replaceExisting: true });
      const official = officialQuotes.get(symbol);
      if (market === 'TW' && official) {
        await saveCandles(symbol, market, [{ date, ...official }], { trustedOfficial: true });
      }
      repaired++;
      console.warn(`[eod-settle] auto-repair ${symbol}: 完整歷史 ${candles.length} 根重建成功`);
    } catch (error) {
      failed.push(symbol);
      console.warn(`[eod-settle] auto-repair ${symbol} 失敗: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (symbols.length > targets.length) failed.push(...symbols.slice(targets.length));
  return { attempted: targets.length, repaired, failed };
}
