/**
 * Ranking Engine — 排序引擎
 *
 * 排序因子：
 *   wH = 高勝率分數（highWinRateScore）
 *   wM = 0（MTF 只做篩選，不參與排序）
 *
 * ⚠️ MTF 量綱注意（2026-05-31）：本 optimizer 用 `mtfScore >= mtfThreshold`
 * （0~4 分制）做 MTF 過濾，**與生產選股鏈路不同量綱**。生產（applyPanelFilter /
 * scanner / backtest-run / backtest-all）一律用 `mtfWeeklyPass === true`（週線前5全過）。
 * 這裡保留 mtfScore 門檻是「刻意的超參數掃描」（MTF_THRESHOLDS=[0..4] 找最佳切點做研究），
 * 不是生產 gate。**因此 optimizer 掃出的「最佳 MTF 門檻」不可直接套用到生產**——
 * 它回答的是「若用分數門檻、哪個分數最好」，而生產的問題是「週線是否全過」。
 * 若要讓 optimizer 對齊生產，需改存/改用 weeklyPass（見 candidateCollector）。
 * 不違反鐵律 #10：#10 管的是生產選股單一事實，研究工具的超參掃描不在其內。
 */

import type { DailyCandidate, WeightCombo, RankedCandidate } from './types';

/**
 * 對單日的候選股進行排序
 */
export function rankCandidates(
  candidates:   DailyCandidate[],
  combo:        WeightCombo,
  mtfThreshold: number,
): RankedCandidate[] {
  // 1. Filter by MTF threshold
  const filtered = candidates.filter(c => c.mtfScore >= mtfThreshold);
  if (filtered.length === 0) return [];

  // 2. Per-day normalization
  const maxH = Math.max(1, ...filtered.map(c => c.highWinRateScore));

  // 3. Score, sort, assign rank
  const scored: RankedCandidate[] = filtered.map(c => ({
    ...c,
    finalScore: (c.highWinRateScore / maxH) * combo.wH,
    rank: 0,
  }));

  scored.sort((a, b) => b.finalScore - a.finalScore);
  for (let i = 0; i < scored.length; i++) {
    scored[i].rank = i + 1;
  }

  return scored;
}

// ── Predefined Weight Combos ────────────────────────────────────────────────────

/** Phase A: 單因子測試 */
export const SINGLE_FACTOR_COMBOS: WeightCombo[] = [
  { name: '純高勝率', wH: 1, wM: 0 },
];

/** Phase C: 權重網格搜索（wM 固定 0） */
export const GRID_COMBOS: WeightCombo[] = [
  { name: '1:1', wH: 1, wM: 0 },
];

/** MTF 門檻測試值 */
export const MTF_THRESHOLDS = [0, 1, 2, 3, 4];
