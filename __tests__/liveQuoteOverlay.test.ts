import { overlayLiveThemeQuotes, quoteOverrideFromCandles } from '@/lib/themes/liveQuoteOverlay';

describe('題材統一股價覆蓋', () => {
  const data = {
    date: '2026-08-28',
    themes: [{
      industryId: 'market:光通訊',
      theme: '光通訊',
      memberCount: 2,
      quotedCount: 2,
      upCount: 2,
      avgChange: 1.6,
      maxChange: 2.01,
      topStock: { code: '3081', name: '聯亞', symbol: '3081.TWO', changePercent: 1.19 },
      members: [
        {
          code: '3081', symbol: '3081.TWO', name: '聯亞', changePercent: 1.19,
          volume: 1017, volRatio: 0.8, isLimitUp: false,
        },
        {
          code: '4979', symbol: '4979.TWO', name: '華星光', changePercent: 2.01,
          volume: 800, volRatio: 1.2, isLimitUp: false,
        },
      ],
    }],
  };

  test('以持倉／主圖同源報價修正聯亞並重算題材', () => {
    const result = overlayLiveThemeQuotes(data, [
      { symbol: '3081.TWO', changePercent: -1.93 },
      { symbol: '4979.TWO', changePercent: -1.13 },
    ], { clearMissing: true });

    expect(result.themes[0]).toMatchObject({
      quotedCount: 2,
      upCount: 0,
      avgChange: -1.53,
      maxChange: -1.13,
      topStock: { code: '4979', changePercent: -1.13 },
    });
    expect(result.themes[0].members[0]).toMatchObject({
      code: '3081', changePercent: -1.93, volume: null, volRatio: null,
    });
  });

  test('原 L2 過期時，沒補到的股票清為缺價而不是保留早盤漲幅', () => {
    const result = overlayLiveThemeQuotes(data, [
      { symbol: '3081.TWO', changePercent: -1.93 },
    ], { clearMissing: true });

    expect(result.themes[0].members[1].changePercent).toBeNull();
    expect(result.themes[0]).toMatchObject({
      quotedCount: 1,
      upCount: 0,
      avgChange: -1.93,
      maxChange: -1.93,
      topStock: { code: '3081', changePercent: -1.93 },
    });
  });

  test('原 L2 仍新鮮時，短暫缺價保留新鮮快照值', () => {
    const result = overlayLiveThemeQuotes(data, [
      { symbol: '3081.TWO', changePercent: -1.93 },
    ], { clearMissing: false });

    expect(result.themes[0].members[1].changePercent).toBe(2.01);
    expect(result.themes[0].avgChange).toBe(0.04);
  });

  test('目前主圖以指定交易日和前一交易日收盤計算漲跌', () => {
    expect(quoteOverrideFromCandles('3081.TWO', '2026-08-28', [
      { date: '2026-08-26', close: 3255 },
      { date: '2026-08-27', close: 3370 },
      { date: '2026-08-28', close: 3305 },
    ])).toEqual({ symbol: '3081.TWO', changePercent: -1.93 });
  });

  test('主圖沒有指定交易日或前一日有效收盤時不覆蓋題材', () => {
    expect(quoteOverrideFromCandles('3081.TWO', '2026-08-28', [
      { date: '2026-08-27', close: 3370 },
    ])).toBeNull();
    expect(quoteOverrideFromCandles('3081.TWO', '2026-08-28', [
      { date: '2026-08-27', close: 0 },
      { date: '2026-08-28', close: 3305 },
    ])).toBeNull();
  });
});
