import {
  inferPatternMarket,
  normalizePatternSymbol,
  selectLatestLockedPattern,
} from '@/lib/scanner/lockedPatternSelection';

describe('lockedPatternSelection', () => {
  it('台陸後綴都能正規化，market hint 優先於裸代號猜測', () => {
    expect(normalizePatternSymbol('000988.SZ')).toBe('000988');
    expect(normalizePatternSymbol('2330.TW')).toBe('2330');
    expect(inferPatternMarket('600000.SS')).toBe('CN');
    expect(inferPatternMarket('000988', 'CN')).toBe('CN');
  });

  it('同檔 F 排在前面時仍能找到 N，且選最新有效型態', () => {
    const records = [
      {
        symbol: '000988.SZ', triggerSignal: 'F', triggerPrice: 90,
        currentStage: 'observation', triggeredDate: '2026-07-01',
      },
      {
        symbol: '000988.SZ', triggerSignal: 'N', patternType: 'n-shape',
        triggerPrice: 100, patternTargetPrice: 120,
        currentStage: 'observation', triggeredDate: '2026-07-02',
      },
      {
        symbol: '000988.SZ', triggerSignal: 'N', patternType: 'rounding-bottom',
        triggerPrice: 105, patternTargetPrice: 130,
        currentStage: 'observation', triggeredDate: '2026-07-05',
      },
      {
        symbol: '000988.SZ', triggerSignal: 'N', patternType: 'head-shoulder',
        triggerPrice: 110, patternTargetPrice: 140,
        currentStage: 'revoked', triggeredDate: '2026-07-06',
      },
    ];

    expect(selectLatestLockedPattern(records, '000988')?.patternType).toBe('rounding-bottom');
  });

  it('舊 pending-breakout 仍視為可顯示，已失效紀錄排除', () => {
    const pending = {
      symbol: '2330.TW', triggerSignal: 'N', patternType: 'triple-bottom',
      triggerPrice: 100, patternTargetPrice: 120,
      currentStage: 'pending-breakout', triggeredDate: '2026-06-01',
    };
    expect(selectLatestLockedPattern([pending], '2330')).toBe(pending);
    expect(selectLatestLockedPattern([{ ...pending, currentStage: 'structure-broken' }], '2330')).toBeNull();
    expect(selectLatestLockedPattern([{ ...pending, patternTargetPrice: -1 }], '2330')).toBeNull();
    expect(selectLatestLockedPattern([{ ...pending, patternType: 'mystery-pattern' }], '2330')).toBeNull();
  });
});
