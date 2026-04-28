/**
 * 把本地 L1（剛補抓修好的）同步上 Vercel Blob
 *
 * 只同步「最近 N 天有更新」的檔案，避免把所有歷史資料重推一次。
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { put as blobPutRaw } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) { console.error('需要 BLOB_READ_WRITE_TOKEN'); process.exit(1); }

const RECENT_HOURS = 1; // 只推過去 N 小時內 mtime 有變動的（= 剛補抓的）
const CONCURRENCY = 6;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function blobPut(key: string, json: string) {
  await blobPutRaw(key, json, {
    access: 'private',
    token: TOKEN,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function syncMarket(market: 'TW' | 'CN'): Promise<{ ok: number; skip: number; fail: number }> {
  const dir = path.join('data', 'candles', market);
  const files = await fs.readdir(dir);
  let ok = 0, skip = 0, fail = 0;

  // 找最近 N 小時內有改動的（= 剛補抓的）
  const cutoff = Date.now() - RECENT_HOURS * 3600_000;
  const targets: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const stat = await fs.stat(path.join(dir, f));
      if (stat.mtimeMs >= cutoff) targets.push(f);
    } catch {}
  }
  console.log(`📤 ${market}: ${targets.length} 個檔案要同步到 Blob`);

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (f) => {
      const symbol = f.replace('.json', '');
      try {
        const json = await fs.readFile(path.join(dir, f), 'utf8');
        const key = `data/candles/${market}/${symbol}.json`;
        await blobPut(key, json);
        ok++;
      } catch (e) {
        fail++;
        if (fail <= 3) console.warn(`  fail ${symbol}:`, e instanceof Error ? e.message.slice(0, 80) : e);
      }
    }));
    if ((i / CONCURRENCY) % 10 === 0) {
      const pct = Math.round((i + CONCURRENCY) / targets.length * 100);
      process.stdout.write(`\r   ${market} ${Math.min(100, pct)}% ok=${ok} fail=${fail}`);
    }
    await sleep(150);
  }
  console.log(`\n   ${market} 完成: ok=${ok} fail=${fail}`);
  return { ok, skip, fail };
}

async function main() {
  await syncMarket('TW');
  await syncMarket('CN');
}

main().catch(e => { console.error(e); process.exit(1); });
