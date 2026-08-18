import { mergeLockWatchRecord } from '@/lib/scanner/lockWatchMerge';
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
    currentStage: 'observation',
    daysObserved: 0,
    history: [{ date: '2026-08-17', event: 'triggered', detail: 'old' }],
    ...overrides,
  };
}

describe('mergeLockWatchRecord', () => {
  it('今日重新觸發必須取代昨日舊鎖定，且保留歷史', () => {
    const oldRecord = record({ currentStage: 'revoked' });
    const today = record({
      triggeredDate: '2026-08-18',
      patternType: 'n-shape',
      triggerPrice: 4770,
      patternTargetPrice: 5330,
      history: [{ date: '2026-08-18', event: 'triggered', detail: 'new' }],
    });
    const merged = mergeLockWatchRecord(oldRecord, today);
    expect(merged.triggeredDate).toBe('2026-08-18');
    expect(merged.patternType).toBe('n-shape');
    expect(merged.history).toHaveLength(2);
  });

  it('同日已買進不可被重複掃描重設為 observation', () => {
    const purchased = record({ currentStage: 'purchased' });
    const repeatedScan = record({ currentStage: 'observation', triggerPrice: 5100 });
    expect(mergeLockWatchRecord(purchased, repeatedScan)).toBe(purchased);
  });

  it('同日 active 重掃採最新 detector 價位', () => {
    const existing = record({ triggerPrice: 5000 });
    const incoming = record({ triggerPrice: 5070 });
    expect(mergeLockWatchRecord(existing, incoming).triggerPrice).toBe(5070);
  });
});
