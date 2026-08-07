import { TRUE_BREAKOUT_PCT } from '@/lib/analysis/bookThresholds';

export type PatternLifecycleStatus = 'pending' | 'success' | 'retest' | 'failed' | 'target';

interface PatternLifecycleInput {
  kind: 'bottom' | 'top';
  currentClose: number;
  necklinePrice: number;
  targetPrice: number;
  stopPrice: number;
  closesSinceFormation: readonly number[];
  /** 鎖定紀錄只會在觸發後建立，因此可視為已完成突破／跌破確認。 */
  assumeConfirmed?: boolean;
}

/**
 * 依「形成 → 確認 → 回測／失效」順序判定型態狀態。
 *
 * 關鍵限制：尚未曾通過 3% 真突破門檻的底部型態，即使現價低於
 * 頸線回測防守價，也只能算「待突破」，不能倒果為因標成「結構失效」。
 */
export function getPatternLifecycleStatus({
  kind,
  currentClose,
  necklinePrice,
  targetPrice,
  stopPrice,
  closesSinceFormation,
  assumeConfirmed = false,
}: PatternLifecycleInput): PatternLifecycleStatus {
  const confirmationPrice = kind === 'bottom'
    ? necklinePrice * (1 + TRUE_BREAKOUT_PCT)
    : necklinePrice * (1 - TRUE_BREAKOUT_PCT);
  const wasConfirmed = assumeConfirmed || closesSinceFormation.some(close =>
    kind === 'bottom' ? close >= confirmationPrice : close <= confirmationPrice,
  );

  if (!wasConfirmed) return 'pending';

  if (kind === 'bottom') {
    if (currentClose >= targetPrice) return 'target';
    if (currentClose <= stopPrice) return 'failed';
    if (currentClose >= confirmationPrice) return 'success';
    return 'retest';
  }

  if (currentClose <= targetPrice) return 'target';
  if (currentClose >= stopPrice) return 'failed';
  if (currentClose <= confirmationPrice) return 'success';
  return 'retest';
}
