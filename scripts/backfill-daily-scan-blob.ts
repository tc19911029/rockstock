/**
 * Backfill daily scan blob — 補長期 scan-{market}-long-daily-{date}.json
 *
 * 為什麼：production scan blob 只有 2026-04-22 起的 ~22 天，paperTradeSimulator
 * 跟 walk-forward 需要長期樣本。本 driver 對歷史每個交易日重跑 v12 evaluator + v11
 * legacy detector，輸出與 production 對齊的 scan blob，讓 paper sim 可以放心讀。
 *
 * 流程（每日）：
 *   1. 對所有股票 candles 算 indicators
 *   2. 算當日全市場 20 日均成交額排名（top 500 才收 — 對齊 ScanPipeline.topNTurnover）
 *   3. 對每檔跑 evaluateSixConditions（要 coreScore ≥ 5 = 必要條件全過）
 *   4. 對每檔跑 evaluateStockV12（拿 J/K/L/M/N/O/P/Q）+ v11 legacy detector（B/C/D/E/F）
 *   5. 沒命中任何字母 → 跳過
 *   6. 過 Step 1 + 有 matchedMethods → 寫成 StockScanResult
 *   7. 每日一個檔 data/scan-{market}-long-daily-{date}.json
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=8192" \
 *     FROM=2024-01-01 TO=2026-04-21 MARKET=TW \
 *     npx tsx scripts/backfill-daily-scan-blob.ts
 *
 * 旗標：
 *   FROM, TO       日期範圍（含），YYYY-MM-DD
 *   MARKET         TW 或 CN（預設 TW）
 *   OVERWRITE      true 才覆寫既有檔（預設 false — 只補缺）
 *   LOG_EVERY      log 進度間隔，預設 10 天
 *   TOP_TURNOVER   過濾門檻，預設 500（對齊 ScanPipeline）
 *   MIN_SIX_SCORE  六條件最低分（預設 5）
 *
 * 不可覆蓋既有 2026-04-22 之後的 production scan blob — 預設 OVERWRITE=false。
 */

import fs from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { evaluateStockV12 } from '@/lib/scanner/v12StockEvaluator';
import { detectBreakoutEntry, detectConsolidationBreakout } from '@/lib/analysis/breakoutEntry';
import { detectStrategyE } from '@/lib/analysis/highWinRateEntry';
import { detectStrategyD } from '@/lib/analysis/gapEntry';
import { detectVReversal } from '@/lib/analysis/vReversalDetector';
import type { CandleWithIndicators } from '@/types';
import type { StockScanResult, MarketId } from '@/lib/scanner/types';
import type { V12Letter } from '@/lib/analysis/v12Signals';

// ════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════

const FROM         = process.env.FROM ?? '2024-01-01';
const TO           = process.env.TO   ?? '2026-04-21';
const MARKET       = (process.env.MARKET as MarketId) ?? 'TW';
const OVERWRITE    = process.env.OVERWRITE === 'true';
const LOG_EVERY    = Number(process.env.LOG_EVERY ?? 10);
const TOP_TURNOVER = Number(process.env.TOP_TURNOVER ?? 500);
const MIN_SIX_SCORE = Number(process.env.MIN_SIX_SCORE ?? 5);

const ROOT        = process.cwd();
const DATA_ROOT   = path.join(ROOT, 'data');
const CANDLE_ROOT = path.join(DATA_ROOT, 'candles', MARKET);

// ════════════════════════════════════════════════════════════════
// 載入股票名稱（從最新 intraday snapshot 拿）
// ════════════════════════════════════════════════════════════════

function loadNameMap(market: MarketId): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(`^intraday-${market}-\\d{4}-\\d{2}-\\d{2}\\.json$`);
  let files: string[] = [];
  try {
    files = fs.readdirSync(DATA_ROOT)
      .filter(f => re.test(f))
      .sort();
  } catch { /* ignore */ }
  if (!files.length) return map;
  // 從新到舊掃，補齊 name（新的覆蓋不掉舊的，因為一個 symbol 只設一次）
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, files[i]), 'utf8'));
      const quotes: Array<{ symbol?: string; name?: string }> = raw.quotes ?? [];
      for (const q of quotes) {
        if (!q.symbol || !q.name) continue;
        // intraday 是裸 symbol（如 "1537"），candle 檔是 "1537.TW"
        const fullSymbol = market === 'TW'
          ? (q.symbol.includes('.') ? q.symbol : `${q.symbol}.TW`)
          : q.symbol;
        if (!map.has(fullSymbol)) map.set(fullSymbol, q.name);
      }
    } catch { /* ignore */ }
  }
  return map;
}

