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
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { verifyDownload } from '@/lib/datasource/DownloadVerifier';
import { ChinaScanner } from '@/lib/scanner/ChinaScanner';

const CONCURRENCY = 4;
const DELAY_MS = 600;
const MIN_CANDLES = 5;  // 補抓只需有近期幾根，不需 30 根門檻

// 鐵則 #1：catch-up 只補「已收盤封存」的交易日，今日進行中那根交給 eod-settle，
// 不可寫進 L1。getLastTradingDay 盤前/盤中回上一個已收盤日，盤後才回今天 →
// 機器睡過 08:30、launchd 盤中補跑時，cutoff 仍是昨日，今日半根不會污染 L1。
const SEAL_CUTOFF = getLastTradingDay('CN');

// 自動推最近 N 個 CN 交易日（catch-up 用，免 hardcode；機器睡過頭時補回）。
// 從 SEAL_CUTOFF（最後已收盤日）起算，不含今日進行中那根。
function recentCnTradingDays(n: number): string[] {
  const out: string[] = [];
  const cur = new Date(SEAL_CUTOFF + 'T12:00:00');
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
  const requiredLatestDate = [...targetDates].sort().at(-1);
  if (!requiredLatestDate) throw new Error('target dates cannot be empty');

  const dir = path.join('data', 'candles', 'CN');
  const files = await fs.readdir(dir);
  // 候選母體不能只靠既有檔案：動態股票清單新增的新股／遷移代號若尚未建檔，
  // 舊邏輯永遠看不到它，verify 卻會把它算進分母，造成固定的 readFailed。
  const scanner = new ChinaScanner();
  const stocks = await scanner.getStockList();
  // 只補目前 scanner 的活躍母體；歷史檔案可能仍保留已退市股票，若把整個目錄
  // 併回來，prune 後下一輪仍會浪費數小時反覆請求死代號。指數另行明確加入。
  const universe = new Set([
    ...stocks.map((stock) => stock.symbol),
    '000001.SS',
  ]);
  const candidates: string[] = [];
  for (const symbol of universe) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, `${symbol}.json`), 'utf8'));
      const dates = new Set((j.candles ?? []).map((c: { date: string }) => c.date));
      const missing = targetDates.filter(d => !dates.has(d));
      if (missing.length > 0) candidates.push(symbol);
    } catch {
      // 股票主檔有、L1 尚未建檔：必須列為候選，成功抓取後由 writeCandleFile 首次建立。
      candidates.push(symbol);
    }
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
        // 鐵則 #1 硬守門：剔除 > 最後已收盤日的盤中半根（provider 盤中會回今日進行中那根）。
        candles = candles.filter((c) => c.date <= SEAL_CUTOFF);
        if (candles.length < MIN_CANDLES) { noNewData++; return; }
        const newDates = new Set(candles.map(c => c.date));
        // 「成功」必須至少包含本輪最新目標日；舊邏輯只要補到近 12 日
        // 任一天就算成功，曾回報 2,124 檔成功但當日 coverage 仍僅 79%。
        if (!newDates.has(requiredLatestDate)) {
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

  // Catch-up is the final CN L1 writer before the evening scan. Rebuild the
  // coverage report here so the scan guard does not keep reading the stale
  // report generated before catch-up completed.
  const symbols = stocks.map((stock) => stock.symbol);
  const report = await verifyDownload('CN', SEAL_CUTOFF, symbols, {
    succeeded: ok,
    failed: fail + noNewData,
    skipped: Math.max(0, symbols.length - ok - fail - noNewData),
  });
  console.log(
    `📋 verify ${SEAL_CUTOFF}: coverage=${(report.summary.coverageRate * 100).toFixed(1)}% ` +
    `health=${report.health} current=${report.summary.stocksCurrent}/${report.summary.totalStocks}`,
  );
}

main().catch(err => { console.error('❌:', err); process.exit(1); });
