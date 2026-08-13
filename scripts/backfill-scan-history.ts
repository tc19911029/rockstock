/**
 * 用 L1 歷史資料 + 當前掃描程式碼，重跑過去 N 個交易日的 scan，產出正確 L4。
 *
 * 為什麼需要：
 *   PR #35/#42 加了 Step 1 池子 + 多頭軌字母過池子的 gate。但 PR 是 5/9 15:22
 *   merge 的，5/9 cron 已在 14:00 跑過（沒這 feature），5/10/11 是非交易日。
 *   所以 production Blob 過去 letter sessions **沒有** 經過 Step 1 gate；step1-
 *   pool 也從未被任何 production cron 寫入過。
 *
 * 用同一條 ScanPipeline (production cron 用的) 重跑：
 *   - 每個 (market, date) 跑一次 runScanPipeline，帶 buyMethods=B-Q
 *   - 內部依序：scanSOP（寫 step1-pool + daily session）→ 13 個 scanBuyMethod
 *     （多頭軌讀池子過 gate；反轉軌+戰法軌全市場掃）
 *   - allowOverwritePostClose 自動 true（saveScanSession 對 post_close 預設覆蓋）
 *
 * Usage:
 *   # local dev fs（測試用）
 *   npx tsx scripts/backfill-scan-history.ts --days 20
 *
 *   # production Blob
 *   set -a; source .env.local; set +a
 *   VERCEL=1 npx tsx scripts/backfill-scan-history.ts --blob --apply
 *
 *   # 縮小範圍測試
 *   ... --days 1 --market TW
 *   ... --date 2026-05-08 --market TW
 *
 * 注意：每個 (market, date) 跑 ~100-250s。20 天 × 2 市場 ~100 分鐘。
 */

import { isTradingDay } from '../lib/utils/tradingDay';
import { runScanPipeline } from '../lib/scanner/ScanPipeline';
import { computeTurnoverRankAsOfDate } from '../lib/scanner/TurnoverRank';
import { TaiwanScanner } from '../lib/scanner/TaiwanScanner';
import { ChinaScanner } from '../lib/scanner/ChinaScanner';
import type { MarketId } from '../lib/scanner/types';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ALL_BUY_METHODS = ['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'] as const;
type BuyMethod = (typeof ALL_BUY_METHODS)[number];

