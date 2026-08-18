import { isTopPatternType } from '../analysis/patternCatalog';
import type { LockWatchRecord } from './lockWatchTypes';

/**
 * N 型態鎖定資料所使用的 detector 契約版本。
 *
 * 只要型態選擇、頸線、目標價或觸發 gate 的語意有不相容變更，就必須遞增。
 * 舊紀錄沒有此欄位時一律視為待重驗，不能直接帶入持倉。
 */
export const CURRENT_N_PATTERN_DETECTOR_VERSION = 20260818;

const PURCHASE_STAGES = new Set<LockWatchRecord['currentStage']>([
  'observation',
  'entry-signal',
]);

export type LockWatchPurchaseBlockReason =
  | 'inactive-stage'
  | 'legacy-pattern-unverified'
  | 'missing-structure-stop'
  | 'target-reached'
  | 'invalid-price';

/** 型態已進入目標價 3% 緩衝區，不再視為新的進場點。 */
export function hasReachedLockWatchTarget(
  record: Pick<LockWatchRecord, 'patternType' | 'patternTargetPrice' | 'currentClose'>,
  referencePrice = record.currentClose,
): boolean {
  if (
    !record.patternType ||
    typeof record.patternTargetPrice !== 'number' ||
    !Number.isFinite(record.patternTargetPrice) ||
    record.patternTargetPrice <= 0 ||
    typeof referencePrice !== 'number' ||
    !Number.isFinite(referencePrice) ||
    referencePrice <= 0
  ) {
    return false;
  }

  return isTopPatternType(record.patternType)
    ? referencePrice <= record.patternTargetPrice * 1.03
    : referencePrice >= record.patternTargetPrice * 0.97;
}

export function getLockWatchPurchaseBlockReason(
  record: LockWatchRecord,
  entryPrice?: number,
): LockWatchPurchaseBlockReason | null {
  if (!PURCHASE_STAGES.has(record.currentStage)) return 'inactive-stage';
  if (record.triggerSignal === 'N' && record.detectorVersion !== CURRENT_N_PATTERN_DETECTOR_VERSION) {
    return 'legacy-pattern-unverified';
  }
  if (
    record.triggerSignal === 'F' &&
    (typeof record.vBottom !== 'number' || !Number.isFinite(record.vBottom) || record.vBottom <= 0)
  ) {
    return 'missing-structure-stop';
  }
  if (entryPrice != null && (!Number.isFinite(entryPrice) || entryPrice <= 0)) return 'invalid-price';
  if (
    hasReachedLockWatchTarget(record, record.currentClose) ||
    (entryPrice != null && hasReachedLockWatchTarget(record, entryPrice))
  ) {
    return 'target-reached';
  }
  return null;
}

export function isLockWatchPurchaseEligible(record: LockWatchRecord, entryPrice?: number): boolean {
  return getLockWatchPurchaseBlockReason(record, entryPrice) == null;
}

export function lockWatchPurchaseBlockMessage(reason: LockWatchPurchaseBlockReason): string {
  switch (reason) {
    case 'legacy-pattern-unverified':
      return '這筆舊 N 型態尚未通過現行偵測器重驗，不能帶入持倉。';
    case 'target-reached':
      return '股價已接近或到達型態目標，不再是新的進場位置。';
    case 'missing-structure-stop':
      return '這筆舊 V 反轉缺少可核對的 V 底停損價，不能直接帶入持倉。';
    case 'invalid-price':
      return '買進價格必須是大於 0 的有效數字。';
    default:
      return '這筆訊號已失效、結束或不在可買進階段。';
  }
}
