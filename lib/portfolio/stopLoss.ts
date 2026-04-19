import type { Candle } from '../../types';

/**
 * 朱老師獲利方程式 S1 停損公式
 *（《活用技術分析寶典》p.54、Part 3 p.247、Part 12 p.748）
 *
 * 停損價 = max(進場 K 棒最低點, 成本 × (1 + maxLossPct))
 *
 * - 進場 K 低距離 ≤ |maxLossPct|：用進場 K 低（較保守，早出場）
 * - 進場 K 低距離 > |maxLossPct|：用固定百分比下限（避免停損太寬）
 *
 * @param costPrice    進場成本價
 * @param entryKbar    進場當日 K 棒（取 low）；若 undefined 則直接用 maxLossPct
 * @param maxLossPct   最大可接受虧損百分比（負數，預設 -0.07 即 -7%）
 *                     書本 Part 3 p.247 K 線戰法用 -7%；Part 12 p.748 主流用 -5%
 *                     此模組預設 -7% 以容納較波動的個股，呼叫端可覆寫
 * @returns            建議停損價（>0）
 */
export function calcStopLoss(
  costPrice: number,
  entryKbar: Candle | undefined,
  maxLossPct: number = -0.07,
): number {
  if (costPrice <= 0) return 0;
  const fixedFloor = costPrice * (1 + maxLossPct);
  const kbarLow = entryKbar?.low;
  if (!kbarLow || kbarLow <= 0) return fixedFloor;
  return Math.max(kbarLow, fixedFloor);
}

/**
 * 打板買進法停損：跌破漲停 K 棒最低點即出場
 * 沒有 -7% 下限——打板派不講究固定百分比，只看 K 棒結構
 */
export function calcDabanStopLoss(entryKbar: Candle | undefined): number {
  return entryKbar?.low ?? 0;
}

/**
 * 計算當前距停損還有幾個百分比
 * 正值：還沒破停損（安全）
 * 負值：已跌破停損（危險）
 */
export function stopLossDistancePct(currentPrice: number, stopLossPrice: number): number {
  if (currentPrice <= 0 || stopLossPrice <= 0) return 0;
  return ((currentPrice - stopLossPrice) / currentPrice) * 100;
}
