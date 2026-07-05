/**
 * lib/realtime/holdingsGuard — 規則5 reversal-open-low（漏網-3，2026-07-05）
 *
 * 課程 CH2-9「次日開盤方向定強弱」：昨日日K高檔轉折/變盤訊號 + 今晨開盤窗開低 ≥0.5%
 * → 變盤確認早鳥提醒（收盤級正式判定仍在 daily-action）。
 */
import { describe, it, expect } from '@jest/globals';
import { detectGuardSignals } from '@/lib/realtime/holdingsGuard';

describe('規則5 reversal-open-low — 昨日轉折＋開盤窗開低', () => {
  const baseCtx = {
    symbol: '2330.TW', market: 'TW' as const, source: 'holding' as const, isHolding: true,
    holding: {
      name: '台積電', entryPrice: 100, stopLoss: 80, positionSide: 'long' as const,
      reversalWatch: { label: '高檔母子懷抱（變盤・次日確認）', yLow: 636, yClose: 641 },
    },
  };
  // TW 開盤後 10 分鐘（09:10 CST = 01:10 UTC，週一）
  const openPlus10 = new Date('2026-07-06T01:10:00Z').getTime();

  it('開低 0.5% 以上 → 觸發 reversal-open-low', () => {
    const sigs = detectGuardSignals({ price: 636.5, prevClose: 641 }, [], baseCtx, openPlus10);
    const hit = sigs.find(s => s.rule === 'reversal-open-low');
    expect(hit).toBeDefined();
    expect(hit!.meta.reversalLabel).toContain('母子');
    expect(hit!.meta.yLow).toBe(636);
  });

  it('開高 → 不觸發', () => {
    const sigs = detectGuardSignals({ price: 645, prevClose: 641 }, [], baseCtx, openPlus10);
    expect(sigs.some(s => s.rule === 'reversal-open-low')).toBe(false);
  });

  it('超過開盤 30 分鐘窗 → 不觸發', () => {
    const late = new Date('2026-07-06T02:10:00Z').getTime(); // 10:10 CST
    const sigs = detectGuardSignals({ price: 636.5, prevClose: 641 }, [], baseCtx, late);
    expect(sigs.some(s => s.rule === 'reversal-open-low')).toBe(false);
  });

  it('昨日無轉折旗標 → 不觸發', () => {
    const ctx = { ...baseCtx, holding: { ...baseCtx.holding, reversalWatch: undefined } };
    const sigs = detectGuardSignals({ price: 636.5, prevClose: 641 }, [], ctx, openPlus10);
    expect(sigs.some(s => s.rule === 'reversal-open-low')).toBe(false);
  });

  it('做空持倉 → 不觸發（開低對空單是利多）', () => {
    const ctx = { ...baseCtx, holding: { ...baseCtx.holding, positionSide: 'short' as const, entryHigh: 700 } };
    const sigs = detectGuardSignals({ price: 636.5, prevClose: 641 }, [], ctx, openPlus10);
    expect(sigs.some(s => s.rule === 'reversal-open-low')).toBe(false);
  });
});
