/**
 * 短線「成功」標準單一事實（2026-06-13，使用者拍板）
 *
 * 推薦後第 5 個交易日收盤 > +3% = 成功。績效追蹤標紅綠、階段勝率表的「成功率」都用這個。
 * 改這條規則必須升 SUCCESS_RULE_VERSION + 重跑 backfill-cn-events/rebuild snapshot + 合約測試。
 */

import type { RecoReturns } from '@/lib/backtest/eventReturns';

export const SUCCESS_RULE_VERSION = 'v1';

/** 成功 = 指定 horizon 收盤漲幅 > minPct */
export const SUCCESS_RULE = { horizon: 'd5' as const, minPct: 3 };

/** 是否達短線成功（d5 收盤 > +3%）；d5 未走完/缺值 → null（未知，不算成功也不算失敗） */
export function isShortTermSuccess(returns: RecoReturns | null): boolean | null {
  const v = returns?.[SUCCESS_RULE.horizon];
  if (v === null || v === undefined) return null;
  return v > SUCCESS_RULE.minPct;
}
