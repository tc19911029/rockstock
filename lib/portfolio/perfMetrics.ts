/**
 * 績效指標計算（Phase 1.2）
 *
 * 純函式：給 trades[] → 算 Sharpe / Sortino / MDD / 期望值 / 勝率 / 賠率 / 最大連敗 / CAGR
 *
 * 設計原則：
 *   - 樣本 < MIN_SAMPLE → 回 { status: 'insufficient-sample' }（避免小樣本誤導）
 *   - 所有計算用 netReturnPct（含費），不用 grossPnL（口徑與券商 app 一致）
 *   - Sharpe / Sortino 年化用「實際交易天數」推估（短線 3-10 日，全年約 30-50 筆）
 *   - MDD 由 equity curve 構造，equity_0 = 100 (normalized)
 */

import type { ClosedTrade } from '@/lib/portfolio/tradeRecorder';

export const MIN_SAMPLE = 10;

export type PerfStatus = 'ok' | 'insufficient-sample';

export interface PerfMetrics {
  status: PerfStatus;
  sampleCount: number;
  // status='ok' 時填
  winRate?: number;             // 勝率（0-1）
  payoffRatio?: number;         // 平均賺 / 平均賠（兩者均為正數）
  expectancy?: number;          // 期望值（%）= winRate × avgWin% - lossRate × |avgLoss%|
  avgWin?: number;              // 勝利交易平均報酬（%）
  avgLoss?: number;             // 失敗交易平均報酬（%，負值）
  maxConsecLosses?: number;     // 最大連續虧損次數
  sharpe?: number;              // 年化夏普值（簡化版：mean/std × sqrt(年化交易筆數)）
  sortino?: number;             // 年化索丁諾（只算下行 std）
  mdd?: number;                 // 最大回撤（%，負值）
  cagr?: number;                // 年化複利報酬（%）
  totalReturn?: number;         // 累計報酬（%）= prod(1 + r_i) - 1
  totalNetPnL?: number;         // 累計含費損益（金額）
  totalDays?: number;           // 第一筆到最後一筆天數
  tradesPerYear?: number;       // 年化交易筆數（用於 Sharpe 標準化）
}

function mean(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function downsideDev(arr: number[]): number {
  // 只計算負值的標準差（Sortino 用）
  const negatives = arr.filter(x => x < 0);
  if (negatives.length < 2) return 0;
  const m = mean(negatives);
  const variance = negatives.reduce((s, x) => s + (x - m) ** 2, 0) / (negatives.length - 1);
  return Math.sqrt(variance);
}

function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** 純函式：從 trades[] 算 metrics */
export function computeMetrics(trades: readonly ClosedTrade[]): PerfMetrics {
  if (trades.length < MIN_SAMPLE) {
    return { status: 'insufficient-sample', sampleCount: trades.length };
  }

  // 按 exitDate 排序（時序處理）
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const returns = sorted.map(t => t.netReturnPct); // 含費百分比

  const wins = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0);
  const winRate = wins.length / returns.length;
  const avgWin = wins.length > 0 ? mean(wins) : 0;
  const avgLoss = losses.length > 0 ? mean(losses) : 0;       // 負值
  const lossRate = losses.length / returns.length;
  const expectancy = winRate * avgWin + lossRate * avgLoss;   // avgLoss 已是負，加即可
  const payoffRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  // 最大連敗
  let maxConsecLosses = 0, current = 0;
  for (const r of returns) {
    if (r < 0) {
      current++;
      maxConsecLosses = Math.max(maxConsecLosses, current);
    } else {
      current = 0;
    }
  }

  // 累計報酬 + equity curve
  let equity = 100;
  const equities: number[] = [equity];
  for (const r of returns) {
    equity *= (1 + r / 100);
    equities.push(equity);
  }
  const totalReturn = (equity - 100); // %
  const totalNetPnL = sorted.reduce((s, t) => s + t.netPnL, 0);

  // MDD
  let peak = equities[0], mdd = 0;
  for (const e of equities) {
    if (e > peak) peak = e;
    const dd = (e - peak) / peak * 100;  // 負值
    if (dd < mdd) mdd = dd;
  }

  // 時序統計
  const totalDays = diffDays(sorted[0].entryDate, sorted[sorted.length - 1].exitDate);
  const years = Math.max(totalDays / 365, 1 / 365);
  const tradesPerYear = sorted.length / years;

  // Sharpe / Sortino 年化
  const m = mean(returns);
  const sd = stdDev(returns);
  const dsd = downsideDev(returns);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(tradesPerYear) : 0;
  const sortino = dsd > 0 ? (m / dsd) * Math.sqrt(tradesPerYear) : 0;

  // CAGR
  const cagr = totalDays > 0
    ? (Math.pow(equity / 100, 365 / totalDays) - 1) * 100
    : 0;

  return {
    status: 'ok',
    sampleCount: trades.length,
    winRate,
    payoffRatio,
    expectancy,
    avgWin,
    avgLoss,
    maxConsecLosses,
    sharpe,
    sortino,
    mdd,
    cagr,
    totalReturn,
    totalNetPnL,
    totalDays,
    tradesPerYear,
  };
}

/** 按字母切片：每個 triggerSignal 字母獨立算 metrics（用於月報） */
export function computeMetricsByLetter(
  trades: readonly ClosedTrade[],
): Record<string, PerfMetrics> {
  const buckets: Record<string, ClosedTrade[]> = {};
  for (const t of trades) {
    const letter = t.triggerSignal ?? 'unknown';
    (buckets[letter] ??= []).push(t);
  }
  const out: Record<string, PerfMetrics> = {};
  for (const [letter, ts] of Object.entries(buckets)) {
    out[letter] = computeMetrics(ts);
  }
  return out;
}

/** 期間切片：start ≤ exitDate ≤ end */
export function filterTradesByDateRange(
  trades: readonly ClosedTrade[],
  startDate: string,
  endDate: string,
): ClosedTrade[] {
  return trades.filter(t => t.exitDate >= startDate && t.exitDate <= endDate);
}
