/**
 * 鎖股名單（獵兔計劃）核心行為測試（批次D 2026-07-05）
 * 守：8 分類基本歸類、汰弱硬條件、roster 上限與手動保護。
 */
import type { CandleWithIndicators } from '@/types';
import {
  classifyHuntCategory, evaluateWeakFlags, evolveRoster, ROSTER_MAX,
  type LockRoster,
} from '@/lib/scanner/lockRoster';
import { computeIndicators } from '@/lib/indicators';

/** 造一段 K 線：從 base 開始按日漲跌幅疊出 close，OHLC 簡化（open=前收、高低含實體） */
function mkCandles(dailyPct: number[], base = 100, volume = 1000): CandleWithIndicators[] {
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let prevClose = base;
  for (let i = 0; i < dailyPct.length; i++) {
    const close = +(prevClose * (1 + dailyPct[i])).toFixed(2);
    const open = prevClose;
    const high = Math.max(open, close) * 1.005;
    const low = Math.min(open, close) * 0.995;
    const d = new Date(Date.UTC(2025, 0, 6));
    d.setUTCDate(d.getUTCDate() + i + Math.floor(i / 5) * 2);   // 跳過週末的近似日期
    out.push({ date: d.toISOString().slice(0, 10), open, high, low, close, volume });
    prevClose = close;
  }
  return computeIndicators(out as never);
}

/** 鋸齒多頭底座（頭頭高底底高、有 pivot、>60 根有 MA60）：8 漲 3 小回 × 8 輪 = 88 根 */
function bullishZigzag(): number[] {
  const pct: number[] = [];
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < 8; i++) pct.push(0.015);
    for (let i = 0; i < 3; i++) pct.push(-0.006);
  }
  return pct;
}

describe('lockRoster 獵兔分類', () => {
  test('多頭連漲高檔 → 等拉回（cat3）', () => {
    // 鋸齒多頭底座，再連 5 天大漲（乖離拉開）
    const pct = [...bullishZigzag(), 0.04, 0.04, 0.04, 0.04, 0.04];
    const ci = mkCandles(pct);
    const cls = classifyHuntCategory(ci, ci.length - 1);
    expect(cls).not.toBeNull();
    expect(cls!.category).toBe(3);
  });

  test('多頭回檔中（收盤跌破5均）→ 等上漲（cat4），觸發價=前一日最高', () => {
    const pct = [...bullishZigzag(), -0.02, -0.02, -0.015];
    const ci = mkCandles(pct);
    const cls = classifyHuntCategory(ci, ci.length - 1);
    expect(cls).not.toBeNull();
    expect(cls!.category).toBe(4);
    expect(cls!.triggerLevel).toBeCloseTo(ci[ci.length - 2].high, 5);
  });

  test('低檔（價在季線下）→ 等打底（cat1）', () => {
    const pct = [...Array(60).fill(-0.008)];
    const ci = mkCandles(pct);
    const cls = classifyHuntCategory(ci, ci.length - 1);
    expect(cls).not.toBeNull();
    expect(cls!.category).toBe(1);
  });
});

describe('lockRoster 汰弱（課程 8 條）', () => {
  test('跌破月線 → f8 硬汰弱', () => {
    const pct = [...bullishZigzag(), -0.03, -0.03, -0.03, -0.03, -0.03, -0.03];
    const ci = mkCandles(pct);
    const { hardRemove } = evaluateWeakFlags(ci, ci.length - 1, 4);
    expect(hardRemove.some(f => f.includes('(8)'))).toBe(true);
  });

  test('健康多頭無硬汰弱', () => {
    const ci = mkCandles(bullishZigzag());
    const { hardRemove } = evaluateWeakFlags(ci, ci.length - 1, 4);
    expect(hardRemove).toHaveLength(0);
  });
});

describe('lockRoster evolveRoster', () => {
  const bullish = mkCandles(bullishZigzag());
  const broken = mkCandles([...bullishZigzag(), -0.03, -0.03, -0.03, -0.03, -0.03, -0.03]);

  test('auto 來源硬汰弱剔除、manual 保留旗標；上限 ROSTER_MAX', () => {
    const prev: LockRoster = {
      market: 'TW', updatedAt: '', entries: [
        {
          symbol: '1111.TW', name: '壞股auto', market: 'TW', addedDate: '2026-01-01', source: 'auto-scan',
          category: 4, label: '等上漲', waitingFor: '', urgency: 50, urgencyDetail: '',
          lastClose: 100, lastReviewDate: '2026-01-01', weakFlags: [], history: [],
        },
        {
          symbol: '2222.TW', name: '壞股manual', market: 'TW', addedDate: '2026-01-01', source: 'manual',
          category: 4, label: '等上漲', waitingFor: '', urgency: 50, urgencyDetail: '',
          lastClose: 100, lastReviewDate: '2026-01-01', weakFlags: [], history: [],
        },
      ],
    };
    const candidates = Array.from({ length: 30 }, (_, i) => ({ symbol: `9${String(i).padStart(3, '0')}.TW`, name: `候選${i}` }));
    const { roster, review } = evolveRoster({
      market: 'TW', date: '2026-02-01', prev, candidates,
      candlesOf: (s) => (s === '1111.TW' || s === '2222.TW' ? broken : bullish),
    });
    // auto 壞股被汰、manual 壞股保留
    expect(roster.entries.some(e => e.symbol === '1111.TW')).toBe(false);
    expect(roster.entries.some(e => e.symbol === '2222.TW')).toBe(true);
    expect(review.removed.some(r => r.symbol === '1111.TW')).toBe(true);
    // 上限
    expect(roster.entries.length).toBeLessThanOrEqual(ROSTER_MAX);
    // 依 urgency 降序
    for (let i = 1; i < roster.entries.length; i++) {
      expect(roster.entries[i - 1].urgency).toBeGreaterThanOrEqual(roster.entries[i].urgency);
    }
  });
});
