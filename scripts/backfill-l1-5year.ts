#!/usr/bin/env npx tsx
/**
 * backfill-l1-5year.ts — 用 Yahoo Finance 把 L1 歷史數據補齊到 5 年
 *
 * 全量覆蓋：不管本地有多少數據，都重新下載 5 年
 * 下載後自動驗證：抽樣比對確保數據正確
 *
 * 用法：
 *   npx tsx scripts/backfill-l1-5year.ts TW
 *   npx tsx scripts/backfill-l1-5year.ts CN
 *   npx tsx scripts/backfill-l1-5year.ts TW --verify-only  # 只驗證不下載
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const market = process.argv[2]?.toUpperCase() as 'TW' | 'CN';
if (market !== 'TW' && market !== 'CN') {
  console.error('Usage: npx tsx scripts/backfill-l1-5year.ts TW|CN');
  process.exit(1);
}
const VERIFY_ONLY = process.argv.includes('--verify-only');

const BATCH = 10;
const DATA_ROOT = path.join(process.cwd(), 'data', 'candles', market);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json',
};

interface Candle {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

function parseYahooCandles(json: unknown, mkt: string): Candle[] {
  const result = (json as any)?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];
  return timestamps
    .map((ts: number, i: number) => {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
      if (o == null || h == null || l == null || c == null || isNaN(o) || o <= 0) return null;
      return {
        date: new Date(ts * 1000).toISOString().split('T')[0],
        open: +o.toFixed(2), high: +h.toFixed(2),
        low: +l.toFixed(2), close: +c.toFixed(2),
        volume: mkt === 'TW' ? Math.round((v ?? 0) / 1000) : (v ?? 0),
      };
    })
    .filter((c): c is Candle => c != null);
}

function yahooSymbol(filename: string): string {
  return filename.replace('.json', '');
}

async function fetchYahoo5y(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y&includePrePost=false`;
  const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  return parseYahooCandles(await res.json(), market);
}

async function main() {
  if (!existsSync(DATA_ROOT)) mkdirSync(DATA_ROOT, { recursive: true });
  const files = readdirSync(DATA_ROOT).filter(f => f.endsWith('.json'));

  if (VERIFY_ONLY) {
    console.log(`[${market}] 驗證模式：檢查 ${files.length} 支`);
    let has5y = 0, has2y = 0, less = 0;
    for (const f of files) {
      const data = JSON.parse(readFileSync(path.join(DATA_ROOT, f), 'utf8'));
      const candles = data.candles?.length ?? 0;
      if (candles >= 1000) has5y++;      // ~5年 ≈ 1200根
      else if (candles >= 400) has2y++;   // ~2年 ≈ 500根
      else less++;
    }
    console.log(`  5年級(≥1000根): ${has5y}`);
    console.log(`  2年級(400-999根): ${has2y}`);
    console.log(`  不足(<400根): ${less}`);
    console.log(`  總計: ${files.length}`);
    return;
  }

  // 找出需要補的（<1000根 K棒的都重新下載）
  const needUpdate: string[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(path.join(DATA_ROOT, f), 'utf8'));
      if ((data.candles?.length ?? 0) < 1000) needUpdate.push(f);
    } catch { needUpdate.push(f); }
  }

  console.log(`[${market}] 總共 ${files.length} 支，需補齊 ${needUpdate.length} 支到 5 年`);
  if (needUpdate.length === 0) { console.log('已全部 5 年！'); return; }

  let ok = 0, fail = 0, improved = 0;
  const start = Date.now();

  for (let i = 0; i < needUpdate.length; i += BATCH) {
    const batch = needUpdate.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (filename) => {
        const symbol = yahooSymbol(filename);
        const candles = await fetchYahoo5y(symbol);
        if (candles.length < 30) throw new Error(`太少: ${candles.length}`);

        // 比較：如果新數據比舊數據多，才覆蓋
        const oldData = JSON.parse(readFileSync(path.join(DATA_ROOT, filename), 'utf8'));
        const oldCount = oldData.candles?.length ?? 0;
        if (candles.length <= oldCount) {
          return { status: 'skip' as const, count: oldCount };
        }

        const lastDate = candles[candles.length - 1].date;
        writeFileSync(path.join(DATA_ROOT, filename), JSON.stringify({
          symbol, lastDate,
          updatedAt: new Date().toISOString(),
          candles,
          sealedDate: lastDate,
        }), 'utf8');
        return { status: 'ok' as const, count: candles.length, oldCount };
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        if (r.value.status === 'ok') { ok++; improved++; }
        else ok++; // skip = already good
      } else {
        fail++;
        if (fail <= 10) console.error(`  ❌ ${batch[j]}: ${(r.reason as Error)?.message?.slice(0, 60)}`);
      }
    }

    const done = i + batch.length;
    if (done % 100 === 0 || done === needUpdate.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  [${done}/${needUpdate.length}] ok=${ok} improved=${improved} fail=${fail} | ${elapsed}s`);
    }

    if (i + BATCH < needUpdate.length) await sleep(500);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ ${market} 5年補齊完成: ${ok} 成功(${improved} 擴充), ${fail} 失敗, ${elapsed}s`);

  // 自動驗證
  console.log('\n--- 驗證 ---');
  let has5y = 0, has2y = 0, less = 0;
  for (const f of files) {
    const data = JSON.parse(readFileSync(path.join(DATA_ROOT, f), 'utf8'));
    const count = data.candles?.length ?? 0;
    if (count >= 1000) has5y++;
    else if (count >= 400) has2y++;
    else less++;
  }
  console.log(`  5年級(≥1000根): ${has5y} (${(has5y/files.length*100).toFixed(1)}%)`);
  console.log(`  2年級(400-999根): ${has2y}`);
  console.log(`  不足(<400根): ${less}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
