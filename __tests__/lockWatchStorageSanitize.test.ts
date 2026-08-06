import { sanitizeLockWatchSnapshot } from '@/lib/storage/lockWatchStorage';
import type { LockWatchDailySnapshot, LockWatchRecord } from '@/lib/scanner/lockWatchTypes';

function record(overrides: Partial<LockWatchRecord>): LockWatchRecord {
  return {
    symbol: '2330.TW',
    market: 'TW',
    triggeredDate: '2026-06-01',
    triggerSignal: 'N',
    patternType: 'head-shoulder',
    triggerPrice: 100,
    patternTargetPrice: 120,
    currentStage: 'observation',
    daysObserved: 0,
    history: [],
    ...overrides,
  };
}

describe('sanitizeLockWatchSnapshot', () => {
  it('校正舊書明載數字，移除 N 與頂部舊自行估值', () => {
    const snapshot: LockWatchDailySnapshot = {
      market: 'TW',
      date: '2026-06-01',
      lastUpdated: '2026-06-01T00:00:00.000Z',
      records: [
        record({ patternType: 'head-shoulder', patternAchievementRate: 0.7 }),
        record({ symbol: '2331.TW', patternType: 'n-shape', patternAchievementRate: 0.75 }),
        record({ symbol: '2332.TW', patternType: 'triple-top', patternAchievementRate: 0.95 }),
      ],
    };

    const sanitized = sanitizeLockWatchSnapshot(snapshot);
    expect(sanitized.records[0].patternAchievementRate).toBe(0.83);
    expect(sanitized.records[1].patternAchievementRate).toBeUndefined();
    expect(sanitized.records[2].patternAchievementRate).toBeUndefined();
  });
});
