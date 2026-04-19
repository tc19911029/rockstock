/**
 * 將本地 data/institutional/TW-*.json 上傳到 Vercel Blob
 * 強制用 Blob 模式（不看 VERCEL 環境變數）
 *
 * 用法：BLOB_READ_WRITE_TOKEN=xxx npx tsx scripts/upload-institutional-to-blob.ts
 *   或（token 已在 .env.local）：npx tsx scripts/upload-institutional-to-blob.ts
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { readdirSync, readFileSync } from 'fs';
import path from 'path';

async function main() {
  const dir = path.join(process.cwd(), 'data', 'institutional');
  if (!existsSync(dir)) {
    console.log('❌ 找不到 data/institutional/');
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('❌ 缺 BLOB_READ_WRITE_TOKEN');
    return;
  }

  const { put } = await import('@vercel/blob');
  const files = readdirSync(dir).filter(f => /^TW-\d{4}-\d{2}-\d{2}\.json$/.test(f));
  console.log(`📤 上傳 ${files.length} 檔到 Vercel Blob`);

  let ok = 0, fail = 0;
  for (const file of files) {
    const date = file.replace(/^TW-|\.json$/g, '');
    const content = readFileSync(path.join(dir, file), 'utf-8');
    const key = `institutional/TW/${date}.json`;
    try {
      await put(key, content, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      console.log(`✅ ${date}`);
      ok++;
    } catch (err) {
      console.error(`❌ ${date}:`, err instanceof Error ? err.message : err);
      fail++;
    }
  }
  console.log(`\n🎉 上傳完成：ok=${ok} fail=${fail}`);
}

main().catch(err => { console.error(err); process.exit(1); });
