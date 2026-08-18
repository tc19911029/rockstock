import type { Pivot } from '@/lib/analysis/trendAnalysis';
import type { PatternLifecycleStatus } from './patternLifecycle';

export interface SupportResistanceOverlayLevel {
  price: number;
  label: '最近壓' | '最近撐' | '前高轉撐' | '大量壓' | '大量撐';
  role: 'resistance' | 'support';
}

/**
 * 圖表壓撐只顯示離現價最近、仍可執行的價位。
 *
 * 舊版直接取最近 pivots 的最高頭與最低底，常把很遠的歷史極值畫進主圖；
 * 這裡改成上方最近壓力、下方最近支撐。若所有前高都已突破，最近前高改標
 * 「前高轉撐」。大量價與既有價位相差不到 1% 時合併，避免右軸標籤重疊。
 */
export function selectActionableSupportResistanceLevels(
  pivots: readonly Pivot[],
  currentClose: number,
  bigVolumeClose?: number,
): SupportResistanceOverlayLevel[] {
  if (!Number.isFinite(currentClose) || currentClose <= 0) return [];

  const highs = pivots.filter(p => p.type === 'high').map(p => p.price).filter(Number.isFinite);
  const lows = pivots.filter(p => p.type === 'low').map(p => p.price).filter(Number.isFinite);
  const levels: SupportResistanceOverlayLevel[] = [];
  const add = (level: SupportResistanceOverlayLevel) => {
    const duplicate = levels.some(existing =>
      Math.abs(existing.price - level.price) / Math.max(Math.abs(level.price), Number.EPSILON) <= 0.01,
    );
    if (!duplicate && level.price > 0) levels.push(level);
  };

  const overhead = highs.filter(price => price > currentClose).sort((a, b) => a - b);
  if (overhead.length > 0) {
    add({ price: overhead[0], label: '最近壓', role: 'resistance' });
  } else {
    const brokenHighs = highs.filter(price => price <= currentClose).sort((a, b) => b - a);
    if (brokenHighs.length > 0) {
      add({ price: brokenHighs[0], label: '前高轉撐', role: 'support' });
    }
  }

  const below = lows.filter(price => price < currentClose).sort((a, b) => b - a);
  if (below.length > 0) add({ price: below[0], label: '最近撐', role: 'support' });

  if (bigVolumeClose != null && Number.isFinite(bigVolumeClose) && bigVolumeClose > 0) {
    const isSupport = bigVolumeClose <= currentClose;
    add({
      price: bigVolumeClose,
      label: isSupport ? '大量撐' : '大量壓',
      role: isSupport ? 'support' : 'resistance',
    });
  }

  return levels;
}

export function getCandleRangeLabels(direction: 'up' | 'down') {
  return direction === 'up'
    ? { strong: '長紅高', mid: 'K棒½', weak: '長紅低' }
    : { strong: '長黑低', mid: 'K棒½', weak: '長黑高' };
}

export interface PatternLevelVisibility {
  neckline: boolean;
  confirmation: boolean;
  target: boolean;
  stop: boolean;
  necklineAxisLabel: boolean;
  confirmationAxisLabel: boolean;
  targetAxisLabel: boolean;
  stopAxisLabel: boolean;
}

/** 依型態生命週期只留下當下有決策意義的價位，避免四條線永久同時顯示。 */
export function getPatternLevelVisibility(status: PatternLifecycleStatus | null): PatternLevelVisibility {
  switch (status) {
    case 'pending':
      return {
        neckline: true, confirmation: true, target: false, stop: false,
        necklineAxisLabel: true, confirmationAxisLabel: true, targetAxisLabel: false, stopAxisLabel: false,
      };
    case 'confirmed':
      return {
        neckline: true, confirmation: false, target: true, stop: true,
        necklineAxisLabel: false, confirmationAxisLabel: false, targetAxisLabel: true, stopAxisLabel: true,
      };
    case 'retest':
      return {
        neckline: false, confirmation: true, target: true, stop: true,
        necklineAxisLabel: false, confirmationAxisLabel: true, targetAxisLabel: true, stopAxisLabel: true,
      };
    case 'breakout-failed':
      return {
        neckline: false, confirmation: false, target: false, stop: true,
        necklineAxisLabel: false, confirmationAxisLabel: false, targetAxisLabel: false, stopAxisLabel: true,
      };
    case 'formation-broken':
      return {
        neckline: true, confirmation: false, target: false, stop: false,
        necklineAxisLabel: true, confirmationAxisLabel: false, targetAxisLabel: false, stopAxisLabel: false,
      };
    case 'target':
      return {
        neckline: false, confirmation: false, target: true, stop: false,
        necklineAxisLabel: false, confirmationAxisLabel: false, targetAxisLabel: true, stopAxisLabel: false,
      };
    default:
      return {
        neckline: false, confirmation: false, target: false, stop: false,
        necklineAxisLabel: false, confirmationAxisLabel: false, targetAxisLabel: false, stopAxisLabel: false,
      };
  }
}

/** 終止狀態只保留結論價位；歷史腳位不再佔滿主圖。 */
export function shouldShowPatternGeometry(status: PatternLifecycleStatus | null): boolean {
  return status === 'pending' || status === 'confirmed' || status === 'retest';
}

/** 以目前價格為分母，顯示到目標價還差多少；正值代表目標在現價上方。 */
export function getTargetDistanceText(currentPrice: number, targetPrice: number): string | null {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(targetPrice)) return null;
  const distancePct = (targetPrice - currentPrice) / currentPrice * 100;
  const signedPct = `${distancePct > 0 ? '+' : ''}${distancePct.toFixed(1)}%`;
  return `距現價 ${signedPct}`;
}

export function getPatternDirectionLabels(kind: 'bottom' | 'top') {
  return kind === 'bottom'
    ? {
      confirmation: '確認突破',
      target: '測量目標',
      stop: '回測失效',
      pendingOperator: '≥',
      confirmed: '突破成立',
      retest: '突破後回測',
      failed: '突破失敗',
    }
    : {
      confirmation: '確認跌破',
      target: '下跌目標',
      stop: '反彈失效',
      pendingOperator: '≤',
      confirmed: '跌破成立',
      retest: '跌破後反彈',
      failed: '跌破失敗',
    };
}
