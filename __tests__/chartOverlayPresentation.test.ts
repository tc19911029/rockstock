import {
  getCandleRangeLabels,
  getPatternDirectionLabels,
  getPatternLevelVisibility,
  getTargetDistanceText,
  selectActionableSupportResistanceLevels,
  shouldShowPatternGeometry,
} from '@/lib/chart/overlayPresentation';
import type { Pivot } from '@/lib/analysis/trendAnalysis';

describe('chart overlay presentation', () => {
  const pivots: Pivot[] = [
    { index: 9, price: 120, type: 'high' },
    { index: 8, price: 95, type: 'low' },
    { index: 7, price: 110, type: 'high' },
    { index: 6, price: 70, type: 'low' },
  ];

  it('壓撐只取現價上下最近價位，並合併 1% 內的大量價', () => {
    expect(selectActionableSupportResistanceLevels(pivots, 100, 110.5)).toEqual([
      { price: 110, label: '最近壓', role: 'resistance' },
      { price: 95, label: '最近撐', role: 'support' },
    ]);
  });

  it('所有前高都已突破時改標前高轉撐', () => {
    expect(selectActionableSupportResistanceLevels(pivots, 130)).toEqual([
      { price: 120, label: '前高轉撐', role: 'support' },
      { price: 95, label: '最近撐', role: 'support' },
    ]);
  });

  it('K棒三價位使用中性名稱，不預先宣告最強撐壓', () => {
    expect(getCandleRangeLabels('up')).toEqual({ strong: '長紅高', mid: 'K棒½', weak: '長紅低' });
    expect(getCandleRangeLabels('down')).toEqual({ strong: '長黑低', mid: 'K棒½', weak: '長黑高' });
  });

  it('待確認顯示頸線、確認價與形成後目標預覽，但不顯示失效價', () => {
    expect(getPatternLevelVisibility('pending')).toMatchObject({
      neckline: true,
      confirmation: true,
      target: true,
      stop: false,
    });
  });

  it('型態價位只在走圖圖例標示，不在價格軸重複顯示', () => {
    const statuses = ['pending', 'confirmed', 'retest', 'breakout-failed', 'formation-broken', 'target'] as const;
    for (const status of statuses) {
      expect(getPatternLevelVisibility(status)).toMatchObject({
        necklineAxisLabel: false,
        confirmationAxisLabel: false,
        targetAxisLabel: false,
        stopAxisLabel: false,
      });
    }
  });

  it('頂部型態使用跌破／反彈語意', () => {
    expect(getPatternDirectionLabels('top')).toMatchObject({
      confirmation: '確認跌破',
      target: '下跌目標',
      stop: '反彈失效',
      pendingOperator: '≤',
    });
  });

  it('型態達標或失敗後不再顯示整組歷史腳位', () => {
    expect(shouldShowPatternGeometry('pending')).toBe(true);
    expect(shouldShowPatternGeometry('retest')).toBe(true);
    expect(shouldShowPatternGeometry('target')).toBe(false);
    expect(shouldShowPatternGeometry('breakout-failed')).toBe(false);
  });

  it('目標價顯示相對現價的百分比距離', () => {
    expect(getTargetDistanceText(248, 326)).toBe('距現價 +31.5%');
    expect(getTargetDistanceText(248, 220)).toBe('距現價 -11.3%');
  });
});
