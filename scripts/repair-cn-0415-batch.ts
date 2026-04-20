/**
 * 一次性修復：掃出 CN L1 lastDate = 2026-04-15 的 131 支，補 4/16, 4/17 K 棒
 *
 * 用法：npx tsx scripts/repair-cn-0415-batch.ts
 */

import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const STALE_TARGET_DATE = '2026-04-15';
const L1_DIR = '/Users/tzu-chienhsu/Desktop/rockstock/data/candles/CN';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function findStaleSymbols(): string[] {
  const files = readdirSync(L1_DIR);
  const out: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const cs = JSON.parse(readFileSync(`${L1_DIR}/${f}`, 'utf-8')).candles as Array<{ date: string }>;
      if (cs?.length && cs[cs.length - 1].date === STALE_TARGET_DATE) {
        out.push(f.replace('.json', ''));
      }
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const symbols = findStaleSymbols();
  console.log(`找到 ${symbols.length} 支 lastDate=${STALE_TARGET_DATE} 的 CN 股票\n`);

  if (symbols.length === 0) return;

  const scanner = new ChinaScanner();
  let ok = 0, fail = 0, skipped = 0;
  const failed: string[] = [];
  const t0 = Date.now();

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const candles = await scanner.fetchCandles(sym);
      if (candles.length === 0) {
        fail++;
        failed.push(`${sym}(empty)`);
        continue;
      }
      const last = candles[candles.length - 1].date;
      if (last <= STALE_TARGET_DATE) {
        skipped++;
        console.log(`  ${sym} 仍停在 ${last}（可能停牌）`);
        continue;
      }
      await saveLocalCandles(sym, 'CN', candles);
      ok++;
      if ((i + 1) % 20 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ${i + 1}/${symbols.length} ok=${ok} fail=${fail} skip=${skipped} elapsed=${elapsed}s`);
      }
    } catch (err) {
      fail++;
      failed.push(`${sym}(${(err as Error).message?.slice(0, 60)})`);
    }
    await sleep(150); // 溫和間隔
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ 完成：ok=${ok} fail=${fail} skip(stopped?)=${skipped} elapsed=${elapsed}s`);
  if (failed.length > 0) {
    console.log(`失敗清單（前 10）：${failed.slice(0, 10).join(', ')}`);
  }
}

main().catch(err => {
  console.error('❌ 腳本錯誤:', err);
  process.exit(1);
});
