/**
 * Entry Gate 驗證 — 跑歷史 YouTube analysis 推薦，按 entry_state 分組看 forward perf
 *
 * 目的：證明（或推翻）「composite_score 高分但 entry_state=no_chase 的股票，
 * 跟 entry_state=can_enter / watch 比，forward N 日報酬有顯著差異」。
 *
 * 流程：
 *   1. 掃 data/youtube/analysis/*.json
 *   2. 對每檔 stock_scoring：
 *      - 以 analysis date 為 base 算 entry_state（candles 切到 date）
 *      - 取 base 隔交易日 open 為進場價、N 日後 close 為出場價
 *      - 算 forward return
 *   3. 按 entry_state × composite_score 分組統計
 *
 * Usage:
 *   npx tsx scripts/backtest-entry-gate.ts
 *
 * 環境變數：
 *   FROM=YYYY-MM-DD  起始 analysis date（預設讀全部）
 *   TO=YYYY-MM-DD    結束 analysis date
 *   MIN_SCORE=60     只看 ≥ N 分（預設 60）
 *   HOLD_DAYS=5      forward 持有幾日（預設 5）
 *
 * 輸出：console table + data/agents/backtest/entry-gate-validation.json
 */

import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeEntryState, type EntryState } from '@/lib/agents/entryGate';

const ANALYSIS_DIR = path.join(process.cwd(), 'data', 'youtube', 'analysis');
const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const OUT_PATH = path.join(process.cwd(), 'data', 'agents', 'backtest', 'entry-gate-validation.json');

const FROM = process.env.FROM ?? '';
const TO = process.env.TO ?? '';
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 60);
const HOLD_DAYS = Number(process.env.HOLD_DAYS ?? 5);

interface StockScoringEntry {
  stock_code: string;
  stock_name?: string;
  composite_score?: number;
  rating?: string;
}

interface AnalysisFile {
  stock_scoring?: StockScoringEntry[];
}

interface CandleFile {
  candles: Candle[];
}

interface Sample {
  date: string;
  code: string;
  name: string;
  score: number;
  rating: string;
  state: EntryState;
  reasons: string[];
  buyOpen: number | null;
  exitClose: number | null;
  return1: number | null;
  return3: number | null;
  return5: number | null;
}

