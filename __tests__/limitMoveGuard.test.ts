import { suspectsLimitOverwrite, suspectsGrossJump, limitPctFor, isTwListingTransition } from '@/lib/datasource/limitMoveGuard';

describe('limitMoveGuard', () => {
  describe('limitPctFor', () => {
    test('CN ChiNext (300xxx) is 20%', () => {
      expect(limitPctFor('CN', '300100')).toBeCloseTo(0.198, 4);
      expect(limitPctFor('CN', '301100')).toBeCloseTo(0.198, 4);
    });
    test('CN STAR (688xxx) is 20%', () => {
      expect(limitPctFor('CN', '688100')).toBeCloseTo(0.198, 4);
    });
    test('CN main board is 10%', () => {
      expect(limitPctFor('CN', '600100')).toBeCloseTo(0.098, 4);
      expect(limitPctFor('CN', '000100')).toBeCloseTo(0.098, 4);
    });
    test('TW is 10%', () => {
      expect(limitPctFor('TW', '2330')).toBeCloseTo(0.098, 4);
    });
  });

  describe('suspectsLimitOverwrite', () => {
    // 場景 1：2486.TW 04-29 真實案例（漲停 close 被低點覆寫）
    test('TW limit-up close-overwrite (2486.TW 04-29)', () => {
      const prev = 230.5;
      const q = { open: 223, high: 253.5, low: 222, close: 222 };
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2486')).toBe(true);
    });

    // 場景 2：合法漲停一字 (open=high=low=close)
    test('legitimate one-shot limit-up (一字漲停)', () => {
      const prev = 100;
      const q = { open: 110, high: 110, low: 110, close: 110 };
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(false);
    });

    // 場景 3：漲停打開後維持高位收 (close at 98% of high)
    test('limit-up briefly opened, close near high', () => {
      const prev = 100;
      const q = { open: 105, high: 110, low: 104, close: 108 };
      // close=108 vs high=110，close/high=98.18% > 97% → 不算污染
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(false);
    });

    // 場景 4：跌停 close 被反彈 tick 覆寫（鏡像）
    test('TW limit-down close-overwrite mirror', () => {
      const prev = 100;
      const q = { open: 95, high: 95, low: 90, close: 96 }; // close 偏離 low > 3%
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(true);
    });

    // 場景 5：CN 創業板 +20% 漲停
    test('CN ChiNext 20% limit-up overwrite', () => {
      const prev = 50;
      const q = { open: 55, high: 60, low: 54, close: 54 }; // limit=60, close 偏離 high 10%
      expect(suspectsLimitOverwrite(prev, q, 'CN', '300100')).toBe(true);
    });

    // 場景 6：CN 主板 +10% 不應誤判 ChiNext +20%
    test('CN main board uses 10% not 20%', () => {
      const prev = 100;
      const q = { open: 105, high: 110, low: 104, close: 105 }; // limit=110 (10%)
      // close 105 vs high 110，差 4.5%，且 hit limit → 應該 true
      expect(suspectsLimitOverwrite(prev, q, 'CN', '600100')).toBe(true);
    });

    // 場景 7：未觸及漲跌停（普通日內波動）
    test('non-limit day not flagged', () => {
      const prev = 100;
      const q = { open: 102, high: 105, low: 99, close: 100 }; // high 5% < limit 10%
      expect(suspectsLimitOverwrite(prev, q, 'TW', '2330')).toBe(false);
    });

    // 場景 8：prevClose 缺失或 0
    test('missing prevClose returns false (no data → no skip)', () => {
      const q = { open: 100, high: 110, low: 100, close: 100 };
      expect(suspectsLimitOverwrite(null, q, 'TW', '2330')).toBe(false);
      expect(suspectsLimitOverwrite(0, q, 'TW', '2330')).toBe(false);
      expect(suspectsLimitOverwrite(undefined, q, 'TW', '2330')).toBe(false);
    });
  });

  describe('suspectsGrossJump', () => {
    // 真實案例：000001.SS 上證指數值(4075)撞庫寫進 000001.SZ 平安銀行(前收 10.99)
    test('detects index-collision gross jump (000001.SZ 10.99→4075)', () => {
      expect(suspectsGrossJump(10.99, { open: 4061.46, high: 4089.57, low: 4032.58, close: 4075.1 })).toBe(true);
    });
    // 壞跌(penny 股 -89%)也擋下 → 改走 API 拿正確值
    test('detects gross bad drop (1.87→0.19, -89%)', () => {
      expect(suspectsGrossJump(1.87, { open: 0.19, high: 0.2, low: 0.18, close: 0.19 })).toBe(true);
    });
    // 合法單日波動全部不誤判：漲跌停 ±10/20%、高息除息、近 50% 崩跌
    test('does NOT flag legit single-day moves', () => {
      expect(suspectsGrossJump(10.99, { open: 11, high: 11.1, low: 10.9, close: 11.08 })).toBe(false); // 平安正常
      expect(suspectsGrossJump(100, { open: 110, high: 110, low: 110, close: 110 })).toBe(false);       // TW 漲停 +10%
      expect(suspectsGrossJump(100, { open: 120, high: 120, low: 120, close: 120 })).toBe(false);       // 創業板 +20%
      expect(suspectsGrossJump(100, { open: 82, high: 85, low: 80, close: 82 })).toBe(false);           // 高息除息 -18%
      expect(suspectsGrossJump(100, { open: 51, high: 60, low: 51, close: 51 })).toBe(false);           // -49%(剛好不到 50%)
    });
    test('missing/zero prevClose or close returns false', () => {
      const q = { open: 100, high: 100, low: 100, close: 100 };
      expect(suspectsGrossJump(null, q)).toBe(false);
      expect(suspectsGrossJump(0, q)).toBe(false);
      expect(suspectsGrossJump(undefined, q)).toBe(false);
      expect(suspectsGrossJump(100, { open: 0, high: 0, low: 0, close: 0 })).toBe(false);
    });
  });

  describe('isTwListingTransition', () => {
    it('放行興櫃轉上市首日的官方價量制度切換', () => {
      expect(isTwListingTransition(
        '7855.TW',
        { open: 81.73, high: 85.5, low: 81.7, close: 82, volume: 73 },
        { open: 44, high: 45, low: 42, close: 43.75, volume: 13129 },
      )).toBe(true);
    });

    it('不因一般大跌爆量就放行 off-grid 官方候選', () => {
      expect(isTwListingTransition(
        '2330.TW',
        { open: 1000, high: 1010, low: 990, close: 1000, volume: 1000 },
        { open: 400.25, high: 410, low: 390, close: 400, volume: 100000 },
      )).toBe(false);
    });
  });
});
