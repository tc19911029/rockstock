import { getPatternLifecycleStatus } from '@/lib/chart/patternLifecycle';

const DEMINGLI_DOUBLE_BOTTOM = {
  kind: 'bottom' as const,
  necklinePrice: 429.04,
  targetPrice: 524.08,
  stopPrice: 429.04 * 0.97,
};

describe('getPatternLifecycleStatus', () => {
  it('尚未真突破的雙重底維持待突破，不因現價低於回測防守價誤標失效', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 403.25,
      candlesSinceFormation: [364.18, 386.24, 388.25, 403.25].map(close => ({ close, high: close + 5, low: close - 5 })),
    })).toBe('pending');
  });

  it('尚未真突破但跌破原雙底最低腳時，才標記原型態破壞', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 330,
      formationBoundaryPrice: 334,
      candlesSinceFormation: [{ close: 330, high: 340, low: 328 }],
    })).toBe('formation-broken');
  });

  it('曾真突破後跌破防守價才標記結構失效', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 403.25,
      candlesSinceFormation: [445, 430, 403.25].map(close => ({ close, high: close + 5, low: close - 5 })),
    })).toBe('breakout-failed');
  });

  it('曾真突破但仍守住防守價時顯示突破後回測', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 425,
      candlesSinceFormation: [445, 425].map(close => ({ close, high: close + 5, low: close - 5 })),
    })).toBe('retest');
  });

  it('目前仍在真突破門檻上方時顯示已突破', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 450,
      candlesSinceFormation: [{ close: 450, high: 455, low: 445 }],
    })).toBe('confirmed');
  });

  it('到達測量目標時顯示目標達成', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 524.08,
      candlesSinceFormation: [450, 524.08].map(close => ({ close, high: close + 5, low: close - 5 })),
    })).toBe('target');
  });

  it('頂部型態套用對稱的先確認、後失效順序', () => {
    expect(getPatternLifecycleStatus({
      kind: 'top',
      currentClose: 104,
      necklinePrice: 100,
      targetPrice: 80,
      stopPrice: 103,
      candlesSinceFormation: [96, 104].map(close => ({ close, high: close + 1, low: close - 1 })),
    })).toBe('breakout-failed');
  });
});
