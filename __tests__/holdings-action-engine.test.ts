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

import { evaluateHolding, evaluateOperationMaExit } from '@/lib/agents/holdingsActionEngine';
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
  test('rejects a zero reference cost instead of returning Infinity', () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 100 + i));
    expect(() => evaluateHolding({
      symbol: 'T',
      entryPrice: 0,
      stopLoss: 0,
      candles,
      todayClose: candles[candles.length - 1].close,
    })).toThrow('entryPrice must be a finite number greater than 0');
  });

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

  it('跌破 MA5 + 漲幅 10~20% (但 MA10 不破) → reduce_half', () => {
    const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 105, 110, 115, 120, 125, 130];
    closes.push(120);
    const candles = makeCandles(closes);
    // 2026-07-05：entry 107 → 獲利 12.1%（<20%），走 reduce_half；≥20% 由下一條測全出
    const r = evaluateHolding({ symbol: 'T', entryPrice: 107, stopLoss: 95, candles, todayClose: 120 });
    expect(r.action).toBe('reduce_half');
    expect(r.signals.some(s => s.type === 'break_ma5_short')).toBe(true);
  });

  // 課程 CH8-4/8-5（2026-07-05 忠實度修）：賺 >20% 收盤跌破 MA5 → 全部停利
  it('賺 ≥20% + 跌破 MA5 → exit_all（break_ma5_high_profit）', () => {
    const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
                    100, 100, 100, 100, 105, 110, 115, 120, 125, 130];
    closes.push(120);
    const candles = makeCandles(closes);
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 95, candles, todayClose: 120 });
    expect(r.profitPct).toBeGreaterThanOrEqual(0.20);
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'break_ma5_high_profit')).toBe(true);
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

