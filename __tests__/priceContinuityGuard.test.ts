import {
  findRecentPriceDiscontinuity,
  hasRecentPriceDiscontinuity,
  isLegacyMechanicalDiscontinuity,
} from '@/lib/scanner/priceContinuityGuard';

const candles = (closes: number[]) => closes.map((close, index) => ({
  date: `2026-08-${String(index + 1).padStart(2, '0')}`,
  close,
}));

describe('priceContinuityGuard', () => {
  test('正常漲跌停與連續下跌不誤判', () => {
    expect(hasRecentPriceDiscontinuity(candles([100, 90, 81, 72.9, 65.61]))).toBe(false);
  });

  test('抓出寶雅面額變更式的未還原斷層', () => {
    const found = findRecentPriceDiscontinuity(candles([668, 679, 720, 79.2, 87.1]));
    expect(found).toMatchObject({ previousClose: 720, close: 79.2 });
    expect(found?.changeRatio).toBeLessThan(-0.8);
  });

  test('只檢查近期技術視窗，久遠公司行動不永久封鎖', () => {
    const series = candles([700, 70, ...Array.from({ length: 30 }, (_, i) => 71 + i)]);
    expect(hasRecentPriceDiscontinuity(series, 25)).toBe(false);
  });

  test('舊機械軌只隔離極端乖離列', () => {
    expect(isLegacyMechanicalDiscontinuity({ ma20Deviation: -0.846 })).toBe(true);
    expect(isLegacyMechanicalDiscontinuity({ ma20Deviation: -0.144 })).toBe(false);
  });
});
