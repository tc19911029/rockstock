/**
 * 陸股 AI 選股 Agent — breadth 組裝層單元測試（純 fixture，零網路 / 零 IO）
 *
 * 覆蓋重點：
 *   computePoolStats — ST 排除 / heightDist 邊界 / sealRate 分母 0 / 晉級率對集
 *   buildMarketBreadthDay — turnoverRatio5d 足量與不足 / promotionRateHigh 加權合併
 *   computeBrokenAvgPctFromQuotes — 對得到 ≥1 檔才回數字
 */

import {
  buildLimitUpPoolDay,
  buildMarketBreadthDay,
  computeBrokenAvgPctFromQuotes,
  computePoolStats,
} from '@/lib/cn-agents/breadth';
import type {
  BrokenEntry,
  LimitDownEntry,
  LimitUpEntry,
  LimitUpPoolDay,
  MarketOverview,
} from '@/lib/cn-agents/types';
import { CN_AGENTS_SCHEMA_VERSION } from '@/lib/cn-agents/types';

// ── fixture builders ─────────────────────────────────────────────────────────

function lu(symbol: string, over: Partial<LimitUpEntry> = {}): LimitUpEntry {
  return {
    symbol,
    name: `股${symbol}`,
    board: 'SH-main',
    pct: 10.0,
    close: 10.0,
    turnoverCny: 1e8,
    floatMvCny: 5e9,
    sealAmountCny: 2e7,
    firstSealTime: '09:35:00',
    lastSealTime: '09:35:00',
    brokenTimes: 0,
    consecBoards: 1,
    boardsPattern: null,
    industry: '測試業',
    isOneWord: false,
    isST: false,
    ...over,
  };
}

function bk(symbol: string, over: Partial<BrokenEntry> = {}): BrokenEntry {
  return {
    symbol,
    name: `股${symbol}`,
    board: 'SZ-main',
    pct: 5.2,
    close: 8.4,
    brokenTimes: 2,
    firstSealTime: '10:01:00',
    industry: '測試業',
    isST: false,
    ...over,
  };
}

function ld(symbol: string, over: Partial<LimitDownEntry> = {}): LimitDownEntry {
  return {
    symbol,
    name: `股${symbol}`,
    board: 'SZ-main',
    pct: -10.0,
    close: 3.1,
    consecDownBoards: 1,
    industry: '測試業',
    isST: false,
    ...over,
  };
}

const BREADTH: MarketOverview = {
  upCount: 3100,
  downCount: 1800,
  flatCount: 200,
  turnoverShSzCny: 1.5e12,
  shIndexPct: 0.8,
};

function poolDay(date: string, limitUp: LimitUpEntry[]): LimitUpPoolDay {
  return {
    schemaVersion: CN_AGENTS_SCHEMA_VERSION,
    date,
    fetchedAt: `${date}T07:30:00.000Z`,
    source: 'em-push2ex',
    limitUp,
    limitDown: [],
    broken: [],
    breadth: BREADTH,
    stats: computePoolStats({
      limitUp,
      broken: [],
      limitDown: [],
      yesterdayPool: null,
      yesterdayLimitUpAvgPct: null,
      yesterdayBrokenAvgPct: null,
    }),
  };
}

// ── computePoolStats ─────────────────────────────────────────────────────────

