import type { Candle } from '@/types';

/**
 * Yahoo / 即時報價來源有時會在停牌或整日無成交時，用昨收價補出一根
 * O=H=L=C、volume=0 的假日 K。交易所日線不會把這種日期算成一個交易日，
 * 因此它也不能占用 MA 的一個樣本。
 *
 * 指數的 volume 經常缺值為 0，但價格仍正常變動，所以只排除「零量且扁平」的 bar。
 */
export function isZeroVolumeFlatBar(candle: Pick<Candle, 'open' | 'high' | 'low' | 'close' | 'volume'>): boolean {
  return candle.volume === 0 &&
    candle.open === candle.high &&
    candle.high === candle.low &&
    candle.low === candle.close;
}
