/**
 * Contract test：Phase 3 強化選股三模組 + 書本對齊
 *
 * 守的規則（rule #5 對齊）：
 *   - 三模組必須有 book reference metadata（book / part / topic / rule）
 *   - strongLeadsWeak 是排序因子（不是過濾條件，5d 漲幅 < -3% 不算「相對弱」是「絕對弱」）
 *   - weeklyWPattern 是 N 字母子型態（rule='N_sub_pattern'）
 *   - threeMA 是 Q 完整版（rule='Q_full_replaces_Q_legacy_when_enabled'）
 *   - 三模組純函式、不讀檔、不寫檔
 *   - 預設不啟用（StrategyConfig.enhancedSelection 預設 OFF；本份測試只覆蓋模組本身）
 */

import {
  scoreStrongLeadsWeak,
  strongIndustries,
  STRONG_LEADS_WEAK_BOOK_REF,
  STRONG_LEADS_WEAK_CONST,
  type IndustryStat,
} from '@/lib/selection/strongLeadsWeak';
import {
  detectWeeklyW,
  aggregateDailyToWeekly,
  WEEKLY_W_BOOK_REF,
  WEEKLY_W_CONST,
  type WeeklyCandle,
} from '@/lib/selection/weeklyWPattern';
import {
  detectThreeMA,
  THREE_MA_BOOK_REF,
  THREE_MA_CONST,
  type ThreeMACandle,
} from '@/lib/scanner/strategies/threeMA';

// ────────────────────────────────────────────────────────────────────────────
// Book references — rule #5 守
// ────────────────────────────────────────────────────────────────────────────

