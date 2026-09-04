/**
 * 三色「應買排序」綜合分（2026-06-12 自 SanSeScanCompact 抽出 — 單一事實）。
 *
 * 使用者：SanSeScanCompact（掃描清單排序）、TodayTopPriorityCard（今日最優先卡）、
 * paper-trade 追蹤（每日 top pick 寫入）。回測推導的使用順序評級：
 * 嚴格全共振 > 紅當前提+觸發 > 紅+黃中線 > 紅待觸發 > 無紅；
 * 同級再比共振組數 / 短攻，有賣出警示(conflict)降級。
 */
import type { ConditionReport } from './conditions';

export function buyScore(rep?: ConditionReport): number {
  const c = rep?.combo;
  if (!c) return -1;
  let s = c.rank * 100 + (rep!.groupBuyCount ?? 0) * 10;
  if (rep!.conflict) s -= 5;
  if (c.bottomReversal) s += 1;
  const sa = rep!.scores?.shortAttack ?? 0;
  s += Math.min(Math.max(sa, 0), 99) / 100;
  return s;
}
