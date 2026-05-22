/**
 * Contract test：Technical Agent 的 candidateRow 必須來自 L4 StockScanResult 結構
 *
 * 守的規則：
 *   1. TechnicalQuestion.groundTruth.candidateRow 必須有 StockScanResult 的關鍵欄位
 *   2. buildTechnicalQuestion() 不能丟失 sixConditionsBreakdown / eliminationReasons / matchedMethods
 *   3. bookRulesRef 的 ruleId 必須全部能追溯到 candidateRow（不可憑空生成）
 *   4. Agent answer 中引用的 six conditions 結果必須與 candidateRow.sixConditionsBreakdown 一致
 *
 * 意義：防止「繞過掃描器手動組 candidateRow」讓不符合六條件的股票進入 Agent 分析。
 */

import {
  buildTechnicalQuestion,
} from '@/lib/agents/agents/technicalAgent';
import {
  KNOWN_BOOK_RULE_IDS,
  SIX_CONDITION_RULE_IDS,
  ELIMINATION_RULE_IDS,
  LONG_PROHIBITION_RULE_IDS,
} from '@/lib/agents/types';
import type { StockScanResult, ScanSession } from '@/lib/scanner/types';
import type { StrategyConfig } from '@/lib/strategy/StrategyConfig';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeMinimalRow(overrides: Partial<StockScanResult> = {}): StockScanResult {
  return {
    symbol: '2330',
    name: '台積電',
    market: 'TW',
    price: 950,
    changePercent: 1.5,
    volume: 30000,
    trendState: '多頭',
    trendPosition: '回踩站穩',
    sixConditionsScore: 6,
    chipScore: 60,
    foreignNet5d: 1000,
    consecutiveForeignBuy: 3,
    matchedMethods: ['A'],
    hitCount: 1,
    scanTime: '2026-05-22T06:00:00.000Z',
    sessionType: 'post_close',
    sixConditionsBreakdown: {
      trend: true, ma: true, position: true,
      volume: true, kbar: true, indicator: true,
    },
    eliminationReasons: [],
    entryProhibitionReasons: [],
    longProhibitionsReasons: [],
    mtfWeeklyChecks: {
      trend: true, ma: true, position: true,
      volume: false, kbar: true, indicator: true,
    },
    mtfWeeklyPass: false,
    ...overrides,
  } as StockScanResult;
}

function makeSession(row: StockScanResult): ScanSession {
  return {
    id: 'test-session-1',
    date: '2026-05-22',
    market: 'TW',
    direction: 'long',
    sessionType: 'post_close',
    scanTime: '2026-05-22T06:00:00.000Z',
    resultCount: 1,
    results: [row],
    multiTimeframeEnabled: false,
  } as ScanSession;
}

