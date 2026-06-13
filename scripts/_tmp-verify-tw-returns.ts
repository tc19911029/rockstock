/** 臨時驗證（驗完即刪）：台股端 L1 讀取 + 報酬計算 */
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeHorizonReturns } from '@/lib/overseas/peerReturns';

async function main() {
  for (const sym of ['2408.TW', '8299.TWO', '3081.TWO', '2327.TW']) {
    const f = await readCandleFile(sym, 'TW');
    const r = computeHorizonReturns(f?.candles);
    console.log(`${sym}\tbars=${f?.candles.length}\tlastDate=${r.lastDate}\tlast=${r.last}\td1=${r.d1}%\td5=${r.d5}%\td20=${r.d20}%\td60=${r.d60}%`);
  }
  process.exit(0);
}
main();
