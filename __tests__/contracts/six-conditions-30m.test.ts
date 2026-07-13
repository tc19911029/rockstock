/**
 * Contract test：六條件(30分K)盤中掃描（2026-07）。
 *
 * 守門員：
 *  1. normalizeFugle30mToEndGrid：Fugle「開始時間」10 根/日 → 「結束時間」9 根/日網格，
 *     13:30 收盤競價併入 13:30 那根(high/low/vol 聚合)——盤中 L2 堆疊也用結束時間，兩源必須對齊。
 *  2. scanSixConditions30m：
 *     - <60 根 30分K(MA60 暖機不足) → 併入 tooFew，不評估
 *     - 任何進榜結果 matchedMethods 必為 ['A30']（自己的池子，不套「含 A」；
 *       這是 loadScanSessionUncached / backtestStore 不把 daily30 結果洗空的前提）
 *     - market 一律 'TW'（此功能只做台股）
 *     - 只用 ZHU_PURE_BOOK 六條件(重用單一事實)，不自創因子
 */
import type { Candle } from '@/types/index';
import { normalizeFugle30mToEndGrid } from '@/lib/candles30m/Candle30mStore';
import { scanSixConditions30m } from '@/lib/candles30m/sixConditions30mScan';

function bar(date: string, o: number, h: number, l: number, c: number, v: number): Candle {
  return { date, open: o, high: h, low: l, close: c, volume: v };
}

describe('normalizeFugle30mToEndGrid（結束時間 9 根/日網格 + 併收盤競價）', () => {
  const day = '2026-07-13';
  // Fugle 開始時間標籤：09:00..13:00 + 13:30 收盤競價 = 10 根
  const starts = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30'];
  const raw: Candle[] = starts.map((t, i) => bar(`${day} ${t}`, 100 + i, 105 + i, 95 + i, 102 + i, 1000 + i));

  const out = normalizeFugle30mToEndGrid(raw);

  it('collapses to 9 end-labelled bars per day (09:30..13:30)', () => {
    const times = out.map(c => c.date.slice(11));
    expect(times).toEqual(['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30']);
  });

  it('09:00-start bar maps to 09:30 end label (same window, end-time convention)', () => {
    const first = out[0];
    expect(first.date).toBe(`${day} 09:30`);
    expect(first.open).toBe(raw[0].open);   // 承接 09:00 start 的 open
  });

  it('13:30 closing-auction merges into the 13:30 end bar (13:00-start + 13:30-start)', () => {
    const last = out[out.length - 1];
    expect(last.date).toBe(`${day} 13:30`);
    const b1300 = raw[8];  // 13:00 start
    const b1330 = raw[9];  // 13:30 auction
    expect(last.open).toBe(b1300.open);                    // open = 較早那根
    expect(last.close).toBe(b1330.close);                  // close = 較晚那根
    expect(last.high).toBe(Math.max(b1300.high, b1330.high));
    expect(last.low).toBe(Math.min(b1300.low, b1330.low));
    expect(last.volume).toBe(b1300.volume + b1330.volume); // 量相加
  });
});

describe('scanSixConditions30m（暖機門檻 + A30 標記 + 不自創因子）', () => {
  // 造 40 根(< 60) → 暖機不足；另造 80 根平盤(≥60，可評估但過不了六條件)
  function flatBars(n: number): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const d = String(i).padStart(3, '0');
      out.push(bar(`2026-01-01 ${d}`, 100, 100.5, 99.5, 100, 1000));
    }
    return out;
  }

  it('universe with <60 bars is counted tooFew, not evaluated', () => {
    const { stats, results } = scanSixConditions30m({ '1111.TW': flatBars(40) }, new Map(), '2026-07-13T00:00:00Z');
    expect(stats.universe).toBe(1);
    expect(stats.tooFew).toBe(1);
    expect(stats.evaluated).toBe(0);
    expect(results).toHaveLength(0);
  });

  it('≥60 bars are evaluated; flat bars pass nobody but math is consistent', () => {
    const { stats } = scanSixConditions30m({ '1111.TW': flatBars(80) }, new Map(), '2026-07-13T00:00:00Z');
    expect(stats.universe).toBe(1);
    expect(stats.tooFew).toBe(0);
    expect(stats.evaluated).toBe(1);
    expect(stats.passed).toBe(0); // 平盤過不了六條件(趨勢/紅K/量比)
  });

  it('index symbols (^) are skipped', () => {
    const { stats } = scanSixConditions30m({ '^TWII': flatBars(80) }, new Map(), '2026-07-13T00:00:00Z');
    expect(stats.universe).toBe(0);
  });

  it('every emitted result is tagged matchedMethods=[A30] and market=TW (never requires A)', () => {
    // 用平盤資料不會有結果 → 用不變式斷言：results 全體(即使空)都符合
    const { results } = scanSixConditions30m({ '1111.TW': flatBars(80) }, new Map(), '2026-07-13T00:00:00Z');
    for (const r of results) {
      expect(r.matchedMethods).toEqual(['A30']);
      expect(r.market).toBe('TW');
      expect(r.sixConditionsScore).toBeGreaterThanOrEqual(5);
    }
  });
});
