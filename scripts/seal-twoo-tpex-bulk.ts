/**
 * 用 TPEx 官方 bulk feed 一次封存全上櫃當日 K（補完封存管線漏掉的）。
 *
 * 走修好的 prefetchVendorBatch（fetchTPExBulkForDate 已修 date-gating），一次 curl 抓 ~990 檔
 * 官方 OHLCV，對每檔還沒封該日的 .TWO 寫單根（單根 → 不觸發 saveLocalCandles 的漲跌停比對守衛）。
 * 寫前 snap 到合法檔位 + 檢查 OHLC 自洽。零 per-stock FinMind 呼叫 → 不撞配額。
 *
 * 用法：npx tsx scripts/seal-twoo-tpex-bulk.ts [--date 2026-06-09] [--dry] [--overwrite]
 *
 * --overwrite（2026-07-23 加）：預設只補「還沒封該日」的檔；帶這個旗標會**比對已封的 bar，
 * 與官方不符就覆寫**。用於 settle 當天落到中間價 vendor 的污染（2026-07-22：89 檔 .TWO
 * OHLC 錯，最嚴重 4442 收盤 46.825 vs 官方 51.3，差 9.6%）。
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
const OVERWRITE = process.argv.includes('--overwrite');

async function main() {
  const cache = await prefetchVendorBatch('TW', DATE);
  console.log(`TPEx bulk(${DATE}): ${cache.tpexBulk.size} 檔${DRY ? ' [DRY]' : ''}`);
  if (cache.tpexBulk.size === 0) {
    console.error('TPEx bulk 空（feed 日 ≠ 要封的日，或抓取失敗）— 中止');
    process.exit(1);
  }

  const dir = path.join(process.cwd(), 'data', 'candles', 'TW');
  let wrote = 0, skip = 0, noFeed = 0, ohlcBad = 0, fixed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.TWO.json')) continue;
    const sym = f.replace('.json', '');
    const code = sym.replace('.TWO', '');
    let j: { lastDate: string; candles?: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> };
    try { j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const existingBar = j.candles?.find((b) => b.date === DATE);
    if (j.lastDate >= DATE && !(OVERWRITE && existingBar)) { skip++; continue; } // 已封該日（含更新）
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
    // --overwrite：已封且與官方一致 → 不動（避免無謂寫盤 + 保留 1% 量的口徑差）
    if (OVERWRITE && existingBar) {
      const sameOhlc = (['open', 'high', 'low', 'close'] as const)
        .every((k) => Math.abs(existingBar[k] - bar[k]) < 0.005);
      if (sameOhlc) { skip++; continue; }
      // 官方 volume=0 但 L1 已有量 → 保留 L1 的量（官方偶爾漏量，別把好值抹掉）
      if (bar.volume === 0 && existingBar.volume > 0) bar.volume = existingBar.volume;
      fixed++;
      if (fixed <= 12) console.log(`  ✎ ${sym} ${existingBar.open}/${existingBar.high}/${existingBar.low}/${existingBar.close} → ${bar.open}/${bar.high}/${bar.low}/${bar.close}`);
    }
    if (!DRY) {
      try { await saveLocalCandles(sym, 'TW', [bar]); } catch (e) { console.warn(`  ${sym} 寫入失敗: ${(e as Error).message}`); continue; }
    }
    wrote++;
    if (!OVERWRITE && (wrote <= 6 || wrote % 100 === 0)) console.log(`  ${wrote}: ${sym} ${DATE} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`);
  }
  console.log('---');
  console.log(`寫入 ${wrote} 檔（其中覆寫修正 ${fixed}）；跳過 ${skip}；TPEx 無資料(未交易/下市) ${noFeed}；OHLC 不自洽 ${ohlcBad}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
