/**
 * 補抓 04-23 缺漏的 TW K 棒
 *
 * 掃 data/candles/TW 下所有 stock，找出 04-23 缺漏的，用 Yahoo 抓 1mo 區間補回來。
 * 走 merge 寫法（writeCandleFile 內部會自動去重 + 排序）
 *
 * 用法：
 *   npx tsx scripts/backfill-tw-0423.ts                    # 補 04-23 + 04-24 缺的
 *   npx tsx scripts/backfill-tw-0423.ts --dates 2026-04-23,2026-04-24
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { yahooProvider } from '@/lib/datasource/YahooDataProvider';
import { writeCandleFile } from '@/lib/datasource/CandleStorageAdapter';

const CONCURRENCY = 6;
const DELAY_MS = 400;

async function main() {
  const args = process.argv.slice(2);
  let targetDates = ['2026-04-23', '2026-04-24'];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dates' && args[i + 1]) {
      targetDates = args[i + 1].split(',').map(s => s.trim());
      i++;
    }
  }
  console.log(`📅 補抓目標日期：${targetDates.join(', ')}`);

  const dir = path.join('data', 'candles', 'TW');
  const files = await fs.readdir(dir);
  const candidates: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      const dates = new Set((j.candles ?? []).slice(-15).map((c: { date: string }) => c.date));
      const missing = targetDates.filter(d => !dates.has(d));
      if (missing.length > 0) candidates.push(f.replace('.json', ''));
    } catch { /* skip broken */ }
  }
  console.log(`🔍 ${candidates.length} 支股票缺漏，開始補抓...`);

  let ok = 0, fail = 0, noNewData = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (symbol) => {
      try {
        const candles = await yahooProvider.getHistoricalCandles(symbol, '1mo');
        if (!candles || candles.length < 5) { noNewData++; return; }
        const newDates = new Set(candles.map(c => c.date));
        const stillMissing = targetDates.filter(d => !newDates.has(d));
        if (stillMissing.length === targetDates.length) {
          // Yahoo 也沒這天的資料（可能停牌）
          noNewData++;
          return;
        }
        await writeCandleFile(symbol, 'TW', candles);
        ok++;
      } catch {
        fail++;
      }
    }));
    if (i + CONCURRENCY < candidates.length) await new Promise(r => setTimeout(r, DELAY_MS));
    if ((i + batch.length) % 60 === 0 || i + batch.length === candidates.length) {
      console.log(`  進度 ${i + batch.length}/${candidates.length}  ok=${ok} fail=${fail} noNewData=${noNewData}`);
    }
  }

  console.log(`\n🎉 完成 ok=${ok} fail=${fail} noNewData=${noNewData}`);
}

main().catch(err => { console.error('❌ 致命錯誤:', err); process.exit(1); });
