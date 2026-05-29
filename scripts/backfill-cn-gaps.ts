/**
 * 補抓 CN 缺漏 K 棒（用 Tencent + EastMoney fallback）
 *
 * 用法：
 *   npx tsx scripts/backfill-cn-gaps.ts                                   # 預設補近 6 交易日
 *   npx tsx scripts/backfill-cn-gaps.ts --dates 2026-04-23,2026-04-24
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { promises as fs } from 'fs';
import path from 'path';
import { tencentHistProvider } from '@/lib/datasource/TencentHistProvider';
import { eastMoneyHistProvider } from '@/lib/datasource/EastMoneyHistProvider';
import { writeCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { isTradingDay } from '@/lib/utils/tradingDay';

const CONCURRENCY = 4;
const DELAY_MS = 600;
const MIN_CANDLES = 5;  // 補抓只需有近期幾根，不需 30 根門檻

// 自動推最近 N 個 CN 交易日（catch-up 用，免 hardcode；機器睡過頭時補回）
function recentCnTradingDays(n: number): string[] {
  const out: string[] = [];
  const cur = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()) + 'T12:00:00');
  while (out.length < n) {
    const ds = cur.toISOString().split('T')[0];
    if (isTradingDay(ds, 'CN')) out.push(ds);
    cur.setDate(cur.getDate() - 1);
  }
  return out.reverse();
}

async function main() {
  const args = process.argv.slice(2);
  let targetDates = recentCnTradingDays(12);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dates' && args[i + 1]) {
      targetDates = args[i + 1].split(',').map(s => s.trim());
      i++;
    }
  }
  console.log(`📅 補抓目標日期：${targetDates.join(', ')}`);

  const dir = path.join('data', 'candles', 'CN');
  const files = await fs.readdir(dir);
  const candidates: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      const dates = new Set((j.candles ?? []).map((c: { date: string }) => c.date));
      const missing = targetDates.filter(d => !dates.has(d));
      if (missing.length > 0) candidates.push(f.replace('.json', ''));
    } catch { /* skip */ }
  }
  console.log(`🔍 ${candidates.length} 支股票缺漏，開始補抓 (Tencent → EastMoney)...`);

  let ok = 0, fail = 0, noNewData = 0;
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async (symbol) => {
      try {
        let candles = null;
        // 試 Tencent
        try {
          candles = await tencentHistProvider.getHistoricalCandles(symbol, '3mo');
          if (!candles || candles.length < MIN_CANDLES) candles = null;
        } catch { /* fallthrough */ }
        // 退到 EastMoney
        if (!candles) {
          try {
            candles = await eastMoneyHistProvider.getHistoricalCandles(symbol, '3mo');
            if (!candles || candles.length < MIN_CANDLES) candles = null;
          } catch { /* fallthrough */ }
        }
        if (!candles) { noNewData++; return; }
        const newDates = new Set(candles.map(c => c.date));
        const stillMissing = targetDates.filter(d => !newDates.has(d));
        if (stillMissing.length === targetDates.length) {
          noNewData++;
          return;
        }
        await writeCandleFile(symbol, 'CN', candles);
        ok++;
      } catch {
        fail++;
      }
    }));
    if (i + CONCURRENCY < candidates.length) await new Promise(r => setTimeout(r, DELAY_MS));
    console.log(`  進度 ${Math.min(i + CONCURRENCY, candidates.length)}/${candidates.length}  ok=${ok} fail=${fail} noNewData=${noNewData}`);
  }
  console.log(`\n🎉 完成 ok=${ok} fail=${fail} noNewData=${noNewData}`);
}

main().catch(err => { console.error('❌:', err); process.exit(1); });
