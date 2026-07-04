/**
 * lib/portfolio/averagingDownGuard.ts — 課程 CH10-2 向下攤平紅旗（2026-07-04）
 */
import { describe, it, expect } from '@jest/globals';
import {
  detectAveragingDown,
  mergeAveragedDownFlag,
  readAveragedDownFlag,
} from '@/lib/portfolio/averagingDownGuard';

describe('detectAveragingDown', () => {
  it('股數增加 + 均價下降 → flagged', () => {
    const r = detectAveragingDown({
      existing: { entryPrice: 50, shares: 1000 },
      incoming: { entryPrice: 45, shares: 2000 },
    });
    expect(r.flagged).toBe(true);
    expect(r.detail).toContain('攤平');
  });

  it('股數增加但均價上升（順勢加碼）→ 不觸發', () => {
    const r = detectAveragingDown({
      existing: { entryPrice: 50, shares: 1000 },
      incoming: { entryPrice: 55, shares: 2000 },
    });
    expect(r.flagged).toBe(false);
  });

  it('股數未變（改欄位/修價）→ 不觸發', () => {
    const r = detectAveragingDown({
      existing: { entryPrice: 50, shares: 1000 },
      incoming: { entryPrice: 45, shares: 1000 },
    });
    expect(r.flagged).toBe(false);
  });

  it('減碼 → 不觸發', () => {
    const r = detectAveragingDown({
      existing: { entryPrice: 50, shares: 2000 },
      incoming: { entryPrice: 45, shares: 1000 },
    });
    expect(r.flagged).toBe(false);
  });

  it('lastClose 高於原均價（獲利中往下掛低接）→ 不觸發', () => {
    const r = detectAveragingDown({
      existing: { entryPrice: 50, shares: 1000 },
      incoming: { entryPrice: 48, shares: 2000 },
      lastClose: 55,
    });
    expect(r.flagged).toBe(false);
  });

  it('lastClose 低於原均價（虧損中）→ flagged', () => {
    const r = detectAveragingDown({
      existing: { entryPrice: 50, shares: 1000 },
      incoming: { entryPrice: 45, shares: 2000 },
      lastClose: 44,
    });
    expect(r.flagged).toBe(true);
  });
});

describe('mergeAveragedDownFlag / readAveragedDownFlag', () => {
  const flag = { date: '2026-07-04', fromPrice: 50, toPrice: 45 };

  it('新偵測 → 寫入 incoming ui 的 disciplineFlags', () => {
    const ui = mergeAveragedDownFlag({ triggerSignal: 'B' }, undefined, flag);
    expect(ui?.triggerSignal).toBe('B'); // 原欄位保留
    expect(readAveragedDownFlag(ui)).toEqual(flag);
  });

  it('既有紅旗 carry over（client 全量覆寫 ui 不得洗掉）', () => {
    const existingUi = { disciplineFlags: { averagedDown: flag } };
    const ui = mergeAveragedDownFlag({ triggerSignal: 'B' }, existingUi, null);
    expect(readAveragedDownFlag(ui)).toEqual(flag);
  });

  it('無新旗無舊旗 → ui 原樣返回', () => {
    const incoming = { triggerSignal: 'B' };
    expect(mergeAveragedDownFlag(incoming, undefined, null)).toBe(incoming);
    expect(mergeAveragedDownFlag(undefined, undefined, null)).toBeUndefined();
  });

  it('readAveragedDownFlag 對壞資料防呆', () => {
    expect(readAveragedDownFlag(undefined)).toBeNull();
    expect(readAveragedDownFlag({})).toBeNull();
    expect(readAveragedDownFlag({ disciplineFlags: { averagedDown: { date: 1 } } })).toBeNull();
  });
});