function getLastNTradingDays(n: number, market: MarketId): string[] {
  const result: string[] = [];
  const utc8Now = new Date(Date.now() + 8 * 3600_000);
  const todayStr = utc8Now.toISOString().split('T')[0];
  const check = new Date(todayStr + 'T12:00:00');
  while (result.length < n) {
    const dateStr = check.toISOString().split('T')[0];
    if (isTradingDay(dateStr, market)) {
      result.push(dateStr);
    }
    check.setDate(check.getDate() - 1);
    if (result.length === 0 && (todayStr.localeCompare(dateStr) > 60 * 60)) break; // safety
  }
  return result.reverse();
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const useBlob = process.argv.includes('--blob');
  const existingOnly = process.argv.includes('--existing');
  const days = Number(arg('days', '20'));
  const marketArg = arg('market') as MarketId | undefined;
  const singleDate = arg('date');

  if (useBlob) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      console.error('--blob 模式需要 BLOB_READ_WRITE_TOKEN（請 source .env.local）');
      process.exit(1);
    }
    if (!process.env.VERCEL) process.env.VERCEL = '1';
  }

  const markets: MarketId[] = marketArg ? [marketArg] : ['TW', 'CN'];

  // 列出每個 market 要跑的日期。--existing 只重播已存在的正式 daily 日期，
  // 不會憑空建立尚未收盤的 session，也不碰 intraday 稽核快照。
  const plan: Array<{ market: MarketId; date: string }> = [];
  if (existingOnly) {
    if (useBlob) throw new Error('--existing 目前只支援本機資料；Blob 請明確指定 --date/--days');
    const entries = await fs.readdir(path.join(process.cwd(), 'data'));
    for (const market of markets) {
      const pattern = new RegExp(`^scan-${market}-long-daily-(\\d{4}-\\d{2}-\\d{2})\\.json$`);
      const dates = entries.flatMap((name) => name.match(pattern)?.[1] ?? []).sort();
      for (const date of dates) plan.push({ market, date });
    }
  } else for (const market of markets) {
    if (singleDate) {
      if (!isTradingDay(singleDate, market)) {
        console.warn(`[${market}] ${singleDate} 不是交易日，skip`);
        continue;
      }
      plan.push({ market, date: singleDate });
    } else {
      const dates = getLastNTradingDays(days, market);
      for (const date of dates) plan.push({ market, date });
    }
  }

  console.log(`\n=== Backfill scan history · ${useBlob ? 'BLOB' : 'LOCAL'} · ${apply ? 'APPLY' : 'DRY-RUN'} ===`);
  console.log(`Targets: ${plan.length} (markets=${markets.join(',')}, days=${singleDate ? 1 : days})\n`);
  for (const p of plan) console.log(`  ${p.market} ${p.date}`);

  if (!apply) {
    console.log('\n(dry-run) 加 --apply 才會實際重跑。預估每個 (market, date) 100-250s。');
    return;
  }

  let backupDir = '';
  if (!useBlob) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupDir = path.join(process.cwd(), 'data', `scan-history-backup-${stamp}`);
    await fs.mkdir(backupDir, { recursive: true });
    const targetKeys = new Set(plan.map((p) => `${p.market}|${p.date}`));
    const dataDir = path.join(process.cwd(), 'data');
    const entries = await fs.readdir(dataDir);
    let copied = 0;
    for (const name of entries) {
      const match = name.match(/^scan-(TW|CN)-(?:long|short)-(?:[A-Z]|daily|mtf)-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match || !targetKeys.has(`${match[1]}|${match[2]}`)) continue;
      await fs.copyFile(path.join(dataDir, name), path.join(backupDir, name));
      copied++;
    }
    for (const { market, date } of plan) {
      const pool = path.join(dataDir, 'step1-pool', market, `${date}.json`);
      try {
        const poolBackup = path.join(backupDir, 'step1-pool', market, `${date}.json`);
        await fs.mkdir(path.dirname(poolBackup), { recursive: true });
        await fs.copyFile(pool, poolBackup);
      } catch { /* 舊日期可能尚無 Step 1 池 */ }
    }
    console.log(`Backup: ${backupDir} (${copied} scan sessions)`);
  }

  let ok = 0;
  let failed = 0;
  const startAll = Date.now();
  const stockCache = new Map<MarketId, Array<{ symbol: string; name?: string }>>();
  for (const { market, date } of plan) {
    const start = Date.now();
    console.log(`\n--- ${market} ${date} ---`);
    try {
      if (!stockCache.has(market)) {
        const scanner = market === 'TW' ? new TaiwanScanner() : new ChinaScanner();
        stockCache.set(market, await scanner.getStockList());
      }
      const historicalRank = await computeTurnoverRankAsOfDate(market, stockCache.get(market)!, date, 500);
      if (historicalRank.size === 0) throw new Error(`${date} 歷史 top500 為空`);
      const result = await runScanPipeline({
        market,
        date,
        sessionType: 'post_close',
        directions: ['long', 'short'],
        mtfModes: ['daily', 'mtf'],
        buyMethods: ALL_BUY_METHODS as unknown as BuyMethod[],
        force: true,
        deadlineMs: useBlob ? 280_000 : 600_000,
        turnoverRankOverride: historicalRank,
      });
      if (result.timedOut) throw new Error('掃描逾時，只產生部分 session');
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const summary = Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`✓ ${market} ${date} (${elapsed}s) ${summary}${result.timedOut ? ' ⚠ timed out' : ''}`);
      ok++;
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.error(`✗ ${market} ${date} (${elapsed}s) FAILED: ${err}`);
      failed++;
    }
  }

  const totalMin = ((Date.now() - startAll) / 1000 / 60).toFixed(1);
  console.log(`\n=== Done · ${ok} ok / ${failed} failed · total ${totalMin} min ===`);
  if (backupDir) console.log(`Backup: ${backupDir}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
