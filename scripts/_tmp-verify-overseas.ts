/** 臨時驗證腳本（驗完即刪）：實抓 4 檔海外日K → 落地 → 讀回算報酬 */
import { fetchOverseasDailyCandles } from '@/lib/overseas/fetchPeerCandles';
import { dropUnsettledTodayBar } from '@/lib/overseas/peerReturns';
import { writeOverseasCandles, readOverseasCandles } from '@/lib/overseas/peerCandleStorage';
import { computeHorizonReturns } from '@/lib/overseas/peerReturns';

const TICKERS = ['MU', '285A.T', '005930.KS', '^SOX'];

async function main() {
  for (const t of TICKERS) {
    try {
      const raw = await fetchOverseasDailyCandles(t);
      const settled = dropUnsettledTodayBar(t, raw);
      const w = await writeOverseasCandles(t, settled);
      const back = await readOverseasCandles(t);
      const r = computeHorizonReturns(back?.candles);
      console.log(`${t}\tbars=${w.total}\tlastDate=${w.lastDate}\tdropped=${raw.length - settled.length}\tlast=${r.last}\td1=${r.d1}%\td5=${r.d5}%\td20=${r.d20}%\td60=${r.d60}%`);
    } catch (e) {
      console.log(`${t}\tFAIL: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}
main();
