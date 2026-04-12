/**
 * 直接用 Blob SDK 上傳 CN K 線到 Vercel Blob（private store）
 * 用法：export $(grep -v '^#' .env.local | xargs) && npx tsx scripts/upload-cn-direct.ts
 */

import { put } from '@vercel/blob';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'candles', 'CN');
const BATCH = 10;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  const files = (await readdir(DATA_DIR)).filter(f => f.endsWith('.json'));
  console.log(`📤 CN：${files.length} 個檔案待上傳`);

  let ok = 0, fail = 0;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const content = await readFile(path.join(DATA_DIR, file), 'utf-8');
        await put(`candles/CN/${file}`, content, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') ok++;
      else { fail++; console.error('  ❌', r.reason?.message); }
    }
    if ((i + BATCH) % 100 < BATCH) {
      console.log(`  進度: ${i + BATCH}/${files.length} (ok=${ok}, fail=${fail})`);
    }
    if (i + BATCH < files.length) await sleep(200);
  }

  console.log(`\n✅ 完成：${ok} 成功, ${fail} 失敗`);
}

main().catch(console.error);
