/**
 * 手動下載全市場 K 線到本地
 *
 * 用法：
 *   npx tsx scripts/download-candles.ts --market TW
 *   npx tsx scripts/download-candles.ts --market CN
 *   npx tsx scripts/download-candles.ts --market TW --market CN  (兩個都下載)
 */

import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles, getLocalCandleDir } from '../lib/datasource/LocalCandleStore';
import { readdirSync } from 'fs';

const CONCURRENCY = 8;
const BATCH_DELAY_MS = 300;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function downloadMarket(market: 'TW' | 'CN') {
  const scanner = market === 'CN' ? new ChinaScanner() : new TaiwanScanner();
  const startTime = Date.now();

  console.log(`\n📥 開始下載 ${market} 市場 K 線數據...\n`);

  const stocks = await scanner.getStockList();
  console.log(`  股票數量: ${stocks.length}`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < stocks.length; i += CONCURRENCY) {
    const batch = stocks.slice(i, i + CONCURRENCY);
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

    if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);

    // 進度條
    const progress = Math.min(100, Math.round(((i + CONCURRENCY) / stocks.length) * 100));
    const bar = '█'.repeat(Math.floor(progress / 2)) + '░'.repeat(50 - Math.floor(progress / 2));
    process.stdout.write(`\r  [${bar}] ${progress}% (${succeeded}/${stocks.length})`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 統計本地檔案數
  let fileCount = 0;
  try {
    fileCount = readdirSync(getLocalCandleDir(market)).filter(f => f.endsWith('.json')).length;
  } catch { /* dir might not exist yet */ }

  console.log(`\n\n✅ ${market} 下載完成`);
  console.log(`   成功: ${succeeded}  失敗: ${failed}  耗時: ${duration}s`);
  console.log(`   本地檔案數: ${fileCount}`);
}

async function main() {
  const args = process.argv.slice(2);
  const markets: ('TW' | 'CN')[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const m = args[i + 1].toUpperCase();
      if (m === 'TW' || m === 'CN') markets.push(m);
      i++;
    }
  }

  if (markets.length === 0) {
    console.log('用法: npx tsx scripts/download-candles.ts --market TW [--market CN]');
    process.exit(1);
  }

  for (const market of markets) {
    await downloadMarket(market);
  }

  console.log('\n🎉 全部完成！\n');
}

main().catch(err => {
  console.error('❌ 下載失敗:', err);
  process.exit(1);
});
