import { findMisQuoteRow, parseMisPrice, parseMisBestPrice, resolveMisClose, resolveMisIndicativePrice, resolveMisTradePrice } from '@/lib/datasource/TWSERealtime';

describe('findMisQuoteRow', () => {
  test('同時查上市與上櫃時跳過第一筆上市空殼，選到 3081 上櫃實際列', () => {
    const rows = [
      { c: '', z: '-', s: '-' },
      { c: '3081', ex: 'otc', d: '20260827', z: '3370.0000' },
    ];

    expect(findMisQuoteRow(rows, '3081')).toEqual(rows[1]);
  });

  test('兩個交易所都沒有該代號時回 undefined', () => {
    expect(findMisQuoteRow([{ c: '', z: '-' }], '3081')).toBeUndefined();
  });
});

describe('parseMisPrice', () => {
  test('valid price', () => {
    expect(parseMisPrice('481.0000')).toBe(481);
  });
  test('dash sentinel returns 0', () => {
    expect(parseMisPrice('-')).toBe(0);
  });
  test('empty / undefined returns 0', () => {
    expect(parseMisPrice('')).toBe(0);
    expect(parseMisPrice(undefined)).toBe(0);
  });
});

describe('parseMisBestPrice', () => {
  test('first non-zero token wins (skip 0.0000 placeholder)', () => {
    // 鎖漲停實況：d.b='0.0000_529.0000_528.0000_527.0000_526.0000_'
    // 首檔是「沒人賣（佔位 0）」，第二檔才是真實買單價
    expect(parseMisBestPrice('0.0000_529.0000_528.0000_527.0000_526.0000_')).toBe(529);
  });
  test('normal bid queue', () => {
    expect(parseMisBestPrice('4245.0000_4240.0000_4235.0000_')).toBe(4245);
  });
  test('all zeros / dashes returns 0', () => {
    expect(parseMisBestPrice('0.0000_0.0000_')).toBe(0);
    expect(parseMisBestPrice('-')).toBe(0);
    expect(parseMisBestPrice(undefined)).toBe(0);
  });
});

