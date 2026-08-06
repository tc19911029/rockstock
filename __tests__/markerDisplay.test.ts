import {
  getCompactSignalMarkerLabel,
  isAggregateSignalMarker,
  shouldHideAggregateSignalLabels,
} from '@/lib/chart/markerDisplay';

describe('markerDisplay', () => {
  it('移除主圖買訊號重複的六條件分數，只保留方向與共振強度', () => {
    expect(getCompactSignalMarkerLabel({ type: 'BUY', label: '買 ×3 (5/6)', strength: 3 })).toBe('買×3');
  });

  it('強賣與一般賣出統一成短標籤', () => {
    expect(getCompactSignalMarkerLabel({ type: 'SELL', label: '強賣 ×6', strength: 6 })).toBe('賣×6');
    expect(getCompactSignalMarkerLabel({ type: 'SELL', label: '賣 ×2', strength: 2 })).toBe('賣×2');
  });

  it('保留字母買法與特殊風險警示原文', () => {
    expect(getCompactSignalMarkerLabel({ type: 'BUY', label: 'N', strength: 2 })).toBe('N');
    expect(getCompactSignalMarkerLabel({ type: 'SELL', label: '爆量長黑', strength: 3 })).toBe('爆量長黑');
  });

  it('只把規則引擎彙總訊號納入密度控制', () => {
    expect(isAggregateSignalMarker({ label: '買 ×3 (5/6)' })).toBe(true);
    expect(isAggregateSignalMarker({ label: '強賣 ×6' })).toBe(true);
    expect(isAggregateSignalMarker({ label: 'N' })).toBe(false);
    expect(isAggregateSignalMarker({ label: '爆量長黑' })).toBe(false);
  });

  it('最近區間超過八個彙總訊號才隱藏重複文字', () => {
    const dense = Array.from({ length: 9 }, () => ({ label: '買 ×3 (5/6)' }));
    expect(shouldHideAggregateSignalLabels(dense)).toBe(true);
    expect(shouldHideAggregateSignalLabels(dense.slice(0, 8))).toBe(false);
  });
});
