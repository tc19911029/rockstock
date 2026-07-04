/**
 * lib/agents/holdingsActionEngine.ts
 *
 * 書本訊號分派（優先順序）：
 *   1. today ≤ stopLoss            → stop_loss
 *   2. 跌破 MA20 + 漲幅 ≥ 20%        → exit_all（長線停利）
 *   3. 跌破 MA10 + 漲幅 ≥ 10%        → exit_all（中線停利）
 *   4. 跌破 MA5 + 漲幅 ≥ 10%         → reduce_half（短線停利）
 *   5. 距停損 < 3%                   → watch_stop
 *   6. entryGate=can_enter + 上 MA20 → can_add
 *   7. default                       → hold
 */

import { evaluateHolding } from '@/lib/agents/holdingsActionEngine';
import type { Candle } from '@/types';

function makeCandles(closes: number[]): Candle[] {
  const start = new Date('2026-01-01');
  return closes.map((c, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return { date: d.toISOString().slice(0, 10), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 10000 };
  });
}

describe('evaluateHolding', () => {
  it('today ≤ stopLoss → stop_loss', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 94 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('absolute_stop');
  });

  it('跌破 MA10 + 漲幅 ≥ 10% → exit_all（中線停利）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 1.0);
    const today = 113;
    closes.push(today);
    const candles = makeCandles(closes);
    const ma10 = candles.slice(-10).reduce((a, c) => a + c.close, 0) / 10;
    expect(today).toBeLessThan(ma10);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: today });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'break_ma10_mid')).toBe(true);
    expect(r.profitPct).toBeCloseTo(0.13, 2);
  });

  it('跌破 MA20 + 漲幅 ≥ 20% → exit_all（長線停利）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 1.5);
    const today = 122;
    closes.push(today);
    const candles = makeCandles(closes);
    const ma20 = candles.slice(-20).reduce((a, c) => a + c.close, 0) / 20;
    expect(today).toBeLessThan(ma20);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: today });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'break_ma20_long')).toBe(true);
  });

  it('跌破 MA5 + 漲幅 ≥ 10% (但 MA10 不破) → reduce_half', () => {
    const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 105, 110, 115, 120, 125, 130];
    closes.push(120);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 120 });
    expect(r.action).toBe('reduce_half');
    expect(r.signals.some(s => s.type === 'break_ma5_short')).toBe(true);
  });

  it('距停損 < 3% → watch_stop', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 99, candles, todayClose: 101 });
    expect(r.action).toBe('watch_stop');
  });

  it('回測 MA5 不破 + 漲幅 < 10% → can_add', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.1);
    closes.push(closes[closes.length - 1] * 1.02);
    const ma5Recent = (closes.slice(-5).reduce((a, b) => a + b, 0)) / 5;
    closes[closes.length - 1] = ma5Recent;
    const candles = makeCandles(closes);
    const today = closes[closes.length - 1];
    const r = evaluateHolding({ symbol: 'T', entryPrice: today * 0.97, stopLoss: today * 0.92, candles, todayClose: today });
    expect(r.action).toBe('can_add');
    expect(r.profitPct).toBeLessThan(0.10);
    expect(r.signals.some(s => s.type === 'pullback_ma5_ok')).toBe(true);
  });

  it('回測 MA5 不破但漲幅 ≥ 10% → hold（已過加碼點，不追高拉成本）', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.1);
    closes.push(closes[closes.length - 1] * 1.02);
    const ma5Recent = (closes.slice(-5).reduce((a, b) => a + b, 0)) / 5;
    closes[closes.length - 1] = ma5Recent;
    const candles = makeCandles(closes);
    const today = closes[closes.length - 1];
    const r = evaluateHolding({ symbol: 'T', entryPrice: today * 0.7, stopLoss: today * 0.65, candles, todayClose: today });
    expect(r.action).toBe('hold');
    expect(r.profitPct).toBeGreaterThanOrEqual(0.10);
    expect(r.signals.some(s => s.type === 'past_add_zone')).toBe(true);
  });

  it('賺 12%、未跌破任何均線、距 MA5 > 3% → hold + 停損上移到 MA10-0.5%', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(112);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 112 });
    expect(r.action).toBe('hold');
    expect(r.suggestedStop).toBeGreaterThan(95);
    expect(r.metrics.ma10).not.toBeNull();
    expect(r.suggestedStop).toBeCloseTo(r.metrics.ma10! * 0.995, 1);
  });

  it('賺 25%、未破任何均線 → hold + 停損上移到 MA20-0.5%（鎖長線）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const today = 130;
    closes.push(today);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: today });
    expect(['hold', 'can_add']).toContain(r.action);
    expect(r.suggestedStop).toBeGreaterThan(95);
    expect(r.suggestedStop).toBeCloseTo(r.metrics.ma20! * 0.995, 0);
  });

  it('停損優先於停利訊號（跌破停損即使 MA 看似 OK）', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 105, candles, todayClose: 100 });
    expect(r.action).toBe('stop_loss');
  });

  // 賠少-2：跌幅 >10% 強制停損（獨立於固定價 stopLoss）
  it('跌幅 >10% → 即使固定停損更寬也強制 stop_loss', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    // 固定停損設很寬（80），但跌幅 11% 仍強制停損
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 80, candles, todayClose: 89 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('hard_stop_10pct');
  });

  // 賠少-16：當日帳上虧損 >5% → watch_stop（與 near_stop 並存，不剔除）
  it('帳上虧損 >5% → watch_stop（loss_over_5pct）', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    // 跌 7%（未破 10% 硬停損、固定停損設很寬）
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 80, candles, todayClose: 93 });
    expect(r.action).toBe('watch_stop');
    expect(r.signals.some(s => s.type === 'loss_over_5pct')).toBe(true);
  });

  // 賠少-10（2026-07-04 體檢補接）：跌破進場K線低點=生死線 → 硬停損
  it('跌破進場K線低點 → stop_loss（entry_kline_low_break，比 -10% 更早觸發）', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    // 固定停損設很寬（80）、跌幅只 -2.5% 未觸硬停損，但已破進場K低點 98
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 80, candles, todayClose: 97.5, entryKlineLow: 98 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('entry_kline_low_break');
  });

  it('entryKlineLow 缺值 → 行為不變（同輸入走 watch/hold）', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 80, candles, todayClose: 97.5 });
    expect(r.action).not.toBe('stop_loss');
  });

  // 課程 CH10-1（2026-07-04）：當日跌幅 >5% → watch_stop（day_drop_over_5pct，當日跌幅口徑）
  it('獲利中但當日跌 >5% → watch_stop（day_drop_over_5pct）', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    closes.push(94); // 今日 100 → 94 = -6%
    const candles = makeCandles(closes);
    // entry 88 → 帳上還賺 6.8%（不觸 loss_over_5pct），純粹當日重挫
    const r = evaluateHolding({ symbol: 'T', entryPrice: 88, stopLoss: 80, candles, todayClose: 94 });
    expect(r.action).toBe('watch_stop');
    expect(r.signals.some(s => s.type === 'day_drop_over_5pct')).toBe(true);
    expect(r.signals.some(s => s.type === 'loss_over_5pct')).toBe(false);
  });

  // 課程 CH10-1（2026-07-04）：套牢分級附加訊號（action 不變、signals 增量）
  it('賠損 10-20%（陰跌無反彈）→ stop_loss + trapped_flag 附註', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 70, candles, todayClose: 85 });
    expect(r.action).toBe('stop_loss'); // 硬停損主建議不變
    expect(r.signals[0].type).toBe('hard_stop_10pct');
    expect(r.signals.some(s => s.type === 'trapped_flag')).toBe(true);
  });

  it('賠損 >20% → stop_loss + 深套三條路附註', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 60, candles, todayClose: 75 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals.some(s => s.type === 'trapped_deep_three_paths')).toBe(true);
  });

  it('賠損 10-20% + 反彈遇壓不漲 → trapped_rebound_stall（high）附註', () => {
    const closes = [
      ...Array.from({ length: 20 }, () => 100),
      96, 92, 88, 84, 80,
      84, 89, 93.5,      // 反彈觸 MA20 被壓回
      90, 89, 88,        // 3 日未創反彈新高
    ];
    const candles = makeCandles(closes);
    // entry 104 → today 88 = -15.4%
    const r = evaluateHolding({ symbol: 'T', entryPrice: 104, stopLoss: 70, candles, todayClose: 88 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals.some(s => s.type === 'trapped_rebound_stall' && s.severity === 'high')).toBe(true);
  });

  // 課程 CH9-3(二)(三)（2026-07-04）：爆量反轉 獲利>15% 先停利1/2、次日下跌全出
  it('獲利 19% + 爆量長上影未破昨低 → reduce_half（ch9_partial_tp_half）', () => {
    const candles = makeCandles(Array.from({ length: 28 }, () => 100));
    // 昨日：大紅 K（100 → 118）
    candles.push({ date: '2026-02-10', open: 100, high: 118.5, low: 99.8, close: 118, volume: 10000 });
    // 今日：爆量長上影（高 130 收 119，上影 88% 全長）、未破昨低
    candles.push({ date: '2026-02-11', open: 118, high: 130, low: 117.5, close: 119, volume: 30000 });
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: 119 });
    expect(r.profitPct).toBeCloseTo(0.19, 2);
    expect(r.action).toBe('reduce_half');
    expect(r.signals.some(s => s.type === 'ch9_partial_tp_half')).toBe(true);
  });

  it('訊號日次日下跌 → exit_all（ch9_exit_remaining）', () => {
    const candles = makeCandles(Array.from({ length: 28 }, () => 100));
    candles.push({ date: '2026-02-10', open: 100, high: 118.5, low: 99.8, close: 118, volume: 10000 });
    candles.push({ date: '2026-02-11', open: 118, high: 130, low: 117.5, close: 119, volume: 30000 }); // 昨日=訊號日
    candles.push({ date: '2026-02-12', open: 118, high: 118.5, low: 115.5, close: 116, volume: 10000 }); // 今日下跌
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: 116 });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'ch9_exit_remaining')).toBe(true);
  });

  it('訊號日次日上漲 → 不觸發 ch9 全出（續抱跟均線）', () => {
    const candles = makeCandles(Array.from({ length: 28 }, () => 100));
    candles.push({ date: '2026-02-10', open: 100, high: 118.5, low: 99.8, close: 118, volume: 10000 });
    candles.push({ date: '2026-02-11', open: 118, high: 130, low: 117.5, close: 119, volume: 30000 });
    candles.push({ date: '2026-02-12', open: 119.5, high: 122.5, low: 119, close: 122, volume: 10000 }); // 今日上漲
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: 122 });
    expect(r.signals.some(s => s.type === 'ch9_exit_remaining')).toBe(false);
    expect(r.action).not.toBe('exit_all');
  });

  // 賠少-11：飆股獲利 >20% + 爆量黑K → reduce_half
  it('獲利 >20% + 爆量黑K → reduce_half（blowoff_black_reduce）', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 1.0); // 緩升，避免破均線
    const candles = closes.map((c, i) => {
      const d = new Date('2026-01-01'); d.setDate(d.getDate() + i);
      return { date: d.toISOString().slice(0, 10), open: c, high: c * 1.005, low: c * 0.995, close: c, volume: 10000 };
    });
    // 今日：高開收黑（爆量黑K），收盤仍 >MA5/MA10/MA20 且漲幅 >20%
    const prevClose = closes[closes.length - 1]; // 129
    const todayOpen = prevClose + 5;
    const todayClose = prevClose - 1; // 收黑
    candles.push({ date: '2026-02-15', open: todayOpen, high: todayOpen + 1, low: todayClose - 1, close: todayClose, volume: 50000 });
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose });
    expect(r.profitPct).toBeGreaterThanOrEqual(0.20);
    expect(r.action).toBe('reduce_half');
    expect(r.signals.some(s => s.type === 'blowoff_black_reduce')).toBe(true);
  });
});

