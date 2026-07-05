/**
 * CH8 8-5 三條均線分批出場 — 單元測試
 *
 * 驗證課程規則：跌破 MA5/10/20 各出 1/3、站回各買 1/3、−5% 停損、賺>20% 跌破 MA5 全出、
 * 排列非多排只擋買回（2026-07-05 巡邏修：賣出階梯不受排列 gate 影響）、資料不足不誤判。
 */

import type { CandleWithIndicators } from '../types';
import { computePartialExitState } from '../lib/sell/v12PartialExit';

function mk(closes: number[]): CandleWithIndicators[] {
  return closes.map((c, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    open: c, high: c, low: c, close: c, volume: 1000,
  }));
}

describe('CH8 8-5 分批出場 computePartialExitState（做多）', () => {
  test('穩定上升：進場後一路漲 → 永遠滿倉 3 份、不出場、無賣出動作', () => {
    const up = mk(Array.from({ length: 30 }, (_, i) => 100 + i));
    const s = computePartialExitState(up, 20, up[20].close, 'long');
    expect(s.unitsHeld).toBe(3);
    expect(s.ended).toBe(false);
    expect(s.ladder.some(l => l.action === 'sell-third')).toBe(false);
  });

  test('回檔階梯：收盤逐步跌破 MA5 → MA10 → 份數 3→2→1', () => {
    // 上升建立多頭排列（MA5>MA10>MA20），進場後小幅回檔但「未觸 −5% 停損」
    const closes = Array.from({ length: 25 }, (_, i) => 200 + i * 4); // 200..296
    closes.push(290, 286, 283); // 溫和回檔（離進場價 <5%）
    const cs = mk(closes);
    const entryIdx = 24;
    const s = computePartialExitState(cs, entryIdx, cs[entryIdx].close, 'long');
    // 進場後份數應呈非遞增的分批出（出現至少一次 sell-third）
    expect(s.ladder.some(l => l.action === 'sell-third')).toBe(true);
    expect(s.unitsHeld).toBeLessThan(3);
    expect(s.unitsHeld).toBeGreaterThanOrEqual(0);
  });

  test('−5% 停損：收盤跌破進場價 5% → 全部出場、endReason=stop-loss', () => {
    const sc = Array.from({ length: 22 }, (_, i) => 100 + i * 2);
    sc.push(sc[21] * 0.93); // 大跌一根 −7%
    const cs = mk(sc);
    const s = computePartialExitState(cs, 20, cs[20].close, 'long');
    expect(s.ended).toBe(true);
    expect(s.endReason).toBe('stop-loss');
    expect(s.unitsHeld).toBe(0);
  });

  test('賺>20% 且跌破 MA5 → 總停利全出、endReason=full-take-profit', () => {
    const tpc = [100, ...Array.from({ length: 20 }, (_, i) => 100 + (i + 1) * 1.5)]; // 升至約 130 (+30%)
    tpc.push(tpc[tpc.length - 1] * 0.97); // 跌破 MA5 一根
    const cs = mk(tpc);
    const s = computePartialExitState(cs, 0, 100, 'long');
    expect(s.ended).toBe(true);
    expect(s.endReason).toBe('full-take-profit');
    expect(s.unitsHeld).toBe(0);
  });

  test('資料不足：進場日前歷史 <19 根 → 不誤判趨勢破壞、不強制出場', () => {
    const cs = mk(Array.from({ length: 10 }, (_, i) => 100 + i)); // 只有 10 根
    const s = computePartialExitState(cs, 2, cs[2].close, 'long');
    expect(s.endReason).not.toBe('trend-broken');
    // 資料不足時持平不動（不應出現分批賣）
    expect(s.ladder.every(l => l.action !== 'sell-third')).toBe(true);
  });

  test('站回買回：跌破後股價重新站上均線 → 出現 buy-third 加回', () => {
    // 升 → 淺回檔跌破 MA5（不觸 −5% 停損，進場價 644）→ 再強彈站回
    const closes = Array.from({ length: 25 }, (_, i) => 500 + i * 6); // 200..644 多頭排列
    const entryIdx = 24; // 進場價 644，停損線 ≈ 611.8
    closes.push(630, 690); // 630 跌破 MA5(≈634) 出 1/3；690 站回 → 買回 1/3
    const cs = mk(closes);
    const s = computePartialExitState(cs, entryIdx, cs[entryIdx].close, 'long');
    expect(s.ladder.some(l => l.action === 'buy-third')).toBe(true);
  });
});

describe('CH8 8-5 排列 gate 只擋買回（2026-07-05 巡邏修）', () => {
  test('緩跌至排列破壞：賣出階梯照走、不再 trend-broken 全出', () => {
    // 進場 596 後緩跌（不觸 −5% 停損 566.2）：跌破 MA5 → MA10 逐步出，
    // 末段 MA5 下穿 MA10（排列破壞）— 舊版此時 exit-all，新版照階梯持有
    const closes = Array.from({ length: 25 }, (_, i) => 500 + i * 4); // 500..596
    closes.push(590, 586, 584, 582, 580);
    const cs = mk(closes);
    const s = computePartialExitState(cs, 24, cs[24].close, 'long');
    expect(s.ended).toBe(false);
    expect(s.endReason).toBeNull();
    expect(s.ladder.every(l => l.action !== 'exit-all')).toBe(true);
    // 階梯有分批出（至少兩次 sell-third：破 MA5、破 MA10）
    expect(s.ladder.filter(l => l.action === 'sell-third').length).toBeGreaterThanOrEqual(2);
    expect(s.unitsHeld).toBeLessThan(3);
  });
});

describe('CH8 8-5 分批出場（做空鏡像）', () => {
  test('穩定下跌：進場放空後一路跌 → 滿倉 3 份、無回補', () => {
    const down = mk(Array.from({ length: 30 }, (_, i) => 300 - i * 3));
    const s = computePartialExitState(down, 20, down[20].close, 'short');
    expect(s.unitsHeld).toBe(3);
    expect(s.ladder.some(l => l.action === 'sell-third')).toBe(false);
  });
});
