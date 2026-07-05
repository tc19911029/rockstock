/**
 * 合約測試 — 籌碼型避雷訊號（買進前別踩雷，2026-06-14）
 *
 * 鎖定 3 個 grid 驗證過的避雷紅旗的觸發邏輯（單一事實 lib/avoidance/chipAvoidSignals）：
 *   ① 大戶持股超高 ② 假集中度(集中度高但法人賣) ③ 爆量長黑破月線且法人沒接
 *   + 門檻凍結不可漂走。
 */
import {
  computeChipAvoidSignals,
  CHIP_AVOID_PARAMS,
  type AvoidCandle,
} from '@/lib/avoidance/chipAvoidSignals';

function flatCandles(n: number, close = 100): AvoidCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    open: close, high: close, low: close, close, volume: 1000,
  }));
}
function holderRow(date: string, h: { h100?: number; h400?: number; h1000?: number }) {
  return { date, holder100Pct: h.h100, holder400Pct: h.h400, holder1000Pct: h.h1000 };
}

describe('籌碼避雷 — 門檻凍結', () => {
  it('CHIP_AVOID_PARAMS 維持凍結值（改動要先重跑 factor-grid-search）', () => {
    expect(CHIP_AVOID_PARAMS.holderHighPct).toEqual({ h100: 88, h400: 86, h1000: 80 });
    expect(CHIP_AVOID_PARAMS.fakeConcMin).toBe(3);
    expect(CHIP_AVOID_PARAMS.blackKpct).toBe(-3);
    expect(CHIP_AVOID_PARAMS.volSpikeX).toBe(2);
  });
});

describe('籌碼避雷 — ① 大戶持股超高', () => {
  it('便宜股(<50) 千張大戶 > 80% → 紅旗', () => {
    const candles = flatCandles(25, 30);
    const r = computeChipAvoidSignals({
      price: 30, candles,
      holderRows: [holderRow('2026-04-25', { h1000: 82 })],
      brokerByDate: new Map(), instByDate: new Map(),
    });
    expect(r.flags.some(f => f.key === 'holder_too_high')).toBe(true);
  });

  it('高價股(≥250) 看百張，千張高沒用 → 不亂報', () => {
    const candles = flatCandles(25, 3000);
    const r = computeChipAvoidSignals({
      price: 3000, candles,
      holderRows: [holderRow('2026-04-25', { h100: 60, h1000: 95 })], // 百張只60%
      brokerByDate: new Map(), instByDate: new Map(),
    });
    expect(r.flags.some(f => f.key === 'holder_too_high')).toBe(false);
  });
});

describe('籌碼避雷 — ② 假集中度', () => {
  it('主力分點5日集中度>3% 但法人在賣 → 紅旗', () => {
    const candles = flatCandles(25, 100);
    const broker = new Map(candles.map(c => [c.date, 100])); // 5日Σ=500, vol5=5000 → 10%
    const inst = new Map(candles.map(c => [c.date, -50]));   // 法人在賣
    const r = computeChipAvoidSignals({ price: 100, candles, holderRows: [], brokerByDate: broker, instByDate: inst });
    expect(r.flags.some(f => f.key === 'fake_concentration')).toBe(true);
  });

  it('集中度高但法人也在買 → 不算假集中', () => {
    const candles = flatCandles(25, 100);
    const broker = new Map(candles.map(c => [c.date, 100]));
    const inst = new Map(candles.map(c => [c.date, 50])); // 法人也買
    const r = computeChipAvoidSignals({ price: 100, candles, holderRows: [], brokerByDate: broker, instByDate: inst });
    expect(r.flags.some(f => f.key === 'fake_concentration')).toBe(false);
  });
});

describe('籌碼避雷 — ③ 爆量長黑破月線', () => {
  it('長黑+爆量+破月線+法人沒接 → 紅旗', () => {
    const candles = flatCandles(24, 100);
    // 今日：開100收95(-5%)、量3000(>2倍均量1000)、收95<MA20≈100
    candles.push({ date: '2026-04-25', open: 100, high: 100, low: 94, close: 95, volume: 3000 });
    const inst = new Map(candles.map(c => [c.date, -10])); // 法人沒接
    const r = computeChipAvoidSignals({ price: 95, candles, holderRows: [], brokerByDate: new Map(), instByDate: inst });
    expect(r.flags.some(f => f.key === 'volume_black_breakdown')).toBe(true);
  });

  it('一樣長黑爆量破線，但法人逆勢接 → 不報（差在法人站哪邊）', () => {
    const candles = flatCandles(24, 100);
    candles.push({ date: '2026-04-25', open: 100, high: 100, low: 94, close: 95, volume: 3000 });
    const inst = new Map(candles.map(c => [c.date, 200])); // 法人大買接刀
    const r = computeChipAvoidSignals({ price: 95, candles, holderRows: [], brokerByDate: new Map(), instByDate: inst });
    expect(r.flags.some(f => f.key === 'volume_black_breakdown')).toBe(false);
  });
});

describe('籌碼避雷 — ④ 高檔法人連賣（課程淘汰法13 / R8，backtest-inst-sell-avoid 驗證）', () => {
  function risingCandles(n: number): AvoidCandle[] {
    return Array.from({ length: n }, (_, i) => {
      const close = 100 + i * 0.6; // 60 根 +36%，收在近高
      const date = `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
      return { date, open: close - 0.3, high: close + 0.2, low: close - 0.5, close, volume: 1000 };
    });
  }

  it('高檔 + 法人連賣 3 天 → 紅旗', () => {
    const candles = risingCandles(70);
    const inst = new Map(candles.map((c, i) => [c.date, i >= 67 ? -50 : 100])); // 最後 3 天連賣
    const r = computeChipAvoidSignals({ price: 140, candles, holderRows: [], brokerByDate: new Map(), instByDate: inst });
    expect(r.flags.some(f => f.key === 'inst_sell_streak_high')).toBe(true);
  });

  it('連賣 3 天但股價不在高檔（平盤）→ 不報', () => {
    const candles = flatCandles(28, 100).concat(
      Array.from({ length: 42 }, (_, i) => ({
        date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}-x${i}`.slice(0, 10),
        open: 100, high: 100, low: 100, close: 100, volume: 1000,
      })),
    );
    // 用序號保證日期唯一
    candles.forEach((c, i) => { c.date = `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`; });
    const inst = new Map(candles.map((c, i) => [c.date, i >= candles.length - 3 ? -50 : 100]));
    const r = computeChipAvoidSignals({ price: 100, candles, holderRows: [], brokerByDate: new Map(), instByDate: inst });
    expect(r.flags.some(f => f.key === 'inst_sell_streak_high')).toBe(false);
  });

  it('高檔但只連賣 2 天 → 不報（門檻 3 天）', () => {
    const candles = risingCandles(70);
    const inst = new Map(candles.map((c, i) => [c.date, i >= 68 ? -50 : 100]));
    const r = computeChipAvoidSignals({ price: 140, candles, holderRows: [], brokerByDate: new Map(), instByDate: inst });
    expect(r.flags.some(f => f.key === 'inst_sell_streak_high')).toBe(false);
  });
});