// 賠少-1：做空 live 風控分支（positionSide==='short'）。long 部位完全不受影響。
describe('evaluateHolding — 做空分支（positionSide=short）', () => {
  it('收盤站上進場黑K最高點 → stop_loss（回補）', () => {
    // 空頭走勢但今日反彈站上 entryHigh → 回補停損
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
    closes.push(90); // today 反彈
    const candles = makeCandles(closes);
    const r = evaluateHolding({
      symbol: 'S', entryPrice: 88, stopLoss: 999, candles, todayClose: 90,
      positionSide: 'short', entryHigh: 89,
    });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('short_stop_cover');
    // 做空虧損：進場 88 → 反彈到 90，profitPct = (88-90)/88 < 0
    expect(r.profitPct).toBeLessThan(0);
  });

  it('做空獲利反向計算：進場 100、現價 90 → profitPct +10%', () => {
    const closes = Array.from({ length: 31 }, (_, i) => 100 - i * 0.3);
    const candles = makeCandles(closes);
    const r = evaluateHolding({
      symbol: 'S', entryPrice: 100, stopLoss: 999, candles, todayClose: 90,
      positionSide: 'short', entryHigh: 110, // 未觸發回補停損
    });
    expect(r.profitPct).toBeCloseTo(0.10, 2);
    expect(['hold', 'watch_stop', 'cover_all']).toContain(r.action);
  });

  it('entryHigh 缺值 → fallback 用 stopLoss 當回補價', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    const candles = makeCandles(closes);
    const r = evaluateHolding({
      symbol: 'S', entryPrice: 95, stopLoss: 100, candles, todayClose: 100,
      positionSide: 'short',
    });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('short_stop_cover');
  });

  it('long 部位（缺省 positionSide）行為位元不變 — 同輸入仍走做多停損', () => {
    const candles = makeCandles(Array.from({ length: 30 }, () => 100));
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 94 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals[0].type).toBe('absolute_stop'); // 做多路徑，不是 short_stop_cover
  });
});