function makeStrategy(): StrategyConfig {
  return {
    id: 'zhu-v12',
    name: '朱家泓 v12',
    description: 'Test stub strategy',
    version: '1.0.0',
    author: '朱家泓',
    createdAt: '2026-05-22T00:00:00.000Z',
    isBuiltIn: true,
    strategyType: 'trend',
    conditions: {
      trend: true, position: true, kbar: true,
      ma: true, volume: true, indicator: true,
    },
    thresholds: {
      maShortPeriod: 5, maMidPeriod: 10, maLongPeriod: 20,
      kbarMinBodyPct: 0.02, upperShadowMax: 0.3,
      volumeRatioMin: 1.3, kdMaxEntry: 88, deviationMax: 0.15,
      minScore: 4, marketTrendFilter: false,
      bullMinScore: 4, sidewaysMinScore: 3, bearMinScore: 3,
      multiTimeframeFilter: true, mtfWeeklyStrict: false,
      mtfMonthlyStrict: false, mtfMinScore: 4,
      kdDecliningFilter: false,
    },
    ruleGroups: [],
  } as unknown as StrategyConfig;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('L4 來源驗證 — candidateRow 必須來自 StockScanResult', () => {

  test('正常 candidateRow 可建出 question，groundTruth 保留關鍵欄位', () => {
    const row = makeMinimalRow();
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-1',
      date: '2026-05-22',
      symbol: '2330',
      session, candidateRow: row,
      strategy: makeStrategy(),
    });
    // groundTruth 必須保留整個 candidateRow
    expect(q.groundTruth.candidateRow).toBe(row);
    // sixConditionsBreakdown 不丟
    expect(q.groundTruth.candidateRow.sixConditionsBreakdown?.trend).toBe(true);
    expect(q.groundTruth.candidateRow.sixConditionsBreakdown?.ma).toBe(true);
    // matchedMethods 不丟
    expect(q.groundTruth.candidateRow.matchedMethods).toContain('A');
    // eliminationReasons 不丟（即使空陣列）
    expect(Array.isArray(q.groundTruth.candidateRow.eliminationReasons)).toBe(true);
  });

  test('bookRulesRef.sixConditions 6 條全部對應真實 candidateRow breakdown', () => {
    const row = makeMinimalRow({
      sixConditionsBreakdown: { trend: true, ma: false, position: true, volume: false, kbar: true, indicator: true },
    });
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-2', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const six = q.bookRulesRef.sixConditions;
    expect(six).toHaveLength(6);
    // c-trend 對應 breakdown.trend=true
    expect(six.find((e) => e.ruleId === 'c-trend')?.triggered).toBe(true);
    // c-ma 對應 breakdown.ma=false
    expect(six.find((e) => e.ruleId === 'c-ma')?.triggered).toBe(false);
    // c-volume 對應 breakdown.volume=false
    expect(six.find((e) => e.ruleId === 'c-volume')?.triggered).toBe(false);
  });

  test('bookRulesRef 中所有 ruleId 必須在 KNOWN_BOOK_RULE_IDS 白名單', () => {
    const row = makeMinimalRow({
      eliminationReasons: ['淘汰1: 尚未走出底部'],
      entryProhibitionReasons: ['戒律2：上漲第3根以上勿追高'],
    });
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-3', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const allIds = [
      ...q.bookRulesRef.sixConditions.map((e) => e.ruleId),
      ...q.bookRulesRef.longProhibitions.map((e) => e.ruleId),
      ...q.bookRulesRef.eliminations.map((e) => e.ruleId),
    ];
    for (const id of allIds) {
      expect(KNOWN_BOOK_RULE_IDS.has(id)).toBe(true);
    }
  });

  test('eliminationReasons「淘汰7」被提取為 e-07，triggered=true', () => {
    const row = makeMinimalRow({
      eliminationReasons: ['淘汰7: 頭頭低+MACD背離'],
    });
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-4', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const e07 = q.bookRulesRef.eliminations.find((e) => e.ruleId === 'e-07');
    expect(e07).toBeDefined();
    expect(e07?.triggered).toBe(true);
  });

  test('entryProhibitionReasons「戒律8」被提取為 p-08，triggered=true', () => {
    const row = makeMinimalRow({
      entryProhibitionReasons: ['戒律8：空頭趨勢下的紅K反彈，勿進場做多'],
    });
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-5', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const p08 = q.bookRulesRef.longProhibitions.find((e) => e.ruleId === 'p-08');
    expect(p08).toBeDefined();
    expect(p08?.triggered).toBe(true);
  });

  test('無 eliminationReasons 時，所有 e-xx 全為 triggered=false', () => {
    const row = makeMinimalRow({ eliminationReasons: [] });
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-6', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    for (const e of q.bookRulesRef.eliminations) {
      expect(e.triggered).toBe(false);
    }
  });

  test('bookRulesRef.eliminations 固定包含 e-01 ~ e-11 全部 11 條', () => {
    const row = makeMinimalRow();
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-7', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const ids = q.bookRulesRef.eliminations.map((e) => e.ruleId);
    for (const expected of ELIMINATION_RULE_IDS) {
      expect(ids).toContain(expected);
    }
    expect(ids.length).toBe(ELIMINATION_RULE_IDS.length);
  });

  test('bookRulesRef.longProhibitions 固定包含 p-01 ~ p-10 全部 10 條', () => {
    const row = makeMinimalRow();
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-8', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const ids = q.bookRulesRef.longProhibitions.map((e) => e.ruleId);
    for (const expected of LONG_PROHIBITION_RULE_IDS) {
      expect(ids).toContain(expected);
    }
    expect(ids.length).toBe(LONG_PROHIBITION_RULE_IDS.length);
  });

  test('thresholdsSummary 包含 strategyId + 核心閾值欄位', () => {
    const row = makeMinimalRow();
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-9', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    expect(q.thresholdsSummary.strategyId).toBe('zhu-v12');
    expect(typeof q.thresholdsSummary.volumeRatioMin).toBe('number');
    expect(typeof q.thresholdsSummary.kdMaxEntry).toBe('number');
    expect(typeof q.thresholdsSummary.minScore).toBe('number');
  });

  test('groundTruth.mtfMode 反映 session.buyMethod', () => {
    const row = makeMinimalRow();
    const session = { ...makeSession(row), buyMethod: 'B' as const };
    const q = buildTechnicalQuestion({
      runId: 'test-run-10', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    expect(q.groundTruth.mtfMode).toBe('B');
  });

  test('SIX_CONDITION_RULE_IDS 全 6 條都在 bookRulesRef.sixConditions', () => {
    const row = makeMinimalRow();
    const session = makeSession(row);
    const q = buildTechnicalQuestion({
      runId: 'test-run-11', date: '2026-05-22', symbol: '2330',
      session, candidateRow: row, strategy: makeStrategy(),
    });
    const foundIds = q.bookRulesRef.sixConditions.map((e) => e.ruleId);
    for (const id of SIX_CONDITION_RULE_IDS) {
      expect(foundIds).toContain(id);
    }
  });
});