describe('evaluateOperationMaExit — 課程操作模式', () => {
  it('長線模式只守 MA20：跌破 MA10 但仍在 MA20 上不出場', () => {
    const candles = makeCandles([
      ...Array.from({ length: 20 }, () => 90),
      ...Array.from({ length: 9 }, () => 110),
      105,
    ]);
    const r = evaluateOperationMaExit({
      candles, index: candles.length - 1, entryPrice: 90,
      triggerSignal: 'B', operationMode: 'long',
    });
    expect(r?.maName).toBe('MA20');
    expect(r?.shouldExit).toBe(false);
  });

  it('長線模式跌破 MA20 → 正式 exit_all', () => {
    const candles = makeCandles([...Array.from({ length: 29 }, () => 110), 100]);
    const r = evaluateHolding({
      symbol: 'T', entryPrice: 100, stopLoss: 80, candles, todayClose: 100,
      triggerSignal: 'B', operationMode: 'long', entryDate: candles[0].date,
    });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'break_operation_ma20')).toBe(true);
  });

  it('B 短線進場後盤中曾觸及 +10%，今日破 MA5 即全出，即使收盤已低於 +10%', () => {
    const candles = makeCandles([...Array.from({ length: 29 }, () => 108), 105]);
    candles[20].high = 111;
    const r = evaluateOperationMaExit({
      candles, index: candles.length - 1, entryPrice: 100,
      entryDate: candles[0].date, triggerSignal: 'B', operationMode: 'short',
    });
    expect(r?.touchedTenPct).toBe(true);
    expect(r?.maName).toBe('MA5');
    expect(r?.shouldExit).toBe(true);
  });

  it('B 短線從未觸及 +10% 且目前不足 +10%，單獨破 MA5 不出場', () => {
    const candles = makeCandles([...Array.from({ length: 29 }, () => 108), 105]);
    const r = evaluateOperationMaExit({
      candles, index: candles.length - 1, entryPrice: 100,
      entryDate: candles[0].date, triggerSignal: 'B', operationMode: 'short',
    });
    expect(r?.touchedTenPct).toBe(false);
    expect(r?.shouldExit).toBe(false);
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

// 2026-07-05 課程忠實度巡邏（CH7-3 / CH9-3 順序修）
describe('evaluateHolding — 巡邏批（趨勢翻空提早出場 / 吞噬全出順序）', () => {
  it('課程 CH7-3：趨勢翻空（頭頭低底底低）→ 未到停損價也 stop_loss（trend_bearish_exit）', () => {
    // 下降 zigzag：H120 → L104 → H116（頭頭低）→ L96（底底低）→ H108 → 今日 92
    const closes = [
      100, 104, 108, 112, 116, 120,
      116, 112, 108, 104,
      108, 112, 116,
      112, 108, 104, 100, 96,
      100, 104, 108,
      104, 100, 96, 92,
    ];
    const candles = makeCandles(closes);
    // 停損 85、今日 92：固定停損 / -10% 硬停損（90）都沒到 → 之前會顯示續抱
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 85, candles, todayClose: 92 });
    expect(r.action).toBe('stop_loss');
    expect(r.signals.some(s => s.type === 'trend_bearish_exit')).toBe(true);
  });

  it('課程 CH9-3 順序修：獲利 ≥20% 高檔爆量長黑吞噬 → exit_all（不被賠少-11 降級成減半）', () => {
    const closes = Array.from({ length: 29 }, (_, i) => 100 + i * 1.2); // 一路漲到 ~133.6
    const candles = makeCandles(closes);
    // 昨日紅K
    const prev = candles[candles.length - 1];
    prev.open = 130; prev.close = 133.6; prev.high = 134; prev.low = 129.8;
    // 今日爆量長黑吞噬（開高 > 昨收、收 < 昨開、未破昨低、量 3 倍）
    candles.push({ date: '2026-02-01', open: 134.5, high: 135, low: 129.8, close: 129.85, volume: 30000 });
    const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: 129.85 });
    expect(r.action).toBe('exit_all');
    expect(r.signals.some(s => s.type === 'ch9_engulf_exit_all')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════
  // 第七輪（2026-07-20）：課程出場訊號接上 daily-action 推播鏈
  //   病根＝detectSellSignals 只餵走圖面板，推播讀不到 → 走圖亮紅字、推播說「續抱」。
  // ══════════════════════════════════════════════════════════════
  describe('課程出場訊號接推播鏈（第七輪）', () => {
    it('CH8-3(5)：獲利未達 10% + 頭頭低 + 跌破 MA5 → exit_all（不再一路續抱到硬停損）', () => {
      // 結構：高點 120（idx10）→ 回檔 → 緩升到較低高點 116（idx28）→ 今日收 108 首破該高點。
      // idx11~27 刻意做成「高點嚴格遞增」，中間不會產生假 pivot；
      // 低點一路墊高（底底高）→ detectTrend 不會判空頭，確保測到的是新分支而非 trend_bearish_exit。
      // ⚠️ 前波低點刻意壓到 104（低於今日 108）：只有頭頭低、沒有底底低，
      //    否則 detectTrend 會判空頭、被更早的 trend_bearish_exit 接走，測不到本分支。
      const closes = [
        100, 102, 104, 106, 108, 110, 112, 114, 116, 118, // 0-9
        119,                                              // 10 = 較高的頭（high 120）
        106, 104,                                         // 11-12 回檔（前波低 104）
        105, 105.7, 106.4, 107.1, 107.8, 108.5, 109.2,    // 13-19 緩升
        109.9, 110.6, 111.3, 112, 112.7, 113.4, 114.1, 114.8, // 20-27
        115.5,                                            // 28 = 較低的頭（high 116 < 120）
        108,                                              // 29 = 今日，首次收破 116；仍高於前波低 104
      ];
      const candles = makeCandles(closes);
      candles[10].high = 120;
      candles[28].high = 116;
      candles[29].high = 110; // 今日高點低於 idx28 → idx28 成立為 pivot high
      const today = 108;

      const r = evaluateHolding({ symbol: 'T', entryPrice: 105, stopLoss: 96, candles, todayClose: today });

      // 獲利僅 +2.9%：舊行為會落到 watch_stop/hold（課程要求出場）
      expect(r.profitPct).toBeLessThan(0.10);
      expect(r.action).toBe('exit_all');
      expect(r.signals.some(s => s.type === 'ch8_lower_high_break_ma5')).toBe(true);
    });

    it('頭頭低但收盤仍在 MA5 之上 → 不觸發（課程要「跌破 MA5」才走）', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
      const candles = makeCandles(closes);
      const today = closes[closes.length - 1];
      const r = evaluateHolding({ symbol: 'T', entryPrice: 105, stopLoss: 96, candles, todayClose: today });
      expect(r.signals.some(s => s.type === 'ch8_lower_high_break_ma5')).toBe(false);
    });

    it('新分支不搶既有較重分支：獲利 ≥20% 破 MA5 仍走 break_ma5_high_profit', () => {
      const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 1.5);
      closes.push(138); // 今日回落破 MA5
      const candles = makeCandles(closes);
      const r = evaluateHolding({ symbol: 'T', entryPrice: 100, stopLoss: 90, candles, todayClose: 138 });
      expect(r.action).toBe('exit_all');
      expect(r.signals.some(s => s.type === 'break_ma5_high_profit')).toBe(true);
    });
  });
});
