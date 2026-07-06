/**
 * lib/portfolio/stopLossGuard.ts — 課程 CH7-1 停損下修紅旗（2026-07-06）
 */
import { describe, it, expect } from '@jest/globals';
import {
  detectStopLossLowered,
  mergeStopLossLoweredFlag,
  readStopLossLoweredFlag,
} from '@/lib/portfolio/stopLossGuard';

describe('detectStopLossLowered', () => {
  it('做多停損往下改（放鬆）→ flagged', () => {
    const r = detectStopLossLowered({
      existing: { stopLoss: 45 },
      incoming: { stopLoss: 40 },
      positionSide: 'long',
    });
    expect(r.flagged).toBe(true);
    expect(r.detail).toContain('停損設了就不可以改');
  });

  it('做多停損往上改（收緊 / 移動停利）→ 不觸發', () => {
    const r = detectStopLossLowered({
      existing: { stopLoss: 45 },
      incoming: { stopLoss: 48 },
      positionSide: 'long',
    });
    expect(r.flagged).toBe(false);
  });

  it('做空停損往上改（放鬆）→ flagged', () => {
    const r = detectStopLossLowered({
      existing: { stopLoss: 55 },
      incoming: { stopLoss: 60 },
      positionSide: 'short',
    });
    expect(r.flagged).toBe(true);
  });

  it('做空停損往下改（收緊）→ 不觸發', () => {
    const r = detectStopLossLowered({
      existing: { stopLoss: 55 },
      incoming: { stopLoss: 50 },
      positionSide: 'short',
    });
    expect(r.flagged).toBe(false);
  });

  it('缺 positionSide → 視為做多', () => {
    const r = detectStopLossLowered({
      existing: { stopLoss: 45 },
      incoming: { stopLoss: 40 },
    });
    expect(r.flagged).toBe(true);
  });

  it('停損不變 → 不觸發', () => {
    const r = detectStopLossLowered({
      existing: { stopLoss: 45 },
      incoming: { stopLoss: 45 },
      positionSide: 'long',
    });
    expect(r.flagged).toBe(false);
  });

  it('缺任一停損值（未重送/未設）→ 不臆測、不觸發', () => {
    expect(detectStopLossLowered({ existing: { stopLoss: 45 }, incoming: { stopLoss: null } }).flagged).toBe(false);
    expect(detectStopLossLowered({ existing: { stopLoss: null }, incoming: { stopLoss: 40 } }).flagged).toBe(false);
    expect(detectStopLossLowered({ existing: {}, incoming: {} }).flagged).toBe(false);
  });
});

describe('mergeStopLossLoweredFlag / readStopLossLoweredFlag', () => {
  const flag = { date: '2026-07-06', fromStop: 45, toStop: 40, side: 'long' as const };

  it('新偵測 → 寫入 incoming ui 的 disciplineFlags', () => {
    const ui = mergeStopLossLoweredFlag({ triggerSignal: 'B' }, undefined, flag);
    expect(ui?.triggerSignal).toBe('B'); // 原欄位保留
    expect(readStopLossLoweredFlag(ui)).toEqual(flag);
  });

  it('既有紅旗 carry over（client 全量覆寫 ui 不得洗掉）', () => {
    const existingUi = { disciplineFlags: { stopLossLowered: flag } };
    const ui = mergeStopLossLoweredFlag({ triggerSignal: 'B' }, existingUi, null);
    expect(readStopLossLoweredFlag(ui)).toEqual(flag);
  });

  it('與攤平紅旗共存於 disciplineFlags（不互相洗掉）', () => {
    const avgFlag = { date: '2026-07-06', fromPrice: 50, toPrice: 45 };
    const uiWithAvg = { disciplineFlags: { averagedDown: avgFlag } };
    const ui = mergeStopLossLoweredFlag(uiWithAvg, undefined, flag);
    const df = ui?.disciplineFlags as Record<string, unknown>;
    expect(df.averagedDown).toEqual(avgFlag);
    expect(df.stopLossLowered).toEqual(flag);
  });

  it('無新旗無舊旗 → ui 原樣返回', () => {
    const incoming = { triggerSignal: 'B' };
    expect(mergeStopLossLoweredFlag(incoming, undefined, null)).toBe(incoming);
    expect(mergeStopLossLoweredFlag(undefined, undefined, null)).toBeUndefined();
  });

  it('readStopLossLoweredFlag 對壞資料防呆', () => {
    expect(readStopLossLoweredFlag(undefined)).toBeNull();
    expect(readStopLossLoweredFlag({})).toBeNull();
    expect(readStopLossLoweredFlag({ disciplineFlags: { stopLossLowered: { fromStop: 'x' } } })).toBeNull();
  });
});