// ════════════════════════════════════════════════════════════════
// 載入 candles + 算 indicators
// ════════════════════════════════════════════════════════════════

interface StockData {
  symbol: string;
  name: string;
  market: MarketId;
  candles: CandleWithIndicators[];
  dateToIdx: Map<string, number>;
}

function isIndexSymbol(s: string): boolean {
  return s.startsWith('^') || s === '000001.SS' || s === '000001.SZ' || s === '000300.SS';
}

function loadAllStocks(market: MarketId, nameMap: Map<string, string>): StockData[] {
  if (!fs.existsSync(CANDLE_ROOT)) {
    console.error(`  candles 目錄不存在：${CANDLE_ROOT}`);
    return [];
  }
  const files = fs.readdirSync(CANDLE_ROOT).filter(f => f.endsWith('.json'));
  const list: StockData[] = [];
  let loaded = 0, skipped = 0, skipShort = 0;
  process.stdout.write(`  讀 ${market} L1 + 算 indicators`);
  for (const f of files) {
    const symbol = f.replace('.json', '');
    if (isIndexSymbol(symbol)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CANDLE_ROOT, f), 'utf8'));
      const rawCandles = Array.isArray(raw) ? raw : (raw.candles ?? []);
      const candles: CandleWithIndicators[] = rawCandles
        .map((c: { date?: string; open?: number; high?: number; low?: number; close?: number; volume?: number }) => ({
          date:   (c.date ?? '').slice(0, 10),
          open:   Number(c.open)   || 0,
          high:   Number(c.high)   || 0,
          low:    Number(c.low)    || 0,
          close:  Number(c.close)  || 0,
          volume: Number(c.volume) || 0,
        } as CandleWithIndicators))
        .filter((c: CandleWithIndicators) => c.date && c.close > 0)
        .sort((a: CandleWithIndicators, b: CandleWithIndicators) => a.date.localeCompare(b.date));
      if (candles.length < 60) { skipShort++; continue; }
      const withIndicators = computeIndicators(candles);
      const dateToIdx = new Map<string, number>();
      withIndicators.forEach((c, i) => dateToIdx.set(c.date.slice(0, 10), i));
      const name = nameMap.get(symbol) ?? symbol;
      // 排除 ST 股
      if (name.includes('ST')) { skipped++; continue; }
      list.push({ symbol, name, market, candles: withIndicators, dateToIdx });
      loaded++;
      if (loaded % 200 === 0) process.stdout.write('.');
    } catch { skipped++; }
  }
  console.log(` → ${loaded} 支（短 ${skipShort} 跳過、其他 skip ${skipped}）`);
  return list;
}

