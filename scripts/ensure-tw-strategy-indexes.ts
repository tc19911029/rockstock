/** Refresh only missing official index days before any EOD strategy uses them. */
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { saveLocalCandles } from '@/lib/datasource/LocalCandleStore';
import { fetchTwseIndexMonth } from '@/lib/datasource/TwseIndexProvider';
import { fetchTpexIndexMonth } from '@/lib/datasource/TpexIndexProvider';
import { isCompleteMarketIndexCandle } from '@/lib/datasource/marketIndexQuality';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { strategyCatchupDates } from '@/lib/scanner/strategyCatchup';

async function main() {
  const dates = strategyCatchupDates('TW', getLastTradingDay('TW'), 10);
  for (const [symbol, fetchMonth] of [['^TWII', fetchTwseIndexMonth], ['^TWOII', fetchTpexIndexMonth]] as const) {
    const before = await readCandleFile(symbol, 'TW');
    const missing = dates.filter(date => !isCompleteMarketIndexCandle(before?.candles.find(c => c.date === date)));
    for (const month of new Set(missing.map(date => date.slice(0, 7).replace('-', '')))) {
      const candles = (await fetchMonth(month)).filter(c => missing.includes(c.date));
      await saveLocalCandles(symbol, 'TW', candles, { trustedOfficial: true });
    }
    const after = await readCandleFile(symbol, 'TW');
    const remaining = dates.filter(date => !isCompleteMarketIndexCandle(after?.candles.find(c => c.date === date)));
    if (remaining.length) throw new Error(`${symbol} missing official OHLCV: ${remaining.join(', ')}`);
    console.log(`${symbol}: ${dates.length} trading days verified through ${dates.at(-1)}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
