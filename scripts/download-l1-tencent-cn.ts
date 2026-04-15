#!/usr/bin/env npx tsx
/**
 * download-l1-tencent-cn.ts — 用騰訊財經歷史K線API批量下載CN A股
 * 騰訊API無需key，台灣IP可連，速度快
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';

const TARGET_DATE = '2026-04-15';
const BATCH = 10;
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', 'CN');
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Candle {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

function toTencentSymbol(filename: string): string {
  // 601138.SS.json → sh601138, 000001.SZ.json → sz000001
  const m = filename.match(/^(\d{6})\.(SS|SZ)\.json$/i);
  if (!m) return '';
  const prefix = m[2].toUpperCase() === 'SS' ? 'sh' : 'sz';
  return prefix + m[1];
}

async function fetchTencent(tencentSym: string): Promise<Candle[]> {
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - 2);
  const start = startDate.toISOString().split('T')[0];

  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentSym},day,${start},${TARGET_DATE},800,qfq`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Tencent ${res.status}`);
  const json = await res.json() as any;

  const data = json?.data?.[tencentSym]?.day || json?.data?.[tencentSym]?.qfqday || [];
  if (!Array.isArray(data) || data.length === 0) return [];

  return data.map((row: any[]) => ({
    date: row[0],
    open: parseFloat(row[1]),
    close: parseFloat(row[2]),
    high: parseFloat(row[3]),
    low: parseFloat(row[4]),
    volume: Math.round(parseFloat(row[5]) / 100), // 股→手(100股=1手)
  })).filter((c: Candle) => c.open > 0);
}

async function main() {
  const files = readdirSync(DATA_ROOT).filter(f => f.endsWith('.json'));
  const needUpdate: string[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(path.join(DATA_ROOT, f), 'utf8'));
      const lastCandle = data.candles?.[data.candles.length - 1]?.date;
      if (!lastCandle || lastCandle < TARGET_DATE) needUpdate.push(f);
    } catch { needUpdate.push(f); }
  }

  console.log(`[CN-Tencent] 需補 ${needUpdate.length} 支（目標: ${TARGET_DATE}）`);
  if (needUpdate.length === 0) { console.log('已全部齊全！'); return; }

  let ok = 0, fail = 0;
  const start = Date.now();

  for (let i = 0; i < needUpdate.length; i += BATCH) {
    const batch = needUpdate.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (filename) => {
        const sym = toTencentSymbol(filename);
        if (!sym) throw new Error(`無法解析: ${filename}`);
        const candles = await fetchTencent(sym);
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
        if (fail <= 10) console.error(`  ❌ ${batch[j]}: ${(r.reason as Error)?.message?.slice(0, 60)}`);
      }
    }

    const done = i + batch.length;
    if (done % 100 === 0 || done === needUpdate.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${done}/${needUpdate.length}] ok=${ok} fail=${fail} | ${elapsed}s`);
    }

    if (i + BATCH < needUpdate.length) await sleep(300);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ CN-Tencent 完成: ${ok} 成功, ${fail} 失敗, ${elapsed}s`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