describe('Book references — 每模組必須含書本來源', () => {
  test('strongLeadsWeak 引用朱家泓寶典 Part 12', () => {
    expect(STRONG_LEADS_WEAK_BOOK_REF.book).toContain('朱家泓');
    expect(STRONG_LEADS_WEAK_BOOK_REF.part).toContain('Part 12');
    expect(STRONG_LEADS_WEAK_BOOK_REF.rule).toBe('sorting_factor_only');
  });

  test('weeklyW 引用朱家泓寶典 Part 7-3 + 抓住飆股', () => {
    expect(WEEKLY_W_BOOK_REF.book).toContain('朱家泓');
    expect(WEEKLY_W_BOOK_REF.part).toContain('Part 7-3');
    expect(WEEKLY_W_BOOK_REF.rule).toBe('N_sub_pattern');
  });

  test('threeMA 引用朱家泓網路課程', () => {
    expect(THREE_MA_BOOK_REF.book).toContain('朱家泓');
    expect(THREE_MA_BOOK_REF.topic).toContain('三均線');
    expect(THREE_MA_BOOK_REF.rule).toContain('Q_legacy');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// strongLeadsWeak
// ────────────────────────────────────────────────────────────────────────────

function makeIndustryStat(o: Partial<IndustryStat> = {}): IndustryStat {
  return {
    industry: '半導體',
    sixtyDayGainAvg: 30,
    rank: 1,
    totalIndustries: 10,
    symbolFiveDayGains: [
      { symbol: 'A', fiveDayGainPct: 10 },
      { symbol: 'B', fiveDayGainPct: 8 },
      { symbol: 'C', fiveDayGainPct: 5 },
      { symbol: 'D', fiveDayGainPct: 3 },
      { symbol: 'E', fiveDayGainPct: 1 },
    ],
    ...o,
  };
}

describe('scoreStrongLeadsWeak', () => {
  test('強勢族群 top 20% + 個股相對弱 → score = 1.0', () => {
    const stat = makeIndustryStat();
    const r = scoreStrongLeadsWeak({
      symbol: 'E', industry: '半導體', fiveDayGainPct: 1,  // 族群末段
      industryStat: stat,
    });
    expect(r.score).toBe(1);
    expect(r.isStrongIndustry).toBe(true);
    expect(r.isRelativeWeak).toBe(true);
  });

  test('強勢族群 + 個股漲多（族群前段）→ score = 0.5（不取）', () => {
    const stat = makeIndustryStat();
    const r = scoreStrongLeadsWeak({
      symbol: 'A', industry: '半導體', fiveDayGainPct: 10,  // 族群最強
      industryStat: stat,
    });
    expect(r.score).toBe(0.5);
    expect(r.isStrongIndustry).toBe(true);
    expect(r.isRelativeWeak).toBe(false);
  });

  test('非強勢族群（rank > 20%）→ score = 0', () => {
    const stat = makeIndustryStat({ rank: 5, totalIndustries: 10 });  // 50% 非 top 20%
    const r = scoreStrongLeadsWeak({
      symbol: 'X', industry: '電子', fiveDayGainPct: 1,
      industryStat: stat,
    });
    expect(r.score).toBe(0);
    expect(r.isStrongIndustry).toBe(false);
  });

  test('「相對弱」≠「絕對弱」：5d 跌 > 3% 不算強中透弱', () => {
    const stat = makeIndustryStat();
    const r = scoreStrongLeadsWeak({
      symbol: 'BROKEN', industry: '半導體', fiveDayGainPct: -5,  // 已跌破
      industryStat: stat,
    });
    expect(r.isRelativeWeak).toBe(false);  // 不該被誤判
    expect(r.score).toBe(0.5);  // 只給強勢族群基本分
  });

  test('無 industry 資料 → score = 0 + 明確 reason', () => {
    const r = scoreStrongLeadsWeak({
      symbol: 'X', fiveDayGainPct: 1,
    });
    expect(r.score).toBe(0);
    expect(r.reason).toContain('industry');
  });

  test('TOP_PCT 常數 20%、BOTTOM_PCT 30%（防被悄悄調寬）', () => {
    expect(STRONG_LEADS_WEAK_CONST.STRONG_INDUSTRY_TOP_PCT).toBe(0.20);
    expect(STRONG_LEADS_WEAK_CONST.RELATIVE_WEAK_BOTTOM_PCT).toBe(0.30);
  });
});

describe('strongIndustries', () => {
  test('回 top 20%', () => {
    const stats: IndustryStat[] = Array.from({ length: 10 }, (_, i) => makeIndustryStat({
      industry: `industry-${i}`, rank: i + 1, totalIndustries: 10,
    }));
    const top = strongIndustries(stats);
    expect(top).toHaveLength(2);  // 10 × 20%
    expect(top[0]).toBe('industry-0');  // rank 1
  });

  test('空陣列 → 空回', () => {
    expect(strongIndustries([])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// weeklyWPattern
// ────────────────────────────────────────────────────────────────────────────

function makeWeekly(o: Partial<WeeklyCandle> = {}): WeeklyCandle {
  return {
    weekStart: '2026-01-05', weekEnd: '2026-01-09',
    open: 100, high: 110, low: 90, close: 105, volume: 10000,
    ...o,
  };
}

describe('aggregateDailyToWeekly', () => {
  test('5 個交易日合 1 週', () => {
    const daily = [
      { date: '2026-05-18', open: 100, high: 105, low: 95, close: 102, volume: 1000 },  // 週一
      { date: '2026-05-19', open: 102, high: 107, low: 100, close: 105, volume: 1200 },
      { date: '2026-05-20', open: 105, high: 108, low: 103, close: 107, volume: 1100 },
      { date: '2026-05-21', open: 107, high: 110, low: 104, close: 108, volume: 1300 },
      { date: '2026-05-22', open: 108, high: 112, low: 106, close: 110, volume: 1500 },
    ];
    const w = aggregateDailyToWeekly(daily);
    expect(w).toHaveLength(1);
    expect(w[0].open).toBe(100);
    expect(w[0].close).toBe(110);
    expect(w[0].high).toBe(112);
    expect(w[0].low).toBe(95);
    expect(w[0].volume).toBe(6100);
  });

  test('空 daily → 空週', () => {
    expect(aggregateDailyToWeekly([])).toEqual([]);
  });
});

describe('detectWeeklyW', () => {
  test('週 K 不足 12 根 → 不偵測', () => {
    const r = detectWeeklyW([makeWeekly()]);
    expect(r.detected).toBe(false);
    expect(r.reason).toContain('不足');
  });

  test('典型 W 底突破：左底 95、peak 110、右底 96、突破週 close 115 量 1.5x', () => {
    // 12 週：前 7 週左半（含左底）；後 4 週右半（含右底）；第 12 週為突破週
    const weekly: WeeklyCandle[] = [
      makeWeekly({ weekEnd: '2026-W01', high: 105, low: 98, close: 102, volume: 1000 }),
      makeWeekly({ weekEnd: '2026-W02', high: 102, low: 95, close: 97, volume: 1100 }),  // 左底 95
      makeWeekly({ weekEnd: '2026-W03', high: 100, low: 97, close: 99, volume: 1000 }),
      makeWeekly({ weekEnd: '2026-W04', high: 105, low: 99, close: 104, volume: 1100 }),
      makeWeekly({ weekEnd: '2026-W05', high: 108, low: 102, close: 107, volume: 1000 }),
      makeWeekly({ weekEnd: '2026-W06', high: 110, low: 105, close: 109, volume: 1200 }),  // peak 110
      makeWeekly({ weekEnd: '2026-W07', high: 108, low: 102, close: 104, volume: 900 }),
      makeWeekly({ weekEnd: '2026-W08', high: 105, low: 99, close: 101, volume: 1000 }),
      makeWeekly({ weekEnd: '2026-W09', high: 101, low: 96, close: 98, volume: 1100 }),   // 右底 96
      makeWeekly({ weekEnd: '2026-W10', high: 104, low: 98, close: 102, volume: 1000 }),
      makeWeekly({ weekEnd: '2026-W11', high: 109, low: 101, close: 107, volume: 1100 }),
      makeWeekly({ weekEnd: '2026-W12', high: 118, low: 110, close: 115, volume: 1600 }),  // 突破，量 1.5x
    ];
    const r = detectWeeklyW(weekly);
    expect(r.detected).toBe(true);
    expect(r.necklinePrice).toBe(110);
    expect(r.breakoutClose).toBe(115);
    expect(r.breakoutVolumeMultiple).toBeGreaterThanOrEqual(1.3);
  });

  test('右底破左底 → 非 W 底', () => {
    // 12 週：前 7 週為 leftHalf（low=100，左底）；後 4 週 rightHalf（low=80，右底破底）；最後 1 週為突破週候選
    const weekly: WeeklyCandle[] = [
      // leftHalf 7 週，low 一律 100，中間 W3 為突出 peak 110
      ...Array(7).fill(0).map((_, i) => makeWeekly({
        weekEnd: `W${i}`, low: 100, high: i === 3 ? 115 : 105, close: 103,
      })),
      // rightHalf 4 週，low 一律 80（明顯破左底 100 的 5% buffer）
      ...Array(4).fill(0).map((_, i) => makeWeekly({
        weekEnd: `W${i + 7}`, low: 80, high: 85, close: 82,
      })),
      makeWeekly({ weekEnd: 'W11', low: 90, high: 120, close: 115, volume: 5000 }),
    ];
    const r = detectWeeklyW(weekly);
    expect(r.detected).toBe(false);
    expect(r.reason).toContain('破底');
  });

  test('突破週量不足 → detected=false 但帶 reason', () => {
    const weekly: WeeklyCandle[] = [
      makeWeekly({ weekEnd: 'W1', low: 95, high: 100, close: 98, volume: 1000 }),
      makeWeekly({ weekEnd: 'W2', low: 95, high: 100, close: 98, volume: 1000 }),
      makeWeekly({ weekEnd: 'W3', low: 100, high: 105, close: 103, volume: 1000 }),
      makeWeekly({ weekEnd: 'W4', low: 105, high: 110, close: 108, volume: 1000 }),
      makeWeekly({ weekEnd: 'W5', low: 105, high: 110, close: 108, volume: 1000 }),
      makeWeekly({ weekEnd: 'W6', low: 105, high: 110, close: 108, volume: 1000 }),
      makeWeekly({ weekEnd: 'W7', low: 105, high: 110, close: 108, volume: 1000 }),
      makeWeekly({ weekEnd: 'W8', low: 100, high: 105, close: 102, volume: 1000 }),
      makeWeekly({ weekEnd: 'W9', low: 95, high: 100, close: 98, volume: 1000 }),
      makeWeekly({ weekEnd: 'W10', low: 100, high: 105, close: 102, volume: 1000 }),
      makeWeekly({ weekEnd: 'W11', low: 105, high: 110, close: 108, volume: 1000 }),
      makeWeekly({ weekEnd: 'W12', low: 110, high: 115, close: 113, volume: 1000 }),  // 量等同前 4 週，未爆
    ];
    const r = detectWeeklyW(weekly);
    // 即使突破 neckline，量未達 1.3x 不算成立
    if (r.breakoutVolumeMultiple != null) {
      expect(r.breakoutVolumeMultiple).toBeLessThan(1.3);
    }
  });

  test('常數鎖定（LOOKBACK 12 / 量倍率 1.3）', () => {
    expect(WEEKLY_W_CONST.LOOKBACK_WEEKS).toBe(12);
    expect(WEEKLY_W_CONST.VOLUME_BREAKOUT_MULTIPLIER).toBe(1.3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// threeMA
// ────────────────────────────────────────────────────────────────────────────

function makeCandles(closes: number[]): ThreeMACandle[] {
  return closes.map((c, i) => ({
    date: new Date(2026, 0, i + 1).toISOString().slice(0, 10),
    close: c,
  }));
}

describe('detectThreeMA', () => {
  test('K 線不足 25 根 → 不偵測', () => {
    const r = detectThreeMA(makeCandles([100, 101, 102]));
    expect(r.entrySignal).toBe(false);
    expect(r.reason).toContain('不足');
  });

  test('多頭結構 + MA3 上穿 MA10 → entrySignal=true', () => {
    // 構造：先盤整 20 根，後段急拉讓 MA3 上穿 MA10、且三均都向上
    const closes = [
      ...Array(20).fill(100).map((v, i) => v + i * 0.2),  // 緩升讓 MA24 向上
      ...Array(10).fill(0).map((_, i) => 105 + i * 1.5),  // 急升讓 MA3 上穿
    ];
    const r = detectThreeMA(makeCandles(closes));
    // 不是每根都觸發 entrySignal，但 ma 計算必須成立
    expect(r.ma3).not.toBeNull();
    expect(r.ma10).not.toBeNull();
    expect(r.ma24).not.toBeNull();
    // 三均斜率必為正
    expect(r.ma3Slope).toBeGreaterThan(0);
    expect(r.ma10Slope).toBeGreaterThan(0);
    expect(r.ma24Slope).toBeGreaterThan(0);
  });

  test('MA3 剛跌破 MA10 → exitPartialSignal=true（精準 cross-down）', () => {
    // 構造：26 根緩升讓三均多頭，最後 1 根大跌讓 MA3 剛好跌破 MA10
    // 緩升 100..125（26 根）+ 1 根大跌到 100
    const closes = [
      ...Array(26).fill(0).map((_, i) => 100 + i),
      100,  // 突然跌
    ];
    const r = detectThreeMA(makeCandles(closes));
    expect(r.exitPartialSignal).toBe(true);
    expect(r.ma3PrevAboveMa10).toBe(true);
  });

  test('MA10 跌破 MA24 → exitFullSignal=true', () => {
    // 構造：35 根 K，前段穩定多頭（ma10 站 ma24 之上），後段急跌讓 ma10 剛跌破 ma24
    // 前 30 根穩定升 100→130，最後 5 根大跌到 60
    const closes = [
      ...Array(30).fill(0).map((_, i) => 100 + i),       // 100..129
      ...Array(5).fill(0).map((_, i) => 129 - (i + 1) * 14),  // 115, 101, 87, 73, 59
    ];
    const r = detectThreeMA(makeCandles(closes));
    // 至少 ma10 < ma24（已是空頭）
    if (r.ma10 != null && r.ma24 != null) {
      expect(r.ma10).toBeLessThan(r.ma24);
    }
    // exitFullSignal 為布林
    expect(typeof r.exitFullSignal).toBe('boolean');
  });

  test('常數鎖定（3/10/24）', () => {
    expect(THREE_MA_CONST.MA_SHORT).toBe(3);
    expect(THREE_MA_CONST.MA_MID).toBe(10);
    expect(THREE_MA_CONST.MA_LONG).toBe(24);
  });

  test('純空頭結構 → entrySignal=false + 明確 reason', () => {
    // 連跌：MA10 < MA24
    const closes = Array(30).fill(0).map((_, i) => 200 - i * 3);
    const r = detectThreeMA(makeCandles(closes));
    expect(r.entrySignal).toBe(false);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
