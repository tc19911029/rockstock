/**
 * 修復 CN L1 lastDate < 2026-04-17 的剩餘股票（EODHD 配額耗盡後備援）
 * 直接走 EastMoneyHistProvider → fallback TencentHistProvider，跳過 MultiMarketProvider
 * 並過濾掉 > 4/17 的盤中假 K 棒，避免二次污染
 *
 * 用法：npx tsx scripts/repair-cn-stale-via-em-tencent.ts
 */

import { config } from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { eastMoneyHistProvider } from '../lib/datasource/EastMoneyHistProvider';
import { tencentHistProvider } from '../lib/datasource/TencentHistProvider';
import { saveLocalCandles } from '../lib/datasource/LocalCandleStore';

const LATEST_VALID_DATE = '2026-04-17'; // CN 上一交易日（4/20 盤中尚未收盤）
const L1_DIR = '/Users/tzu-chienhsu/Desktop/rockstock/data/candles/CN';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function findStaleSymbols(): string[] {
  const files = readdirSync(L1_DIR);
  const out: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const cs = JSON.parse(readFileSync(`${L1_DIR}/${f}`, 'utf-8')).candles as Array<{ date: string }>;
      if (!cs?.length) continue;
      const last = cs[cs.length - 1].date;
      if (last < LATEST_VALID_DATE) out.push(f.replace('.json', ''));
    } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const symbols = findStaleSymbols();
  console.log(`找到 ${symbols.length} 支 lastDate < ${LATEST_VALID_DATE} 的 CN 股票\n`);
  if (symbols.length === 0) return;

  let ok = 0, fail = 0, skipped = 0;
  const failed: string[] = [];
  const t0 = Date.now();

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    let candles: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }> = [];
    let provider = '';
    // 先試 EastMoney（可能 throw）
    try {
      candles = await eastMoneyHistProvider.getHistoricalCandles(sym, '2y');
      provider = 'em';
    } catch { /* em throw，下面 fallback */ }

    if (!candles || candles.length === 0) {
      // fallback Tencent（也可能 throw）
      try {
        candles = await tencentHistProvider.getHistoricalCandles(sym, '2y');
        provider = 'tencent';
      } catch (err) {
        fail++;
        failed.push(`${sym}(${(err as Error).message?.slice(0, 60)})`);
        await sleep(200);
        continue;
      }
    }

    try {
      if (!candles || candles.length === 0) {
        fail++;
        failed.push(`${sym}(empty)`);
        continue;
      }

      // 過濾掉超過 4/17 的假盤中 K 棒
      const cleaned = candles.filter(c => c.date <= LATEST_VALID_DATE);
      const removed = candles.length - cleaned.length;
      const newLast = cleaned[cleaned.length - 1]?.date ?? '(empty)';

      if (newLast < LATEST_VALID_DATE) {
        skipped++;
        console.log(`  ${sym} [${provider}] 仍停在 ${newLast}（可能停牌）`);
        continue;
      }

      await saveLocalCandles(sym, 'CN', cleaned);
      ok++;
      console.log(`✓ ${sym} [${provider}] ${cleaned.length} candles, last=${newLast}${removed > 0 ? ` (擋掉 ${removed} 根假今日)` : ''}`);
    } catch (err) {
      fail++;
      failed.push(`${sym}(${(err as Error).message?.slice(0, 60)})`);
    }
    await sleep(200); // 溫和
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ 完成：ok=${ok} fail=${fail} skip=${skipped} elapsed=${elapsed}s`);
  if (failed.length > 0) console.log(`失敗（前 10）：${failed.slice(0, 10).join(', ')}`);
}

main().catch(err => { console.error('❌', err); process.exit(1); });