describe('computePoolStats', () => {
  it('ST 排除：計數欄全排 ST、stLimitUpCount 另計、limitDownCount 含 ST', () => {
    const stats = computePoolStats({
      limitUp: [
        lu('600001', { consecBoards: 2, isOneWord: true }),
        lu('600002', { board: 'ChiNext', pct: 20.0 }),
        lu('600003', { isST: true, consecBoards: 5, isOneWord: true, pct: 5.0 }),
      ],
      broken: [bk('000001'), bk('000002', { isST: true })],
      limitDown: [ld('000100'), ld('000101', { isST: true })],
      yesterdayPool: null,
      yesterdayLimitUpAvgPct: null,
      yesterdayBrokenAvgPct: null,
    });

    expect(stats.limitUpCount).toBe(2);
    expect(stats.stLimitUpCount).toBe(1);
    expect(stats.brokenCount).toBe(1); // ST 炸板不計
    expect(stats.limitDownCount).toBe(2); // 跌停含 ST
    // ST 5 連板不可滲入梯隊 / 最高板
    expect(stats.heightDist).toEqual({ '1': 1, '2': 1, '3': 0, '4+': 0 });
    expect(stats.maxHeight).toBe(2);
    expect(stats.maxHeightSymbols).toEqual(['600001']);
    expect(stats.board2PlusCount).toBe(1);
    // ST 一字板不計入 oneWordCount
    expect(stats.oneWordCount).toBe(1);
    expect(stats.cm20LimitUpCount).toBe(1);
    // sealRate/brokenRate 分母 = 2 + 1（皆非 ST）
    expect(stats.sealRate).toBeCloseTo(2 / 3);
    expect(stats.brokenRate).toBeCloseTo(1 / 3);
  });

  it('heightDist 邊界：1/2/3/4/7 板分桶、maxHeightSymbols 取最高板', () => {
    const stats = computePoolStats({
      limitUp: [
        lu('600001', { consecBoards: 1 }),
        lu('600002', { consecBoards: 2 }),
        lu('600003', { consecBoards: 3 }),
        lu('600004', { consecBoards: 4 }),
        lu('600005', { consecBoards: 7 }),
      ],
      broken: [],
      limitDown: [],
      yesterdayPool: null,
      yesterdayLimitUpAvgPct: null,
      yesterdayBrokenAvgPct: null,
    });

    expect(stats.heightDist).toEqual({ '1': 1, '2': 1, '3': 1, '4+': 2 });
    expect(stats.maxHeight).toBe(7);
    expect(stats.maxHeightSymbols).toEqual(['600005']);
    expect(stats.board2PlusCount).toBe(4);
  });

  it('空盤（零漲停零炸板）：sealRate/brokenRate 分母 0 → null、maxHeight=0', () => {
    const stats = computePoolStats({
      limitUp: [],
      broken: [],
      limitDown: [],
      yesterdayPool: null,
      yesterdayLimitUpAvgPct: null,
      yesterdayBrokenAvgPct: null,
    });

    expect(stats.limitUpCount).toBe(0);
    expect(stats.sealRate).toBeNull();
    expect(stats.brokenRate).toBeNull();
    expect(stats.maxHeight).toBe(0);
    expect(stats.maxHeightSymbols).toEqual([]);
    expect(stats.promotion).toBeNull(); // 昨檔缺 → null
  });

  it('晉級率：d1to2 嚴格 +1、d2to3 嚴格 +1、d3plus 在池即續板、ST 不進對集', () => {
    const yesterdayPool = poolDay('2026-06-10', [
      lu('600001', { consecBoards: 1 }), // 今晉 2 板 ✓
      lu('600002', { consecBoards: 1 }), // 今不在池 ✗
      lu('600003', { consecBoards: 1, isST: true }), // ST 不進 eligible
      lu('600004', { consecBoards: 2 }), // 今晉 3 板 ✓
      lu('600005', { consecBoards: 2 }), // 今又顯示 1 板（斷板重計）✗ 不算晉級
      lu('600006', { consecBoards: 3 }), // 今在池（4 板）✓ 續板
      lu('600007', { consecBoards: 5 }), // 今不在池 ✗
    ]);

    const stats = computePoolStats({
      limitUp: [
        lu('600001', { consecBoards: 2 }),
        lu('600004', { consecBoards: 3 }),
        lu('600005', { consecBoards: 1 }),
        lu('600006', { consecBoards: 4 }),
        lu('600003', { consecBoards: 2, isST: true }), // ST 今日在池也不算
      ],
      broken: [],
      limitDown: [],
      yesterdayPool,
      yesterdayLimitUpAvgPct: 3.2,
      yesterdayBrokenAvgPct: -1.4,
    });

    expect(stats.promotion).not.toBeNull();
    expect(stats.promotion!.d1to2).toEqual({ eligible: 2, promoted: 1, rate: 0.5 });
    expect(stats.promotion!.d2to3).toEqual({ eligible: 2, promoted: 1, rate: 0.5 });
    expect(stats.promotion!.d3plus).toEqual({ eligible: 2, promoted: 1, rate: 0.5 });
    expect(stats.yesterdayLimitUpAvgPct).toBe(3.2);
    expect(stats.yesterdayBrokenAvgPct).toBe(-1.4);
  });

  it('晉級率 eligible=0 → rate null（不是 0）', () => {
    const yesterdayPool = poolDay('2026-06-10', [lu('600001', { consecBoards: 1 })]);
    const stats = computePoolStats({
      limitUp: [lu('600001', { consecBoards: 2 })],
      broken: [],
      limitDown: [],
      yesterdayPool,
      yesterdayLimitUpAvgPct: null,
      yesterdayBrokenAvgPct: null,
    });

    expect(stats.promotion!.d1to2).toEqual({ eligible: 1, promoted: 1, rate: 1 });
    expect(stats.promotion!.d2to3).toEqual({ eligible: 0, promoted: 0, rate: null });
    expect(stats.promotion!.d3plus).toEqual({ eligible: 0, promoted: 0, rate: null });
  });
});

// ── buildMarketBreadthDay ────────────────────────────────────────────────────

