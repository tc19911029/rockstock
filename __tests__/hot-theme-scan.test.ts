/**
 * 今日全市場熱門題材 — 純聚合邏輯單元測試
 */
import {
  aggregateHotThemes,
  computeHeat,
  HOT_MIN_HEAT,
  type AggregateParams,
} from '@/lib/themes/hotThemeScan';

// 測試輸入可省略 close/prevClose，預設用 prevClose=100 + 依漲跌幅推回 close
type QuoteInput = Omit<AggregateParams['quotes'][number], 'close' | 'prevClose'>
  & { close?: number; prevClose?: number };

function makeParams(
  quotes: QuoteInput[],
  overrides: Partial<AggregateParams> = {},
): AggregateParams {
  return {
    date: '2026-06-18',
    quotes: quotes.map((q) => {
      const prevClose = q.prevClose ?? 100;
      const close = q.close ?? +(prevClose * (1 + q.changePercent / 100)).toFixed(2);
      return { ...q, close, prevClose };
    }),
    volRatioOf: () => null,
    instOf: () => null,
    industryOf: () => undefined,
    isDisposal: () => false,
    isNotice: () => false,
    instFresh: false,
    ...overrides,
  };
}

describe('computeHeat', () => {
  it('漲幅越高熱度越高，+10% 封頂貢獻 60', () => {
    expect(computeHeat(10, null, null)).toBe(60);
    expect(computeHeat(20, null, null)).toBe(60); // 封頂
    expect(computeHeat(5, null, null)).toBe(30);
    expect(computeHeat(0, null, null)).toBe(0);
    expect(computeHeat(-5, null, null)).toBe(0); // 下跌不給分
  });

  it('爆量加分（量比 3x 封頂 25）、法人買超加 15', () => {
    expect(computeHeat(5, 3, null)).toBe(30 + 25);
    expect(computeHeat(5, 1, null)).toBe(30); // 量比 1 無加分
    expect(computeHeat(5, null, 100)).toBe(30 + 15); // 法人買超
    expect(computeHeat(5, null, -100)).toBe(30); // 法人賣超不加
  });
});

describe('aggregateHotThemes', () => {
  it('濾掉指數/ETF/權證，只留 4 碼個股', () => {
    const r = aggregateHotThemes(makeParams([
      { symbol: '^TWII', name: '加權指數', changePercent: 5, volume: 1 },
      { symbol: '0050', name: '元大台灣50', changePercent: 5, volume: 1 }, // 4碼但 0 開頭→濾
      { symbol: '00878', name: '國泰永續', changePercent: 5, volume: 1 },
      { symbol: '2330', name: '台積電', changePercent: 8, volume: 1 },
    ]));
    expect(r.hotStockCount).toBe(1);
    expect(r.themes[0].members[0].code).toBe('2330');
  });

  it('低於熱度門檻不算熱門', () => {
    const r = aggregateHotThemes(makeParams([
      { symbol: '2330', name: '台積電', changePercent: 2, volume: 1 }, // heat=12 < 25
    ]));
    expect(r.hotStockCount).toBe(0);
    expect(r.themes).toHaveLength(0);
  });

  it('處置股被排除（不可交易）', () => {
    const r = aggregateHotThemes(makeParams(
      [{ symbol: '2330', name: '台積電', changePercent: 8, volume: 1 }],
      { isDisposal: (c) => c === '2330' },
    ));
    expect(r.hotStockCount).toBe(0);
  });

  it('只使用交易所官方產業別，不讓人工概念覆蓋', () => {
    const r = aggregateHotThemes(makeParams(
      [{ symbol: '2330', name: '台積電', changePercent: 8, volume: 1 }],
      { industryOf: () => '半導體業' },
    ));
    expect(r.themes[0].theme).toBe('半導體業');
    expect(r.themes[0].source).toBe('industry');
  });

  it('保留上櫃股票完整 .TWO symbol', () => {
    const r = aggregateHotThemes(makeParams(
      [{ symbol: '3081.TWO', name: '聯亞', changePercent: 8, volume: 1 }],
      { industryOf: () => '通信網路業' },
    ));
    expect(r.themes[0].members[0].symbol).toBe('3081.TWO');
    expect(r.themes[0].topStock?.symbol).toBe('3081.TWO');
  });

  it('官方產業別標示 source=industry', () => {
    const r = aggregateHotThemes(makeParams(
      [{ symbol: '9999', name: '某新股', changePercent: 8, volume: 1 }],
      { industryOf: (c) => (c === '9999' ? '航運業' : undefined) },
    ));
    expect(r.themes[0].theme).toBe('航運業');
    expect(r.themes[0].source).toBe('industry');
    expect(r.uncategorizedCount).toBe(0);
  });

  it('官方產業沒有 → 未分類，計入 uncategorizedCount', () => {
    const r = aggregateHotThemes(makeParams(
      [{ symbol: '9998', name: '無分類股', changePercent: 8, volume: 1 }],
    ));
    expect(r.themes[0].theme).toBe('未分類');
    expect(r.uncategorizedCount).toBe(1);
  });

  it('同官方產業多檔熱門股 → 聚合 + 排名分含廣度 bonus', () => {
    const r = aggregateHotThemes(makeParams(
      [
        { symbol: '2408', name: '南亞科', changePercent: 9, volume: 1 },
        { symbol: '2344', name: '華邦電', changePercent: 6, volume: 1 },
        { symbol: '8299', name: '群聯', changePercent: 7, volume: 1 },
      ],
      { industryOf: () => '半導體業' },
    ));
    const semiconductor = r.themes.find((t) => t.theme === '半導體業');
    expect(semiconductor).toBeDefined();
    expect(semiconductor!.hotCount).toBe(3);
    expect(semiconductor!.maxChange).toBe(9);
    // members 按熱度 desc → 第一個是漲最多的 2408
    expect(semiconductor!.members[0].code).toBe('2408');
    expect(semiconductor!.topStock?.code).toBe('2408');
  });

  it('漲停旗標用真實漲停價（前收×1.10），非寬估 9.5%', () => {
    // 達漲停：前收 100 → 漲停價 110，收 110 → true
    const hit = aggregateHotThemes(makeParams([
      { symbol: '2330', name: '台積電', changePercent: 10, volume: 1, prevClose: 100, close: 110 },
    ]));
    expect(hit.themes[0].members[0].isLimitUp).toBe(true);

    // 漲很多但未達漲停：+9.5%（收 109.5，低漲停價一檔）→ false（修正前會誤標 true）
    const near = aggregateHotThemes(makeParams([
      { symbol: '2330', name: '台積電', changePercent: 9.5, volume: 1, prevClose: 100, close: 109.5 },
    ]));
    expect(near.themes[0].members[0].isLimitUp).toBe(false);
  });

  it('門檻常數保持一致（避免誤改）', () => {
    expect(HOT_MIN_HEAT).toBe(25);
  });

  it('行情缺名稱時顯示待補狀態，不把代號當作股名', () => {
    const r = aggregateHotThemes(makeParams([
      { symbol: '2330', name: '2330', changePercent: 8, volume: 1 },
    ]));
    expect(r.themes[0].members[0].name).toBe('名稱待補');
  });
});
