/**
 * 抓 CN top 500 主力資金流 → per-date JSON
 *
 * 用法：
 *   npx tsx scripts/fetch-cn-capital-flow.ts           # 近 5 天
 *   npx tsx scripts/fetch-cn-capital-flow.ts --days 10 # 近 10 天
 *
 * 策略：
 *   對 top 500 每股呼叫一次 push2his/fflow/daykline 抓近 N 天
 *   聚合後按日期分組存 per-date JSON
 */
import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import { fetchCapitalFlow } from '../lib/datasource/EastMoneyCapitalFlow';
import { saveCapitalFlowCN, type CapitalFlowRecord } from '../lib/storage/capitalFlowStorage';
import { computeTurnoverRankAsOfDate } from '../lib/scanner/TurnoverRank';
import { isTradingDay } from '../lib/utils/tradingDay';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  let days = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
  }

  const scanner = new ChinaScanner();
  const all = await scanner.getStockList();

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const rank = await computeTurnoverRankAsOfDate('CN', all, today, 500);
  const top500 = [...rank.keys()];
  console.log(`\n🏦 抓 CN top 500 主力資金流 (近 ${days} 天)`);
  console.log(`  stock count: ${top500.length}`);

  // per-date bucket: { 'YYYY-MM-DD': Map<symbol, mainNet> }
  const buckets = new Map<string, Map<string, number>>();

  let done = 0, fail = 0;
  for (const symbol of top500) {
    try {
      const flow = await fetchCapitalFlow(symbol, days);
      const pureSym = symbol.replace(/\.(SS|SZ)$/i, '');
      for (const day of flow) {
        if (!buckets.has(day.date)) buckets.set(day.date, new Map());
        buckets.get(day.date)!.set(pureSym, day.mainNet);
      }
      done++;
      if (done % 50 === 0) process.stdout.write(`\r   進度: ${done}/${top500.length}`);
    } catch (err) {
      fail++;
    }
    // rate limit: 10 req/sec（東財典型限制）
    await sleep(100);
  }
  console.log(`\n\n✅ 抓取完成 ok=${done} fail=${fail}`);

  // 存 per-date JSON
  const dates = [...buckets.keys()].filter(d => isTradingDay(d, 'CN'));
  for (const date of dates) {
    const records: CapitalFlowRecord[] = [...buckets.get(date)!.entries()].map(
      ([symbol, mainNet]) => ({ symbol, mainNet })
    );
    await saveCapitalFlowCN(date, records);
    console.log(`💾 ${date} 存 ${records.length} 筆`);
  }

  console.log(`\n🎉 完成：${dates.length} 個交易日`);
}

main().catch(err => { console.error(err); process.exit(1); });