describe('resolveMisClose', () => {
  test('normal trading day: z is the latest match → use z', () => {
    const d = {
      z: '525.0000', o: '486.0000', h: '529.0000', l: '481.0000',
      b: '524.0000_523.0000_522.0000_', a: '525.0000_526.0000_527.0000_',
      u: '529.0000', w: '433.0000', y: '481.0000',
    };
    expect(resolveMisClose(d)).toBe(525);
  });

  test('limit-up locked (3044 2026-05-13 actual case): z=- + ask empty + h=u → use u', () => {
    // 完整 reproduce 5/13 11:40 mis.twse 對 3044 的回傳
    const d = {
      z: '-', o: '486.0000', h: '529.0000', l: '481.0000',
      a: '-',
      b: '0.0000_529.0000_528.0000_527.0000_526.0000_',
      u: '529.0000', w: '433.0000', y: '481.0000',
    };
    // 舊邏輯會 fallback 到 d.l=481（昨收），造成「假裝沒漲」假象
    // 新邏輯：h===u 且 ask 掃空 → 漲停價 529
    expect(resolveMisClose(d)).toBe(529);
  });

  test('limit-down locked: z=- + bid empty + l=w → use w', () => {
    const d = {
      z: '-', o: '481.0000', h: '481.0000', l: '433.0000',
      a: '0.0000_433.0000_434.0000_',
      b: '-',
      u: '529.0000', w: '433.0000', y: '481.0000',
    };
    expect(resolveMisClose(d)).toBe(433);
  });

  test('post-close / thin trading: z=- but bid+ask both present → mid price', () => {
    const d = {
      z: '-', o: '100.0000', h: '102.0000', l: '99.0000',
      b: '100.5000_100.0000_', a: '101.0000_101.5000_',
      u: '110.0000', w: '90.0000', y: '100.0000',
    };
    expect(resolveMisClose(d)).toBe(100.75);
  });

  test('real stock order-book midpoint is snapped to a legal provisional tick', () => {
    const d = {
      c: '6770', z: '-', o: '75.0000', h: '77.4000', l: '72.7000',
      b: '75.5000_', a: '75.6000_', u: '81.0000', w: '66.4000', y: '73.7000',
    };
    expect(resolveMisClose(d)).toBe(75.5);
  });

  test('only one side has a quote → use whichever exists', () => {
    expect(resolveMisClose({
      z: '-', h: '102.0000', l: '99.0000',
      b: '100.0000_', a: '-', u: '110.0000', w: '90.0000',
    })).toBe(100);
    expect(resolveMisClose({
      z: '-', h: '102.0000', l: '99.0000',
      b: '-', a: '101.0000_', u: '110.0000', w: '90.0000',
    })).toBe(101);
  });

  test('everything empty: fall back to high (not low)', () => {
    // 為什麼選 high 而非 low：鎖漲停場景 high 才是合理估計值，
    // 用 low 會在鎖漲停時把 close 寫成「今日最低 = 昨收」造成 0% 假象（原 bug）
    const d = {
      z: '-', h: '102.0000', l: '99.0000',
      b: '-', a: '-', u: '', w: '', y: '100.0000',
    };
    expect(resolveMisClose(d)).toBe(102);
  });

  test('no data at all returns 0 (caller should drop quote)', () => {
    expect(resolveMisClose({ z: '-' })).toBe(0);
  });

  test('regression: bug pattern from the original code must NOT recur', () => {
    // 鎖漲停時舊邏輯：z('-')=0 || b首檔(0.0000)=0 || l(481) → close=481（錯）
    // 新邏輯：close 必須 > prevClose（沒漲不可能鎖漲停）
    const d = {
      z: '-', o: '486.0000', h: '529.0000', l: '481.0000',
      a: '-', b: '0.0000_529.0000_528.0000_', u: '529.0000', y: '481.0000',
    };
    const close = resolveMisClose(d);
    expect(close).toBeGreaterThan(481); // 絕不可等於昨收
    expect(close).toBe(529);
  });
});

describe('resolveMisTradePrice', () => {
  test('uses z when the exchange reports an actual match', () => {
    expect(resolveMisTradePrice({ z: '74.8000' })).toBe(74.8);
  });

  test('does not turn the order-book midpoint into a fake K-bar close', () => {
    const d = {
      c: '6770', z: '-', o: '75.0000', h: '77.4000', l: '72.7000',
      b: '74.7000_74.6000_', a: '74.8000_74.9000_',
      u: '81.0000', w: '66.4000', y: '73.7000',
    };
    expect(resolveMisClose(d)).toBe(74.8); // indicative snapshot may still use a legal tick
    expect(resolveMisTradePrice(d)).toBe(0); // K bar must fall through to a real-trade provider
  });

  test('keeps locked limit prices as a reliable exception', () => {
    expect(resolveMisTradePrice({
      z: '-', h: '529.0000', l: '481.0000', a: '-', b: '529.0000_',
      u: '529.0000', w: '433.0000',
    })).toBe(529);
  });
});

describe('resolveMisIndicativePrice', () => {
  test('只有委買委賣雙邊都有價才產生合法檔位中價', () => {
    expect(resolveMisIndicativePrice({ c: '2330', b: '100.0000_', a: '101.0000_' })).toBe(100.5);
    expect(resolveMisIndicativePrice({ c: '2330', b: '100.0000_', a: '-' })).toBe(0);
    expect(resolveMisIndicativePrice({ c: '2330', b: '-', a: '101.0000_' })).toBe(0);
  });

  test('中價落在次檔位時會 snap 到台股合法檔位', () => {
    expect(resolveMisIndicativePrice({ c: '2330', b: '100.5000_', a: '101.0000_' })).toBe(101);
  });
});
