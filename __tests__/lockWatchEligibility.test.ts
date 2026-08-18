import {
  CURRENT_N_PATTERN_DETECTOR_VERSION,
  getLockWatchPurchaseBlockReason,
  hasReachedLockWatchTarget,
  isLockWatchPurchaseEligible,
} from '@/lib/scanner/lockWatchEligibility';
import type { LockWatchRecord } from '@/lib/scanner/lockWatchTypes';

function record(overrides: Partial<LockWatchRecord> = {}): LockWatchRecord {
  return {
    symbol: '3008.TW',
    market: 'TW',
    triggeredDate: '2026-08-17',
    triggerSignal: 'N',
    patternType: 'rounding-bottom',
    triggerPrice: 5000,
    patternTargetPrice: 5500,
    structureBrokenPrice: 4850,
    currentClose: 5200,
    currentStage: 'observation',
    daysObserved: 1,
    history: [],
    ...overrides,
  };
}

describe('LockWatch purchase eligibility', () => {
  it('舊 N 紀錄沒有 detectorVersion 時禁止直接帶入持倉', () => {
    const legacy = record();
    expect(getLockWatchPurchaseBlockReason(legacy)).toBe('legacy-pattern-unverified');
    expect(isLockWatchPurchaseEligible(legacy)).toBe(false);
  });

  it('現行 detector 建立且未達目標的 active N 可記錄買入', () => {
    const current = record({ detectorVersion: CURRENT_N_PATTERN_DETECTOR_VERSION });
    expect(getLockWatchPurchaseBlockReason(current)).toBeNull();
    expect(isLockWatchPurchaseEligible(current)).toBe(true);
  });

  it('底部與頂部型態都使用 3% 目標緩衝', () => {
    expect(hasReachedLockWatchTarget(record({ currentClose: 5335 }))).toBe(true); // 5500 × 0.97
    expect(hasReachedLockWatchTarget(record({ currentClose: 5300 }))).toBe(false);
    expect(hasReachedLockWatchTarget(record({
      patternType: 'head-shoulder-top',
      patternTargetPrice: 100,
      currentClose: 103,
    }))).toBe(true);
  });

  it('已達標或已結束 stage 一律不可再買', () => {
    const currentVersion = CURRENT_N_PATTERN_DETECTOR_VERSION;
    expect(getLockWatchPurchaseBlockReason(record({
      detectorVersion: currentVersion,
      currentClose: 5400,
    }))).toBe('target-reached');
    expect(getLockWatchPurchaseBlockReason(record({
      detectorVersion: currentVersion,
      currentStage: 'revoked',
    }))).toBe('inactive-stage');
  });

  it('舊 F 紀錄缺少真正 V 底時禁止帶入持倉', () => {
    const legacyF = record({
      triggerSignal: 'F',
      patternType: undefined,
      patternTargetPrice: undefined,
      detectorVersion: undefined,
      vBottom: undefined,
    });
    expect(getLockWatchPurchaseBlockReason(legacyF)).toBe('missing-structure-stop');
  });
});