describe('buildMarketBreadthDay', () => {
  it('turnoverRatio5d：歷史足 4 筆 → 今日 / 近 5 日均（含今日）', () => {
    const pool = poolDay('2026-06-12', [lu('600001')]);
    // 今日 1.5e12；近 4 日各 1e12 → 5 日均 = (1.5 + 4) / 5 = 1.1e12
    const day = buildMarketBreadthDay({
      pool,
      turnoverHistory: [
        { date: '2026-06-11', turnover: 1e12 },
        { date: '2026-06-10', turnover: 1e12 },
        { date: '2026-06-09', turnover: 1e12 },
        { date: '2026-06-08', turnover: 1e12 },
        { date: '2026-06-05', turnover: 9e11 }, // 第 5 筆，超出近 4 日窗不參與
      ],
    });

    expect(day.turnoverRatio5d).toBeCloseTo(1.5e12 / 1.1e12);
    expect(day.totalTurnover).toBe(1.5e12);
    expect(day.date).toBe('2026-06-12');
  });

  it('turnoverRatio5d：歷史不足 4 筆（含 null 列剔除）→ null；今日列混入不重複計', () => {
    const pool = poolDay('2026-06-12', [lu('600001')]);
    const day = buildMarketBreadthDay({
      pool,
      turnoverHistory: [
        { date: '2026-06-12', turnover: 1.5e12 }, // 今日列必須被剔除
        { date: '2026-06-11', turnover: 1e12 },
        { date: '2026-06-10', turnover: null }, // null 不算有效筆
        { date: '2026-06-09', turnover: 1e12 },
        { date: '2026-06-08', turnover: 1e12 },
      ],
    });

    expect(day.turnoverRatio5d).toBeNull();
  });

  it('promotionRateHigh：d2to3 與 d3plus 按 eligible 加權合併；扁平欄位對齊 stats', () => {
    const yesterdayPool = poolDay('2026-06-11', [
      lu('600004', { consecBoards: 2 }),
      lu('600005', { consecBoards: 2 }),
      lu('600006', { consecBoards: 2 }),
      lu('600007', { consecBoards: 3 }),
    ]);
    const pool = buildLimitUpPoolDay({
      date: '2026-06-12',
      fetchedAt: '2026-06-12T07:30:00.000Z',
      source: 'em-push2ex',
      // d2to3: eligible 3、promoted 1；d3plus: eligible 1、promoted 1
      limitUp: [lu('600004', { consecBoards: 3 }), lu('600007', { consecBoards: 4 }), lu('600099', { consecBoards: 1, isOneWord: true })],
      broken: [bk('000001')],
      limitDown: [ld('000100')],
      breadth: BREADTH,
      yesterdayPool,
      yesterdayLimitUpAvgPct: 2.5,
      yesterdayBrokenAvgPct: -3.0,
    });

    const day = buildMarketBreadthDay({ pool, turnoverHistory: [] });

    expect(day.promotionRateHigh).toBeCloseTo((1 + 1) / (3 + 1));
    expect(day.promotionRate1to2).toBeNull(); // 昨無 1 板 → eligible 0 → null
    expect(day.limitUpCount).toBe(3);
    expect(day.oneWordCount).toBe(1);
    expect(day.zhabanCount).toBe(1);
    expect(day.zhabanRate).toBeCloseTo(1 / 4);
    expect(day.maxBoardHeight).toBe(4);
    expect(day.board2PlusCount).toBe(2);
    expect(day.yestLimitUpAvgReturn).toBe(2.5);
    expect(day.yestZhabanAvgReturn).toBe(-3.0);
    expect(day.upCount).toBe(3100);
    expect(day.downCount).toBe(1800);
    expect(day.shIndexChangePct).toBe(0.8);
    expect(day.turnoverRatio5d).toBeNull(); // 無歷史
  });

  it('promotionRateHigh：promotion 缺（昨檔缺）或兩池 eligible 皆 0 → null', () => {
    const noYesterday = buildMarketBreadthDay({
      pool: poolDay('2026-06-12', [lu('600001')]),
      turnoverHistory: [],
    });
    expect(noYesterday.promotionRateHigh).toBeNull();

    const yesterdayPool = poolDay('2026-06-11', [lu('600001', { consecBoards: 1 })]);
    const pool = buildLimitUpPoolDay({
      date: '2026-06-12',
      fetchedAt: '2026-06-12T07:30:00.000Z',
      source: 'em-push2ex',
      limitUp: [lu('600001', { consecBoards: 2 })],
      broken: [],
      limitDown: [],
      breadth: BREADTH,
      yesterdayPool,
      yesterdayLimitUpAvgPct: null,
      yesterdayBrokenAvgPct: null,
    });
    const onlyD1 = buildMarketBreadthDay({ pool, turnoverHistory: [] });
    expect(onlyD1.promotionRate1to2).toBe(1);
    expect(onlyD1.promotionRateHigh).toBeNull(); // 昨無 ≥2 板
  });
});

// ── computeBrokenAvgPctFromQuotes ────────────────────────────────────────────

describe('computeBrokenAvgPctFromQuotes', () => {
  it('對得到 ≥1 檔 → 平均；ST 與對不到的剔除', () => {
    const yesterdayBroken = [bk('000001'), bk('000002'), bk('000003', { isST: true }), bk('000004')];
    const avg = computeBrokenAvgPctFromQuotes(
      yesterdayBroken,
      new Map([
        ['000001', -4.0],
        ['000002', 2.0],
        ['000003', 9.9], // ST 不計
        // 000004 對不到 → 不計
      ]),
    );
    expect(avg).toBeCloseTo(-1.0);
  });

  it('一檔都對不到 → null（不可回 0）', () => {
    expect(computeBrokenAvgPctFromQuotes([bk('000001')], new Map())).toBeNull();
    expect(computeBrokenAvgPctFromQuotes([], new Map([['000001', 1.0]]))).toBeNull();
  });
});
