import { TRUE_BREAKOUT_PCT } from '@/lib/analysis/bookThresholds';

export type PatternLifecycleStatus =
  | 'pending'
  | 'confirmed'
  | 'retest'
  | 'breakout-failed'
  | 'formation-broken'
  | 'target';

interface PatternLifecycleCandle {
  close: number;
  high: number;
  low: number;
}

interface PatternLifecycleInput {
  kind: 'bottom' | 'top';
  currentClose: number;
  necklinePrice: number;
  targetPrice: number;
  stopPrice: number;
  candlesSinceFormation: readonly PatternLifecycleCandle[];
  /** 未確認前的原型態邊界：底部型態取最低腳，頂部型態取最高頭。 */
  formationBoundaryPrice?: number;
  /** 鎖定紀錄只會在觸發後建立，因此可視為已完成突破／跌破確認。 */
  assumeConfirmed?: boolean;
}

/**
 * 依「形成 → 確認 → 回測／失效」順序判定型態狀態。
 *
 * 關鍵限制：尚未曾通過 3% 真突破門檻時，不套用「突破後回測防守」；
 * 只有跌破／漲破原始腳位，才標示為「原型態已破壞」。
 */
export function getPatternLifecycleStatus({
  kind,
  currentClose,
  necklinePrice,
  targetPrice,
  stopPrice,
  candlesSinceFormation,
  formationBoundaryPrice,
  assumeConfirmed = false,
}: PatternLifecycleInput): PatternLifecycleStatus {
  const confirmationPrice = getPatternConfirmationPrice(kind, necklinePrice);
  const detectedConfirmationIndex = candlesSinceFormation.findIndex(candle =>
    kind === 'bottom' ? candle.close >= confirmationPrice : candle.close <= confirmationPrice,
  );
  const confirmationIndex = assumeConfirmed ? 0 : detectedConfirmationIndex;
  const wasConfirmed = confirmationIndex >= 0;

  if (!wasConfirmed) {
    const formationBroken = formationBoundaryPrice != null && candlesSinceFormation.some(candle =>
      kind === 'bottom'
        ? candle.low < formationBoundaryPrice
        : candle.high > formationBoundaryPrice,
    );
    return formationBroken ? 'formation-broken' : 'pending';
  }

  // 目標達成／突破失敗都是不可逆的終結事件。舊版只看目前收盤，導致達標後
  // 拉回或停損後反彈時又顯示「已確認」。依時間順序掃描並鎖定第一個終結事件。
  for (let i = confirmationIndex; i < candlesSinceFormation.length; i++) {
    const close = candlesSinceFormation[i].close;
    if (kind === 'bottom') {
      if (close >= targetPrice) return 'target';
      if (close <= stopPrice) return 'breakout-failed';
    } else {
      if (close <= targetPrice) return 'target';
      if (close >= stopPrice) return 'breakout-failed';
    }
  }

  if (kind === 'bottom') {
    if (currentClose >= confirmationPrice) return 'confirmed';
    return 'retest';
  }

  if (currentClose <= confirmationPrice) return 'confirmed';
  return 'retest';
}

export function getPatternConfirmationPrice(kind: 'bottom' | 'top', necklinePrice: number): number {
  return kind === 'bottom'
    ? necklinePrice * (1 + TRUE_BREAKOUT_PCT)
    : necklinePrice * (1 - TRUE_BREAKOUT_PCT);
}