function loadCandles(code: string): Candle[] | null {
  for (const suffix of ['.TW', '.TWO']) {
    const p = path.join(CANDLE_DIR, `${code}${suffix}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const f = JSON.parse(fs.readFileSync(p, 'utf8')) as CandleFile;
      if (f.candles?.length > 0) return f.candles;
    } catch { /* ignore */ }
  }
  return null;
}

function pct(prev: number, curr: number): number {
  return ((curr - prev) / prev) * 100;
}

function analyseFile(date: string, file: AnalysisFile): Sample[] {
  const out: Sample[] = [];
  for (const s of file.stock_scoring ?? []) {
    if (!s.stock_code) continue;
    const score = s.composite_score ?? 0;
    if (score < MIN_SCORE) continue;
    const candles = loadCandles(s.stock_code);
    if (!candles) continue;
    const baseIdx = candles.findIndex(c => c.date === date);
    if (baseIdx < 0) continue;
    const asOf = candles.slice(0, baseIdx + 1);
    if (asOf.length < 2) continue;
    const gate = computeEntryState({ symbol: s.stock_code, candles: asOf });
    const next = candles[baseIdx + 1];
    const d3 = candles[baseIdx + 3];
    const d5 = candles[baseIdx + 5];
    const dHold = candles[baseIdx + HOLD_DAYS];
    out.push({
      date,
      code: s.stock_code,
      name: s.stock_name ?? '',
      score,
      rating: s.rating ?? '',
      state: gate.state,
      reasons: gate.reasons,
      buyOpen: next?.open ?? null,
      exitClose: dHold?.close ?? null,
      return1: next ? pct(candles[baseIdx].close, next.close) : null,
      return3: d3 ? pct(candles[baseIdx].close, d3.close) : null,
      return5: d5 ? pct(candles[baseIdx].close, d5.close) : null,
    });
  }
  return out;
}

interface GroupStat {
  state: EntryState | 'overall';
  count: number;
  withForward: number;
  winRate1: number;
  winRate3: number;
  winRate5: number;
  avgR1: number;
  avgR3: number;
  avgR5: number;
  medianR5: number;
}

function summarise(samples: Sample[], filterState?: EntryState): GroupStat {
  const xs = filterState ? samples.filter(s => s.state === filterState) : samples;
  const withR1 = xs.filter(s => s.return1 != null);
  const withR3 = xs.filter(s => s.return3 != null);
  const withR5 = xs.filter(s => s.return5 != null);
  const avg = (arr: number[]) => arr.length === 0 ? NaN : arr.reduce((a, b) => a + b, 0) / arr.length;
  const median = (arr: number[]) => {
    if (arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  };
  const r1 = withR1.map(s => s.return1!);
  const r3 = withR3.map(s => s.return3!);
  const r5 = withR5.map(s => s.return5!);
  return {
    state: filterState ?? 'overall',
    count: xs.length,
    withForward: withR5.length,
    winRate1: r1.length === 0 ? NaN : r1.filter(v => v > 0).length / r1.length * 100,
    winRate3: r3.length === 0 ? NaN : r3.filter(v => v > 0).length / r3.length * 100,
    winRate5: r5.length === 0 ? NaN : r5.filter(v => v > 0).length / r5.length * 100,
    avgR1: avg(r1),
    avgR3: avg(r3),
    avgR5: avg(r5),
    medianR5: median(r5),
  };
}

function fmtRow(s: GroupStat): string {
  const f = (n: number) => isNaN(n) ? '   —  ' : `${n >= 0 ? '+' : ''}${n.toFixed(2).padStart(6)}`;
  const p = (n: number) => isNaN(n) ? ' — ' : `${n.toFixed(1).padStart(5)}%`;
  return `${s.state.padEnd(10)} | n=${String(s.count).padStart(3)} (有 ${s.withForward.toString().padStart(3)} 筆 5 日 forward) | 勝率 1/3/5 日: ${p(s.winRate1)}/${p(s.winRate3)}/${p(s.winRate5)} | 平均 R 1/3/5: ${f(s.avgR1)}/${f(s.avgR3)}/${f(s.avgR5)}% | 中位 R5: ${f(s.medianR5)}%`;
}

function main() {
  const files = fs.readdirSync(ANALYSIS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .filter(d => (!FROM || d >= FROM) && (!TO || d <= TO))
    .sort();

  if (files.length === 0) {
    console.error('No analysis files in range');
    process.exit(1);
  }

  console.log(`\n📊 Entry-Gate Backtest`);
  console.log(`   Range: ${files[0]} → ${files[files.length - 1]} (${files.length} 天)`);
  console.log(`   MIN_SCORE=${MIN_SCORE}, HOLD_DAYS=${HOLD_DAYS}\n`);

  const all: Sample[] = [];
  for (const date of files) {
    const p = path.join(ANALYSIS_DIR, `${date}.json`);
    const af = JSON.parse(fs.readFileSync(p, 'utf8')) as AnalysisFile;
    const samples = analyseFile(date, af);
    all.push(...samples);
    console.log(`  ${date}: ${af.stock_scoring?.length ?? 0} 檔 scoring → ${samples.length} 入樣本 (≥${MIN_SCORE} 分 + 有 K 線)`);
  }

  console.log(`\n總樣本：${all.length} 筆`);
  console.log(`\n--- 按 entry_state 分組 ---`);
  const overall = summarise(all);
  const noChase = summarise(all, 'no_chase');
  const watch = summarise(all, 'watch');
  const canEnter = summarise(all, 'can_enter');
  console.log(fmtRow(overall));
  console.log(fmtRow(noChase));
  console.log(fmtRow(watch));
  console.log(fmtRow(canEnter));

  console.log(`\n--- 按 rating × entry_state ---`);
  for (const rating of ['A', 'B', 'C']) {
    const xs = all.filter(s => s.rating === rating);
    if (xs.length === 0) continue;
    console.log(`\nRating ${rating} (n=${xs.length})`);
    console.log(`  ${fmtRow(summarise(xs))}`);
    for (const st of ['no_chase', 'watch', 'can_enter'] as EntryState[]) {
      const sub = summarise(xs, st);
      if (sub.count > 0) console.log(`    ${fmtRow(sub)}`);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    range: { from: files[0], to: files[files.length - 1], days: files.length },
    config: { minScore: MIN_SCORE, holdDays: HOLD_DAYS },
    summary: {
      overall, noChase, watch, canEnter,
    },
    samples: all,
  }, null, 2));
  console.log(`\n✅ Wrote ${OUT_PATH}\n`);
}

main();
