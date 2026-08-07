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
      closesSinceFormation: [364.18, 386.24, 388.25, 403.25],
    })).toBe('pending');
  });

  it('曾真突破後跌破防守價才標記結構失效', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 403.25,
      closesSinceFormation: [445, 430, 403.25],
    })).toBe('failed');
  });

  it('曾真突破但仍守住防守價時顯示突破後回測', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 425,
      closesSinceFormation: [445, 425],
    })).toBe('retest');
  });

  it('目前仍在真突破門檻上方時顯示已突破', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 450,
      closesSinceFormation: [450],
    })).toBe('success');
  });

  it('到達測量目標時顯示目標達成', () => {
    expect(getPatternLifecycleStatus({
      ...DEMINGLI_DOUBLE_BOTTOM,
      currentClose: 524.08,
      closesSinceFormation: [450, 524.08],
    })).toBe('target');
  });

  it('頂部型態套用對稱的先確認、後失效順序', () => {
    expect(getPatternLifecycleStatus({
      kind: 'top',
      currentClose: 104,
      necklinePrice: 100,
      targetPrice: 80,
      stopPrice: 103,
      closesSinceFormation: [96, 104],
    })).toBe('failed');
  });
});
