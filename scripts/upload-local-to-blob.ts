/**
 * 直接從本地 data/candles/ 批量上傳到 Vercel Blob
 * 跳過 repair API 的掃描超時問題
 *
 * npx tsx scripts/upload-local-to-blob.ts TW
 * npx tsx scripts/upload-local-to-blob.ts CN
 * npx tsx scripts/upload-local-to-blob.ts ALL
 */
import { put } from '@vercel/blob';
import { readdirSync, readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: '.env.local' });

const TARGET_DATE = '2026-04-13';
const DELAY_MS = 200; // 每支間隔，避免打爆 Blob API

const marketArg = (process.argv[2] || 'ALL').toUpperCase() as 'TW' | 'CN' | 'ALL';
const markets: Array<'TW' | 'CN'> = marketArg === 'ALL' ? ['TW', 'CN'] : [marketArg];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function blobKey(symbol: string, market: string): string {
  return `candles/${market}/${symbol}.json`;
}

async function uploadMarket(market: 'TW' | 'CN') {
  const dir = `data/candles/${market}`;
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  console.log(`\n[${market}] 共 ${files.length} 支，開始上傳...`);

  let uploaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const symbol = file.replace('.json', '');
    const filePath = path.join(dir, file);

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const lastDate: string = parsed.lastDate || '';

      // 只上傳有資料的
      if (!lastDate || parsed.candles?.length === 0) {
        skipped++;
        continue;
      }

      await put(blobKey(symbol, market), raw, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      uploaded++;

      if (uploaded % 50 === 0 || i === files.length - 1) {
        const pct = ((i + 1) / files.length * 100).toFixed(1);
        console.log(`  [${market}] ${i + 1}/${files.length} (${pct}%) uploaded=${uploaded} skipped=${skipped} failed=${failed} lastDate=${lastDate}`);
      }

      await sleep(DELAY_MS);
    } catch (err) {
      failed++;
      if (failed % 20 === 0) console.error(`  [${market}] failed: ${symbol} — ${(err as Error).message.slice(0, 80)}`);
    }
  }

  console.log(`[${market}] 完成: uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN 未設定');
  }
  console.log(`目標: 上傳本地 data/candles/ 到 Vercel Blob (市場: ${markets.join(',')})`);

  for (const market of markets) {
    await uploadMarket(market);
  }
  console.log('\n全部完成！');
}

main().catch(err => { console.error(err); process.exit(1); });
