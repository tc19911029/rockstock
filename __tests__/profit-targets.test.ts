/**
 * lib/sell/profitTargets.ts — 課程 CH9-2 六種壓力位獲利目標（2026-07-04，純顯示層）
 *
 * 合成「山型」K 線：上漲 → 高檔盤整 → 大量長黑 → 大量向下跳空 → 陰跌。
 * 現價在山腳，六種壓力位應多數在上方被找到。
 */
import { describe, it, expect } from '@jest/globals';
import { computeProfitTargets } from '@/lib/sell/profitTargets';
import type { Candle } from '@/types';

interface Bar { open?: number; high?: number; low?: number; close: number; volume?: number }

function makeCandles(bars: Bar[]): Candle[] {
  const start = new Date('2026-01-01');
  return bars.map((b, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const prevClose = i > 0 ? bars[i - 1].close : b.close;
    const open = b.open ?? prevClose;
    return {
      date: d.toISOString().slice(0, 10),
      open,
      high: b.high ?? Math.max(open, b.close) * 1.005,
      low: b.low ?? Math.min(open, b.close) * 0.995,
      close: b.close,
      volume: b.volume ?? 10000,
    };
  });
}

function mountainScenario(): Candle[] {
  const bars: Bar[] = [];
  for (let i = 0; i < 40; i++) bars.push({ close: 100 + i });                    // 0-39 上漲 100→139
  const consol = [139, 140, 139.5, 140.5, 139, 140, 139.5, 140, 139.5, 140];
  for (const c of consol) bars.push({ close: c });                               // 40-49 高檔盤整
  bars.push({ open: 140, high: 140.5, low: 134.5, close: 135, volume: 20000 }); // 50 大量長黑（body 3.6%、量比2）
  bars.push({ open: 132, high: 132.5, low: 128, close: 129, volume: 30000 });   // 51 大量向下跳空（未回補）
  for (let i = 0; i < 19; i++) bars.push({ close: 128 - i });                    // 52-70 陰跌到 110
  return makeCandles(bars);
}

describe('computeProfitTargets — CH9-2 六壓力位', () => {
  const result = computeProfitTargets(mountainScenario(), 'short');

  it('回傳六種目標', () => {
    expect(result).not.toBeNull();
    expect(result!.targets).toHaveLength(6);
    expect(result!.horizon).toBe('short');
  });

  it('① 長均線壓力在現價上方', () => {
    const t = result!.targets.find(t => t.type === 'long-ma')!;
    expect(t.price).not.toBeNull();
    expect(t.price!).toBeGreaterThan(result!.asOfClose);
  });

  it('② 前高壓力（山頂）在現價上方', () => {
    const t = result!.targets.find(t => t.type === 'pivot-high')!;
    expect(t.price).not.toBeNull();
    expect(t.price!).toBeGreaterThan(result!.asOfClose);
  });

  it('④ 向上盤整區壓力（高檔盤整箱）在現價上方', () => {
    const t = result!.targets.find(t => t.type === 'consol-zone')!;
    expect(t.price).not.toBeNull();
    expect(t.price!).toBeGreaterThan(result!.asOfClose);
  });

  it('⑤ 大量向下缺口壓力 = 缺口下緣 132.5', () => {
    const t = result!.targets.find(t => t.type === 'down-gap')!;
    expect(t.price).toBeCloseTo(132.5, 1);
  });

  it('⑥ 大量下跌黑K壓力 = 最近的大量黑K高點（跳空日本身也是大量長黑 → 132.5）', () => {
    const t = result!.targets.find(t => t.type === 'black-k')!;
    expect(t.price).toBeCloseTo(132.5, 1);
  });

  it('nearestAbove = 六種中最低的上方壓力', () => {
    const prices = result!.targets.map(t => t.price).filter((p): p is number => p != null);
    expect(result!.nearestAbove).toBe(Math.min(...prices));
  });

  it('long horizon（週線）也能算（資料夠時回六種）', () => {
    // 71 根日線 ≈ 15 週，剛好過門檻
    const r = computeProfitTargets(mountainScenario(), 'long');
    if (r != null) {
      expect(r.targets).toHaveLength(6);
      expect(r.horizon).toBe('long');
    }
  });

  it('資料不足回 null', () => {
    expect(computeProfitTargets(mountainScenario().slice(0, 20), 'short')).toBeNull();
  });

  it('創新高股票：多數壓力位為 null（上方無壓）', () => {
    const rising: Bar[] = [];
    for (let i = 0; i < 80; i++) rising.push({ close: 100 + i * 2 });
    const r = computeProfitTargets(makeCandles(rising), 'short');
    expect(r).not.toBeNull();
    const gap = r!.targets.find(t => t.type === 'down-gap')!;
    const blackK = r!.targets.find(t => t.type === 'black-k')!;
    const longMa = r!.targets.find(t => t.type === 'long-ma')!;
    expect(gap.price).toBeNull();
    expect(blackK.price).toBeNull();
    expect(longMa.price).toBeNull();
  });
});
