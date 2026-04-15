/**
 * backfill-mtf-scores.ts — 為歷史掃描檔案補寫 MTF 欄位
 *
 * MTF（多時間框架過濾器）在約 2026-04-09 之後才加入掃描器。
 * 2026-03-17 ~ 2026-04-08 的掃描檔案缺少 mtfScore / mtfWeeklyTrend 等欄位。
 * 此腳本為這些舊檔案補算 MTF 分數並寫回原始 JSON。
 *
 * 做法：
 *   1. 掃描 data/ 目錄，找出 scan-TW-long-daily-*.json 和 scan-TW-long-mtf-*.json
 *      且結果缺少 mtfScore 欄位的非 intraday 檔案
 *   2. 對每個掃描結果：
 *      - 從 data/candles/TW/{symbol_without_exchange}.json 讀日K
 *      - 截取到 <= 掃描日的 K 線
 *      - 執行 computeIndicators + evaluateMultiTimeframe
 *      - 補寫 mtfScore / mtfWeeklyTrend / mtfWeeklyPass / mtfWeeklyDetail /
 *               mtfMonthlyTrend / mtfMonthlyPass / mtfMonthlyDetail /
 *               mtfWeeklyNearResistance / mtfWeeklyChecks
 *   3. 存回原檔
 *
 * 執行方式：
 *   npx tsx scripts/backfill-mtf-scores.ts
 *   npx tsx scripts/backfill-mtf-scores.ts --date 2026-04-08   # 只跑特定日
 *   npx tsx scripts/backfill-mtf-scores.ts --dry-run            # 只顯示不存檔
 */

import * as fs from 'fs';
import * as path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateMultiTimeframe } from '@/lib/analysis/multiTimeframeFilter';
import { ZHU_V1 } from '@/lib/strategy/StrategyConfig';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filterDate = (() => {
  const idx = args.indexOf('--date');
  return idx >= 0 ? args[idx + 1] : null;
})();

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), 'data');
const CANDLE_DIR = path.join(DATA_DIR, 'candles', 'TW');

// ── Candle reading ─────────────────────────────────────────────────────────────

interface RawCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleFile {
  symbol?: string;
  lastDate?: string;
  candles: RawCandle[];
}

function readCandleFileSync(symbol: string): RawCandle[] | null {
  // 先嘗試完整 symbol 作為檔名（e.g. "2330.TW.json"）
  // 再嘗試去除交易所後綴（e.g. "2330.json"）
  const candidates = [
    path.join(CANDLE_DIR, `${symbol}.json`),
    path.join(CANDLE_DIR, `${symbol.replace(/\.(TW|TWO)$/i, '')}.json`),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data: CandleFile = JSON.parse(content);
      if (data.candles && data.candles.length > 0) return data.candles;
    } catch {
      // try next
    }
  }
  return null;
}

// ── MTF computation ────────────────────────────────────────────────────────────

interface MtfFields {
  mtfScore: number;
  mtfWeeklyTrend: string;
  mtfWeeklyPass: boolean;
  mtfWeeklyDetail: string;
  mtfMonthlyTrend: string;
  mtfMonthlyPass: boolean;
  mtfMonthlyDetail: string;
  mtfWeeklyNearResistance: boolean;
  mtfWeeklyChecks: { trend: boolean; ma: boolean; resistance: boolean } | null;
}

function computeMtfForSymbol(symbol: string, scanDate: string): MtfFields | null {
  const rawCandles = readCandleFileSync(symbol);
  if (!rawCandles || rawCandles.length < 30) return null;

  // 截取到 scanDate 為止的 K 線（不含 scanDate 之後的未來數據）
  const filtered = rawCandles.filter(c => c.date <= scanDate);
  if (filtered.length < 30) return null;

  const withIndicators = computeIndicators(filtered);
  const mtf = evaluateMultiTimeframe(withIndicators, ZHU_V1.thresholds);

  return {
    mtfScore: mtf.totalScore,
    mtfWeeklyTrend: mtf.weekly.trend,
    mtfWeeklyPass: mtf.weekly.pass,
    mtfWeeklyDetail: mtf.weekly.detail,
    mtfMonthlyTrend: mtf.monthly.trend,
    mtfMonthlyPass: mtf.monthly.pass,
    mtfMonthlyDetail: mtf.monthly.detail,
    mtfWeeklyNearResistance: mtf.weeklyNearResistance,
    mtfWeeklyChecks: mtf.weeklyChecks ?? null,
  };
}

