/**
 * 修復 repair-l1-gaps.ts 留下的 TW volume 單位污染
 *
 * 背景：repair-l1-gaps 第一次大規模用 Yahoo 寫 TW L1，但當時 Yahoo provider
 * 沒對 TW 做 /1000 轉換（Yahoo 單位是「股」，系統用「張」），導致所有
 * 被 repair 過的 TW 股 L1 歷史 volume 偏大 1000 倍。
 *
 * Yahoo provider 已修（commit TBD），重跑一次覆蓋。
 *
 * 只處理 TW；CN/美股無此問題。
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });

import { promises as fs } from 'fs';
import path from 'path';
import { yahooProvider } from '../lib/datasource/YahooDataProvider';
import { writeCandleFile } from '../lib/datasource/CandleStorageAdapter';

const CONCURRENCY = 6;
const DELAY_MS = 400;

async function main() {
  const dir = path.join('data', 'candles', 'TW');
  const files = await fs.readdir(dir);
  const candidates: string[] = [];

  // 篩選「有大 volume 的 TW 股票」——中位數 > 10 萬的幾乎一定是股單位污染
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      const c = j.candles as { volume: number }[];
      if (!c || c.length < 20) continue;
      // 看近 30 日中位 volume
      const recentVols = c.slice(-30).map(x => x.volume).sort((a, b) => a - b);
      const median = recentVols[Math.floor(recentVols.length / 2)];
      if (median > 100000) candidates.push(f);
    } catch { /* skip */ }
  }

  console.log(`TW 疑似 volume 單位污染: ${candidates.length} 支`);

  let ok = 0, fail = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (fname) => {
      const symbol = fname.replace('.json', '');
      try {
        const candles = await yahooProvider.getHistoricalCandles(symbol, '2y');
        if (candles.length >= 200) {
          await writeCandleFile(symbol, 'TW', candles);
          ok++;
        } else { fail++; }
      } catch { fail++; }
    }));
    await new Promise(r => setTimeout(r, DELAY_MS));
    const pct = Math.round((i + CONCURRENCY) / candidates.length * 100);
    process.stdout.write(`\r  進度 ${Math.min(100, pct)}% (成功${ok} 失敗${fail})`);
  }
  console.log(`\n完成 ✅`);
}

main().catch(err => { console.error(err); process.exit(1); });