function loadIndexCandles(market: MarketId): CandleWithIndicators[] {
  const symbol = market === 'TW' ? '^TWII' : '000001.SS';
  const file = path.join(CANDLE_ROOT, `${symbol}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`  ⚠️ 指數檔不存在：${file}（v12 evaluator 會把所有股票 fail Step 0）`);
    return [];
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawCandles = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const candles: CandleWithIndicators[] = rawCandles
      .map((c: { date?: string; open?: number; high?: number; low?: number; close?: number; volume?: number }) => ({
        date:   (c.date ?? '').slice(0, 10),
        open:   Number(c.open)   || 0,
        high:   Number(c.high)   || 0,
        low:    Number(c.low)    || 0,
        close:  Number(c.close)  || 0,
        volume: Number(c.volume) || 0,
      } as CandleWithIndicators))
      .filter((c: CandleWithIndicators) => c.date && c.close > 0)
      .sort((a: CandleWithIndicators, b: CandleWithIndicators) => a.date.localeCompare(b.date));
    return computeIndicators(candles);
  } catch (e) {
    console.warn(`  ⚠️ 指數檔讀取失敗：${e}`);
    return [];
  }
}

// ════════════════════════════════════════════════════════════════
// 全市場 20 日均成交額排名
// ════════════════════════════════════════════════════════════════

function turnoverRankForDay(stocks: StockData[], date: string, lookback = 20): Map<string, number> {
  const list: { symbol: string; avgTurnover: number }[] = [];
  for (const s of stocks) {
    const idx = s.dateToIdx.get(date);
    if (idx == null || idx < lookback - 1) continue;
    let sum = 0;
    let n = 0;
    for (let i = idx - lookback + 1; i <= idx; i++) {
      const c = s.candles[i];
      if (!c) continue;
      sum += c.close * c.volume;
      n++;
    }
    if (n === 0) continue;
    list.push({ symbol: s.symbol, avgTurnover: sum / n });
  }
  list.sort((a, b) => b.avgTurnover - a.avgTurnover);
  const rank = new Map<string, number>();
  list.forEach((x, i) => rank.set(x.symbol, i + 1));
  return rank;
}

// ════════════════════════════════════════════════════════════════
// 一天一個 evaluator pass
// ════════════════════════════════════════════════════════════════

interface EvalStats {
  totalCandidates: number;
  passedTurnover:  number;
  passedSixCore:   number;
  hadAnyLetter:    number;
  errors:          number;
}

function evaluateDay(
  date: string,
  stocks: StockData[],
  indexCandles: CandleWithIndicators[],
  indexDateToIdx: Map<string, number>,
): { results: StockScanResult[]; stats: EvalStats } {
  const stats: EvalStats = {
    totalCandidates: 0, passedTurnover: 0, passedSixCore: 0, hadAnyLetter: 0, errors: 0,
  };

  const idxIdx = indexDateToIdx.get(date);
  if (idxIdx == null) return { results: [], stats };
  const indexSlice = indexCandles.slice(0, idxIdx + 1);

  const turnoverRank = turnoverRankForDay(stocks, date);
  const scanTime = `${date}T16:00:00+08:00`;
  const results: StockScanResult[] = [];

  for (const s of stocks) {
    const idx = s.dateToIdx.get(date);
    if (idx == null || idx < 60) continue;
    stats.totalCandidates++;

    const rank = turnoverRank.get(s.symbol);
    if (rank == null || rank > TOP_TURNOVER) continue;
    stats.passedTurnover++;

    try {
      // ── Step 1：六條件（必要 1~5 全過 = coreScore ≥ 5）─────────────
      const sixConds = evaluateSixConditions(s.candles, idx);
      if (sixConds.coreScore < MIN_SIX_SCORE) continue;
      stats.passedSixCore++;

      // ── matchedMethods：v12 evaluator + v11 legacy ───────────────
      const matchedMethods: string[] = ['A']; // A = 六條件預選池
      try {
        const v12 = evaluateStockV12({
          symbol: s.symbol,
          name:   s.name,
          market: s.market,
          candles: s.candles,
          indexCandles: indexSlice,
          index: idx,
        });
        for (const sig of v12.signals) {
          if (sig.triggered) matchedMethods.push(sig.letter as V12Letter);
        }
      } catch { /* skip — v12 evaluator 對個股失敗不 abort */ }

      // v11 legacy detector（v12 evaluator 不跑 B/C/D/E/F）
      const isLongTrend = sixConds.trend.pass;
      try { if (isLongTrend && detectBreakoutEntry(s.candles, idx)) matchedMethods.push('B'); } catch { /**/ }
      try { if (isLongTrend && detectConsolidationBreakout(s.candles, idx)) matchedMethods.push('C'); } catch { /**/ }
      try { if (detectStrategyE(s.candles, idx)) matchedMethods.push('D'); } catch { /**/ }
      try { if (isLongTrend && detectStrategyD(s.candles, idx)) matchedMethods.push('E'); } catch { /**/ }
      try { if (detectVReversal(s.candles, idx)) matchedMethods.push('F'); } catch { /**/ }

      // de-dup
      const uniqueMethods = [...new Set(matchedMethods)];

      // 至少要有一個非 A 的字母，paperTradeSimulator 才會收（selectTier1 要命中 A 級字母）
      if (uniqueMethods.length <= 1) continue;
      stats.hadAnyLetter++;

      // ── 其他欄位 ───────────────────────────────────────────────
      const c = s.candles[idx];
      const prev = idx > 0 ? s.candles[idx - 1] : null;
      const changePercent = prev && prev.close > 0
        ? +((c.close - prev.close) / prev.close * 100).toFixed(2)
        : 0;
      const trendState = detectTrend(s.candles, idx);
      const trendPosition = detectTrendPosition(s.candles, idx);

      results.push({
        symbol:        s.symbol,
        name:          s.name,
        market:        s.market,
        // industry undefined — 不影響 paper sim
        price:         c.close,
        changePercent,
        volume:        c.volume,
        triggeredRules: [], // 補進場理由空陣列 — paper sim 沒用到
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState,
        trendPosition,
        scanTime,
        matchedMethods: uniqueMethods,
        turnoverRank: rank,
        // schema version
        schemaVersion: 'v12',
      });
    } catch {
      stats.errors++;
    }
  }

  return { results, stats };
}

// ════════════════════════════════════════════════════════════════
// 寫檔（不覆寫既有，除非 OVERWRITE=true）
// ════════════════════════════════════════════════════════════════

function writeScanBlob(market: MarketId, date: string, results: StockScanResult[]): 'wrote' | 'skipped' {
  const file = path.join(DATA_ROOT, `scan-${market}-long-daily-${date}.json`);
  if (fs.existsSync(file) && !OVERWRITE) return 'skipped';
  const blob = {
    id: `${market}-long-daily-${date}-backfill-${Date.now()}`,
    market,
    date,
    direction: 'long',
    multiTimeframeEnabled: false,
    sessionType: 'post_close',
    scanTime: `${date}T16:00:00+08:00`,
    resultCount: results.length,
    results,
    step1Filter: 'applied',
    backfillSource: 'scripts/backfill-daily-scan-blob.ts',
  };
  fs.writeFileSync(file, JSON.stringify(blob));
  return 'wrote';
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════

function main(): void {
  const t0 = Date.now();
  console.log('\n  ═══ Backfill Daily Scan Blob ═══');
  console.log(`  期間：${FROM} → ${TO}`);
  console.log(`  市場：${MARKET}`);
  console.log(`  TOP_TURNOVER=${TOP_TURNOVER}  MIN_SIX_SCORE=${MIN_SIX_SCORE}  OVERWRITE=${OVERWRITE}`);
  console.log('');

  const nameMap = loadNameMap(MARKET);
  console.log(`  載入 name map：${nameMap.size} 筆`);

  const stocks = loadAllStocks(MARKET, nameMap);
  if (!stocks.length) {
    console.error('  ✗ 無 candles 可用');
    process.exit(1);
  }

  console.log(`  載入大盤指數...`);
  const indexCandles = loadIndexCandles(MARKET);
  const indexDateToIdx = new Map<string, number>();
  indexCandles.forEach((c, i) => indexDateToIdx.set(c.date.slice(0, 10), i));
  console.log(`    指數 ${indexCandles.length} 根`);

  // 收集所有需要處理的交易日（從 stocks union 取，過濾在範圍內）
  const dateSet = new Set<string>();
  for (const s of stocks) {
    for (const c of s.candles) {
      const d = c.date.slice(0, 10);
      if (d >= FROM && d <= TO) dateSet.add(d);
    }
  }
  const dates = [...dateSet].sort();
  console.log(`  期間交易日：${dates.length} 天 (${dates[0] ?? '-'} → ${dates.at(-1) ?? '-'})`);
  console.log('');

  let wrote = 0, skipped = 0, empty = 0;
  let totalResults = 0;
  const startProc = Date.now();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const file = path.join(DATA_ROOT, `scan-${MARKET}-long-daily-${date}.json`);
    if (fs.existsSync(file) && !OVERWRITE) {
      skipped++;
      if ((i + 1) % LOG_EVERY === 0) {
        process.stdout.write(`    [${i + 1}/${dates.length}] ${date} skip（已存在）\n`);
      }
      continue;
    }

    const { results, stats } = evaluateDay(date, stocks, indexCandles, indexDateToIdx);
    const action = writeScanBlob(MARKET, date, results);
    if (action === 'wrote') {
      wrote++;
      totalResults += results.length;
      if (results.length === 0) empty++;
    }

    if ((i + 1) % LOG_EVERY === 0 || i === dates.length - 1) {
      const elapsed = ((Date.now() - startProc) / 1000).toFixed(1);
      const perDay  = ((Date.now() - startProc) / (i + 1)).toFixed(0);
      console.log(
        `    [${i + 1}/${dates.length}] ${date}  results=${results.length}  ` +
        `（pool=${stats.passedTurnover} six=${stats.passedSixCore} letter=${stats.hadAnyLetter} err=${stats.errors}）` +
        `  elapsed=${elapsed}s  ${perDay}ms/day`
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log('  ═══ 完成 ═══');
  console.log(`  新寫 ${wrote} 個檔（其中空 results 的 ${empty} 個），跳過既有 ${skipped} 個`);
  console.log(`  總共 ${totalResults} 筆 result 寫入，平均 ${(wrote ? totalResults / wrote : 0).toFixed(1)} 筆/天`);
  console.log(`  耗時 ${elapsed} 秒`);
  console.log('');
}

main();