// ── Scan file processing ──────────────────────────────────────────────────────

interface ScanResult {
  symbol: string;
  mtfScore?: number;
  [key: string]: unknown;
}

interface ScanFile {
  results: ScanResult[];
  [key: string]: unknown;
}

function extractDateFromFilename(filename: string): string | null {
  // scan-TW-long-daily-2026-03-17.json → "2026-03-17"
  const m = filename.match(/(\d{4}-\d{2}-\d{2})(?!-intraday)\.json$/);
  return m ? m[1] : null;
}

function processFile(filePath: string): void {
  const filename = path.basename(filePath);
  const scanDate = extractDateFromFilename(filename);
  if (!scanDate) return;

  let raw: ScanFile;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    console.error(`  [skip] Cannot parse: ${filename}`);
    return;
  }

  const results: ScanResult[] = raw.results || [];
  if (results.length === 0) {
    console.log(`  [skip] No results: ${filename}`);
    return;
  }

  // Check if first result already has MTF fields
  if (typeof results[0].mtfScore === 'number') {
    console.log(`  [skip] Already has MTF: ${filename}`);
    return;
  }

  console.log(`  Processing ${filename} (${results.length} stocks, date=${scanDate})`);

  let updated = 0;
  let failed = 0;

  for (const result of results) {
    try {
      const mtf = computeMtfForSymbol(result.symbol, scanDate);
      if (mtf) {
        result.mtfScore = mtf.mtfScore;
        result.mtfWeeklyTrend = mtf.mtfWeeklyTrend;
        result.mtfWeeklyPass = mtf.mtfWeeklyPass;
        result.mtfWeeklyDetail = mtf.mtfWeeklyDetail;
        result.mtfMonthlyTrend = mtf.mtfMonthlyTrend;
        result.mtfMonthlyPass = mtf.mtfMonthlyPass;
        result.mtfMonthlyDetail = mtf.mtfMonthlyDetail;
        result.mtfWeeklyNearResistance = mtf.mtfWeeklyNearResistance;
        result.mtfWeeklyChecks = mtf.mtfWeeklyChecks;
        updated++;
      } else {
        failed++;
      }
    } catch (err) {
      console.warn(`    [warn] ${result.symbol} MTF計算失敗: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');
  }

  console.log(`    -> ${updated} updated, ${failed} failed (no candle data)${dryRun ? ' [dry-run, not saved]' : ' [saved]'}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('backfill-mtf-scores: 開始補寫歷史掃描 MTF 欄位');
  if (dryRun) console.log('  [dry-run 模式：只計算，不寫檔]');
  if (filterDate) console.log(`  [只處理日期：${filterDate}]`);
  console.log('');

  if (!fs.existsSync(CANDLE_DIR)) {
    console.error(`K 線目錄不存在：${CANDLE_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(DATA_DIR)
    .filter(f => {
      if (!f.endsWith('.json')) return false;
      if (f.includes('intraday')) return false;
      if (!f.startsWith('scan-TW-long-daily-') && !f.startsWith('scan-TW-long-mtf-')) return false;
      if (filterDate && !f.includes(filterDate)) return false;
      return true;
    })
    .sort();

  console.log(`找到 ${files.length} 個符合條件的掃描檔案`);
  console.log('');

  for (const file of files) {
    processFile(path.join(DATA_DIR, file));
  }

  console.log('');
  console.log('完成');
}

main();
