/**
 * Metrics Calculator — 績效指標計算器
 *
 * 計算核心指標（勝率、報酬、風險比）+ 排序品質指標（Spearman、Top-1優勢）
 */

import type {
  DailyCandidate,
  StrategyMetrics,
  YearMetrics,
  WeightCombo,
} from './types';
import { rankCandidates } from './rankingEngine';

// ── Core Metrics ────────────────────────────────────────────────────────────────

/**
 * 從一組交易報酬計算完整績效指標
 */
export function calcMetricsFromReturns(
  returns:         number[],
  holdDaysList:    number[],
  exitReasons:     string[],
  noCandidateDays: number,
): StrategyMetrics {
  const n = returns.length;

  if (n === 0) {
    return emptyMetrics(noCandidateDays);
  }

  const totalReturn = returns.reduce((a, b) => a + b, 0);
  const avgReturn   = totalReturn / n;

  const wins   = returns.filter(r => r > 0);
  const losses = returns.filter(r => r <= 0);
  const winRate = (wins.length / n) * 100;

  const avgWin  = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  const totalWinAmt  = wins.reduce((a, b) => a + b, 0);
  const totalLossAmt = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = totalLossAmt > 0 ? totalWinAmt / totalLossAmt : 999;

  // Compound return
  let equity = 1;
  for (const r of returns) equity *= (1 + r / 100);
  const compoundReturn = (equity - 1) * 100;

  // Annualized (assume ~250 trading days/year)
  const tradingDaysUsed = n; // each trade = 1 signal day
  const annualReturn = tradingDaysUsed > 0
    ? (Math.pow(equity, 250 / tradingDaysUsed) - 1) * 100
    : 0;

  // Max drawdown (equity curve)
  let eqCurve = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of returns) {
    eqCurve += r;
    if (eqCurve > peak) peak = eqCurve;
    const dd = eqCurve - peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe Ratio
  let sharpeRatio: number | null = null;
  if (n >= 2) {
    const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? +(avgReturn / std * Math.sqrt(250)).toFixed(3) : null;
  }

  // Sortino Ratio (downside deviation)
  let sortinoRatio: number | null = null;
  if (n >= 2) {
    const downsideReturns = returns.filter(r => r < 0);
    if (downsideReturns.length > 0) {
      const downsideVar = downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length;
      const downsideDev = Math.sqrt(downsideVar);
      sortinoRatio = downsideDev > 0 ? +(avgReturn / downsideDev * Math.sqrt(250)).toFixed(3) : null;
    }
  }

  // Average hold days
  const avgHoldDays = holdDaysList.length > 0
    ? holdDaysList.reduce((a, b) => a + b, 0) / holdDaysList.length
    : 0;

  // Exit reason distribution
  const exitReasonDist: Record<string, number> = {};
  for (const r of exitReasons) {
    exitReasonDist[r] = (exitReasonDist[r] || 0) + 1;
  }

  // By year
  const byYear: Record<string, YearMetrics> = {};
  // (byYear is filled externally via calcByYear)

  return {
    tradeCount: n,
    noCandidateDays,
    avgReturn:   +avgReturn.toFixed(3),
    totalReturn: +totalReturn.toFixed(3),
    compoundReturn: +compoundReturn.toFixed(3),
    annualReturn: +annualReturn.toFixed(1),
    winRate:     +winRate.toFixed(1),
    maxDrawdown: +maxDrawdown.toFixed(3),
    avgWin:      +avgWin.toFixed(3),
    avgLoss:     +avgLoss.toFixed(3),
    profitFactor: +profitFactor.toFixed(3),
    sharpeRatio,
    sortinoRatio,
    avgHoldDays: +avgHoldDays.toFixed(1),
    top1BeatsTop2Pct: 0,
    top1BeatsTop3Pct: 0,
    top1BestInTop5Pct: 0,
    rankReturnSpearman: null,
    byYear,
    exitReasonDist,
  };
}

function emptyMetrics(noCandidateDays: number): StrategyMetrics {
  return {
    tradeCount: 0, noCandidateDays,
    avgReturn: 0, totalReturn: 0, compoundReturn: 0, annualReturn: 0,
    winRate: 0, maxDrawdown: 0,
    avgWin: 0, avgLoss: 0, profitFactor: 0,
    sharpeRatio: null, sortinoRatio: null, avgHoldDays: 0,
    top1BeatsTop2Pct: 0, top1BeatsTop3Pct: 0, top1BestInTop5Pct: 0,
    rankReturnSpearman: null,
    byYear: {}, exitReasonDist: {},
  };
}

// ── Top-1 Strategy Metrics ──────────────────────────────────────────────────────

/**
 * 計算 Top-1 策略的完整指標（含排序品質指標）
 *
 * @param dailyCandidates 全部候選股 Map
 * @param days            要計算的交易日列表
 * @param combo           權重組合
 * @param mtfThreshold    MTF 門檻
 * @param topN            取前 N 名（通常=1）
 */
