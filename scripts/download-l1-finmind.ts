#!/usr/bin/env npx tsx
/**
 * download-l1-finmind.ts — 用 FinMind 補齊 Yahoo 未更新的 TW 股票
 * FinMind 速率限制 300次/hr(無認證)，所以只補缺的，不全量跑
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const TARGET_DATE = '2026-04-15';
const BATCH = 4; // FinMind 限速，少量並行
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', 'TW');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Candle {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

async function fetchFinMind(stockId: string): Promise<Candle[]> {
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  const start = startDate.toISOString().split('T')[0];
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${stockId}&start_date=${start}&end_date=${TARGET_DATE}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`FinMind ${res.status}`);
  const json = await res.json() as { data?: Array<{ date: string; open: number; max: number; min: number; close: number; Trading_Volume: number }> };
  if (!json.data || json.data.length === 0) return [];
  return json.data.map(r => ({
    date: r.date,
    open: r.open,
    high: r.max,
    low: r.min,
    close: r.close,
    volume: Math.round(r.Trading_Volume / 1000), // 股→張
  }));
}

async function main() {
  // 找出需要補的檔案（Yahoo 沒更新到 4/15 的）
  const files = readdirSync(DATA_ROOT).filter(f => f.endsWith('.json'));
  const needUpdate: string[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(path.join(DATA_ROOT, f), 'utf8'));
      const lastCandle = data.candles?.[data.candles.length - 1]?.date;
      if (!lastCandle || lastCandle < TARGET_DATE) needUpdate.push(f);
    } catch { needUpdate.push(f); }
  }

  console.log(`[TW-FinMind] 需補 ${needUpdate.length} 支（目標: ${TARGET_DATE}）`);
  if (needUpdate.length === 0) { console.log('已全部齊全！'); return; }

  let ok = 0, fail = 0;
  const start = Date.now();

  for (let i = 0; i < needUpdate.length; i += BATCH) {
    const batch = needUpdate.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (filename) => {
        // 從檔名提取純數字代碼
        const stockId = filename.replace(/\.(TW|TWO)\.json$/i, '');
        const candles = await fetchFinMind(stockId);
        if (candles.length < 30) throw new Error(`太少: ${candles.length}`);

        const symbol = filename.replace('.json', '');
        const lastDate = candles[candles.length - 1].date;
        writeFileSync(path.join(DATA_ROOT, filename), JSON.stringify({
          symbol, lastDate,
          updatedAt: new Date().toISOString(),
          candles,
          sealedDate: lastDate,
        }), 'utf8');
        return lastDate;
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') ok++;
      else {
        fail++;
        if (fail <= 5) console.error(`  ❌ ${batch[j]}: ${(r.reason as Error)?.message?.slice(0, 60)}`);
      }
    }

    const done = i + batch.length;
    if (done % 50 === 0 || done === needUpdate.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${done}/${needUpdate.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
    }

    // FinMind 限速：300次/hr ≈ 5次/min，4並行+3秒間隔
    if (i + BATCH < needUpdate.length) await sleep(3000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ TW-FinMind 完成: ${ok} 成功, ${fail} 失敗, ${elapsed}s`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
