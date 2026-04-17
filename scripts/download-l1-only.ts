/**
 * 純 L1 下載腳本（繞過 L2 守門，給 L2 異常時補 L1 用）
 *
 * 用途：EODHD 配額耗盡或 L2 被污染搬走時，用備用源（FinMind/TWSE/Yahoo）補齊 L1
 * 用法：npx tsx scripts/download-l1-only.ts --market TW
 *       npx tsx scripts/download-l1-only.ts --market CN
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles, batchCheckFreshness } from '../lib/datasource/LocalCandleStore';

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function getTodayDate(market: 'TW' | 'CN'): string {
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  return new Date().toLocaleString('sv-SE', { timeZone: tz }).split(' ')[0];
}

async function download(market: 'TW' | 'CN'): Promise<void> {
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const targetDate = getTodayDate(market);

  console.log(`\n📥 [${market}] 下載 L1 (目標 ${targetDate})`);
  const stocks = await scanner.getStockList();
  const symbols = stocks.map(s => s.symbol);
  // tolerance=0：只有 lastDate >= targetDate 才算 fresh，其餘都重抓
  // （原 daily-scan 用 tolerance=3 跳過 3 天內的；這裡給配額耗盡時補齊用，嚴格判定）
  const { fresh } = await batchCheckFreshness(symbols, market, targetDate, 0);
  const skipSet = new Set(fresh);
  const toDownload = stocks.filter(s => !skipSet.has(s.symbol));
  console.log(`   共 ${stocks.length}，最新 ${fresh.length}，待下載 ${toDownload.length}`);

  if (toDownload.length === 0) {
    console.log('   ✅ 全部最新');
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ symbol }) => {
        const candles = await scanner.fetchCandles(symbol);
        if (candles.length > 0) {
          await saveLocalCandles(symbol, market, candles);
        }
        return candles.length;
      })
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value > 0) succeeded++;
      else failed++;
    }
    if (i + CONCURRENCY < toDownload.length) await sleep(BATCH_DELAY_MS);
    const progress = Math.min(100, Math.round(((i + CONCURRENCY) / toDownload.length) * 100));
    process.stdout.write(`\r   下載進度: ${progress}% (${succeeded + failed}/${toDownload.length})`);
  }
  console.log(`\n   ✅ 成功 ${succeeded}，失敗 ${failed}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && i + 1 < args.length) {
      const m = args[i + 1].toUpperCase() as 'TW' | 'CN';
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    }
  }
  const targets: ('TW' | 'CN')[] = markets.length > 0 ? markets : ['TW', 'CN'];

  for (const m of targets) {
    try {
      await download(m);
    } catch (err) {
      console.error(`[${m}] 失敗:`, err);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