export function calcTop1Metrics(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
  combo:           WeightCombo,
  mtfThreshold:    number,
  topN = 1,
): StrategyMetrics {
  const returns:      number[] = [];
  const holdDaysList: number[] = [];
  const exitReasons:  string[] = [];
  let noCandidateDays = 0;

  // For Top-1 quality metrics
  let top1BeatsTop2 = 0;
  let top1BeatsTop3 = 0;
  let top1BestInTop5 = 0;
  let comparableDaysTop2 = 0;
  let comparableDaysTop3 = 0;
  let comparableDaysTop5 = 0;
  const spearmanValues: number[] = [];

  // For by-year
  const yearReturns: Record<string, number[]> = {};

  // 真實資金流模擬：持有中就跳過，賣掉後才能買下一檔
  let holdingUntilIdx = -1; // days 陣列中的索引，持有到此索引為止

  for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
    const date = days[dayIdx];
    const candidates = dailyCandidates.get(date);
    if (!candidates || candidates.length === 0) {
      noCandidateDays++;
      continue;
    }

    const ranked = rankCandidates(candidates, combo, mtfThreshold);
    if (ranked.length === 0) {
      noCandidateDays++;
      continue;
    }

    // 還在持有中 → 跳過（只做排序品質統計，不進場）
    const isHolding = dayIdx <= holdingUntilIdx;

    if (!isHolding) {
      // Top-N picks（真實資金流：只買第 1 名）
      const picks = ranked.slice(0, topN);
      for (const pick of picks) {
        if (!pick.tradeResult) continue;
        returns.push(pick.tradeResult.netReturn);
        holdDaysList.push(pick.tradeResult.holdDays);
        exitReasons.push(pick.tradeResult.exitReason);

        // 標記持有期間（持有 N 天 = 跳過後面 N-1 個交易日）
        // +1 因為進場當天也算（收盤買入，隔天開始算持有）
        holdingUntilIdx = dayIdx + pick.tradeResult.holdDays;

        const year = date.slice(0, 4);
        if (!yearReturns[year]) yearReturns[year] = [];
        yearReturns[year].push(pick.tradeResult.netReturn);
      }
    }

    // Top-1 quality analysis (only when topN=1) — 不管有沒有持有都統計
    if (topN === 1 && ranked.length >= 2) {
      const r1 = ranked[0].tradeResult?.netReturn;
      const r2 = ranked[1].tradeResult?.netReturn;
      if (r1 != null && r2 != null) {
        comparableDaysTop2++;
        if (r1 > r2) top1BeatsTop2++;
      }

      if (ranked.length >= 3) {
        const r3 = ranked[2].tradeResult?.netReturn;
        if (r1 != null && r3 != null) {
          comparableDaysTop3++;
          if (r1 > r3) top1BeatsTop3++;
        }
      }

      if (ranked.length >= 5 && r1 != null) {
        const top5Returns = ranked.slice(0, 5)
          .map(c => c.tradeResult?.netReturn)
          .filter((r): r is number => r != null);
        if (top5Returns.length >= 5) {
          comparableDaysTop5++;
          if (r1 >= Math.max(...top5Returns)) top1BestInTop5++;
        }
      }

      // Spearman rank correlation (rank vs netReturn)
      if (ranked.length >= 3) {
        const withReturns = ranked
          .filter(c => c.tradeResult != null)
          .slice(0, 10); // limit to top 10 for efficiency

        if (withReturns.length >= 3) {
          const rho = spearmanCorrelation(
            withReturns.map(c => c.rank),
            withReturns.map(c => c.tradeResult!.netReturn),
          );
          if (rho != null) spearmanValues.push(rho);
        }
      }
    }
  }

  const metrics = calcMetricsFromReturns(returns, holdDaysList, exitReasons, noCandidateDays);

  // Fill Top-1 quality metrics
  metrics.top1BeatsTop2Pct = comparableDaysTop2 > 0
    ? +((top1BeatsTop2 / comparableDaysTop2) * 100).toFixed(1) : 0;
  metrics.top1BeatsTop3Pct = comparableDaysTop3 > 0
    ? +((top1BeatsTop3 / comparableDaysTop3) * 100).toFixed(1) : 0;
  metrics.top1BestInTop5Pct = comparableDaysTop5 > 0
    ? +((top1BestInTop5 / comparableDaysTop5) * 100).toFixed(1) : 0;
  metrics.rankReturnSpearman = spearmanValues.length > 0
    ? +(spearmanValues.reduce((a, b) => a + b, 0) / spearmanValues.length).toFixed(3)
    : null;

  // Fill by-year
  for (const [year, rets] of Object.entries(yearReturns)) {
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const wr = (rets.filter(r => r > 0).length / rets.length) * 100;
    metrics.byYear[year] = {
      avgReturn: +avg.toFixed(3),
      winRate: +wr.toFixed(1),
      count: rets.length,
    };
  }

  return metrics;
}

// ── Spearman Rank Correlation ───────────────────────────────────────────────────

/**
 * 計算 Spearman 等級相關係數
 * 排名越前(小) vs 報酬越高(大) → 預期為負相關
 * 回傳負值表示排名有效（前面的報酬較高）
 */
function spearmanCorrelation(ranks: number[], values: number[]): number | null {
  const n = ranks.length;
  if (n < 3) return null;

  // Convert values to ranks (descending: highest value = rank 1)
  const valueRanks = toRanks(values, true);
  const rankRanks  = toRanks(ranks, false); // ascending: smallest rank = rank 1

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rankRanks[i] - valueRanks[i];
    sumD2 += d * d;
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

/**
 * 將數值轉為等級排名
 * @param descending true = 最大值排名1
 */
function toRanks(values: number[], descending: boolean): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => descending ? b.v - a.v : a.v - b.v);

  const ranks = new Array(values.length);
  for (let r = 0; r < indexed.length; r++) {
    ranks[indexed[r].i] = r + 1;
  }
  return ranks;
}

// ── Average Candidate Count ─────────────────────────────────────────────────────

/**
 * 計算指定門檻下每日平均候選股數量
 */
export function avgCandidateCount(
  dailyCandidates: Map<string, DailyCandidate[]>,
  days:            string[],
  mtfThreshold:    number,
): number {
  let total = 0;
  let count = 0;
  for (const date of days) {
    const candidates = dailyCandidates.get(date);
    if (!candidates) continue;
    total += candidates.filter(c => c.mtfScore >= mtfThreshold).length;
    count++;
  }
  return count > 0 ? +(total / count).toFixed(1) : 0;
}
