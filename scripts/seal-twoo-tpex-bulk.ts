/**
 * 用 TPEx 官方 bulk feed 一次封存全上櫃當日 K（補完封存管線漏掉的）。
 *
 * 走修好的 prefetchVendorBatch（fetchTPExBulkForDate 已修 date-gating），一次 curl 抓 ~990 檔
 * 官方 OHLCV，對每檔還沒封該日的 .TWO 寫單根（單根 → 不觸發 saveLocalCandles 的漲跌停比對守衛）。
 * 寫前 snap 到合法檔位 + 檢查 OHLC 自洽。零 per-stock FinMind 呼叫 → 不撞配額。
 *
 * 用法：npx tsx scripts/seal-twoo-tpex-bulk.ts [--date 2026-06-09] [--dry]
 */
import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';

if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { prefetchVendorBatch } from '../lib/datasource/eodSettleBatch';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';
import { isValidTwTick, snapTwTick, isTwEtf } from '../lib/datasource/twTick';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const DATE = arg('--date', '2026-06-09');
const DRY = process.argv.includes('--dry');

async function main() {
  const cache = await prefetchVendorBatch('TW', DATE);
  console.log(`TPEx bulk(${DATE}): ${cache.tpexBulk.size} 檔${DRY ? ' [DRY]' : ''}`);
  if (cache.tpexBulk.size === 0) {
    console.error('TPEx bulk 空（feed 日 ≠ 要封的日，或抓取失敗）— 中止');
    process.exit(1);
  }

  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  let wrote = 0, skip = 0, noFeed = 0, ohlcBad = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.TWO.json')) continue;
    const sym = f.replace('.json', '');
    const code = sym.replace('.TWO', '');
    let j: { lastDate: string };
    try { j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (j.lastDate >= DATE) { skip++; continue; } // 已封該日（含更新）
    const row = cache.tpexBulk.get(code);
    if (!row) { noFeed++; continue; }            // TPEx 無此檔（未交易/下市）→ 留原樣

    const etf = isTwEtf(sym);
    const bar = {
      date: DATE,
      open: isValidTwTick(row.open, etf) ? row.open : snapTwTick(row.open, etf),
      high: isValidTwTick(row.high, etf) ? row.high : snapTwTick(row.high, etf),
      low: isValidTwTick(row.low, etf) ? row.low : snapTwTick(row.low, etf),
      close: isValidTwTick(row.close, etf) ? row.close : snapTwTick(row.close, etf),
      volume: row.volume,
    };
    // OHLC 自洽
    if (!(bar.high >= Math.max(bar.open, bar.close) - 1e-9 && bar.low <= Math.min(bar.open, bar.close) + 1e-9 && bar.low <= bar.high)) {
      ohlcBad++; console.warn(`  ${sym} OHLC 不自洽 ${JSON.stringify(bar)} → 跳過`); continue;
    }
    if (!DRY) {
      try { await saveLocalCandles(sym, 'TW', [bar]); } catch (e) { console.warn(`  ${sym} 寫入失敗: ${(e as Error).message}`); continue; }
    }
    wrote++;
    if (wrote <= 6 || wrote % 100 === 0) console.log(`  ${wrote}: ${sym} ${DATE} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`);
  }
  console.log('---');
  console.log(`封 ${wrote} 檔；已最新跳過 ${skip}；TPEx 無資料(未交易/下市) ${noFeed}；OHLC 不自洽 ${ohlcBad}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
