/**
 * Unit test：Technical Agent buildTechnicalQuestion regex 抽取
 *
 * 驗證從 candidateRow.eliminationReasons / longProhibitionsReasons 字串
 * 正確抽出 ruleId（e-XX / p-XX），並標 triggered。
 *
 * 5/22 daily session 所有候選都沒觸發戒律/淘汰，所以這裡用合成 candidateRow。
 */

import { buildTechnicalQuestion } from '@/lib/agents/agents/technicalAgent';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';
import type { ScanSession, StockScanResult } from '@/lib/scanner/types';

function makeMockSession(row: StockScanResult): ScanSession {
  return {
    id: 'test',
    market: 'TW',
    date: '2026-05-22',
    direction: 'long',
    sessionType: 'post_close',
    scanTime: '2026-05-22T10:00:00.000Z',
    multiTimeframeEnabled: false,
    resultCount: 1,
    results: [row],
  } as ScanSession;
}

function makeMockRow(overrides: Partial<StockScanResult> = {}): StockScanResult {
  return {
    symbol: '1234.TW',
    name: '測試',
    market: 'TW',
    price: 100,
    changePercent: 5,
    volume: 1000,
    triggeredRules: [],
    sixConditionsScore: 5,
    sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: false },
    trendState: '多頭',
    trendPosition: '起漲',
    scanTime: '2026-05-22T10:00:00.000Z',
    ...overrides,
  } as StockScanResult;
}

describe('Technical Agent — buildTechnicalQuestion 抽取邏輯', () => {
  test('觸發戒律 8 + 戒律 2 → bookRulesRef.longProhibitions[p-02/p-08].triggered=true', () => {
    const row = makeMockRow({
      longProhibitionsReasons: ['戒律8：空頭趨勢下的紅K反彈', '戒律2：上漲第3根勿追高'],
    });
    const q = buildTechnicalQuestion({
      runId: 'r1', date: '2026-05-22', symbol: row.symbol,
      session: makeMockSession(row), candidateRow: row, strategy: ZHU_PURE_BOOK,
    });
    const p08 = q.bookRulesRef.longProhibitions.find((p) => p.ruleId === 'p-08')!;
    const p02 = q.bookRulesRef.longProhibitions.find((p) => p.ruleId === 'p-02')!;
    const p05 = q.bookRulesRef.longProhibitions.find((p) => p.ruleId === 'p-05')!;
    expect(p08.triggered).toBe(true);
    expect(p02.triggered).toBe(true);
    expect(p05.triggered).toBe(false);
  });

  test('觸發淘汰 R1 + R7 → bookRulesRef.eliminations[e-01/e-07].triggered=true', () => {
    const row = makeMockRow({
      eliminationReasons: ['淘汰1: 尚未走出底部', '淘汰7: 頭頭低+MACD背離'],
    });
    const q = buildTechnicalQuestion({
      runId: 'r1', date: '2026-05-22', symbol: row.symbol,
      session: makeMockSession(row), candidateRow: row, strategy: ZHU_PURE_BOOK,
    });
    const e01 = q.bookRulesRef.eliminations.find((e) => e.ruleId === 'e-01')!;
    const e07 = q.bookRulesRef.eliminations.find((e) => e.ruleId === 'e-07')!;
    const e04 = q.bookRulesRef.eliminations.find((e) => e.ruleId === 'e-04')!;
    expect(e01.triggered).toBe(true);
    expect(e07.triggered).toBe(true);
    expect(e04.triggered).toBe(false);
  });

  test('六條件全過 + 全不觸 → 全部 triggered=true (sixConditions) / false (其他)', () => {
    const row = makeMockRow({
      sixConditionsScore: 6,
      sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true },
    });
    const q = buildTechnicalQuestion({
      runId: 'r1', date: '2026-05-22', symbol: row.symbol,
      session: makeMockSession(row), candidateRow: row, strategy: ZHU_PURE_BOOK,
    });
    for (const c of q.bookRulesRef.sixConditions) {
      expect(c.triggered).toBe(true);
    }
    for (const p of q.bookRulesRef.longProhibitions) expect(p.triggered).toBe(false);
    for (const e of q.bookRulesRef.eliminations) expect(e.triggered).toBe(false);
  });

  test('六條件部分缺 → sixConditions 對應 triggered=false', () => {
    const row = makeMockRow({
      sixConditionsBreakdown: { trend: true, position: false, kbar: true, ma: true, volume: true, indicator: false },
    });
    const q = buildTechnicalQuestion({
      runId: 'r1', date: '2026-05-22', symbol: row.symbol,
      session: makeMockSession(row), candidateRow: row, strategy: ZHU_PURE_BOOK,
    });
    const cPos = q.bookRulesRef.sixConditions.find((c) => c.ruleId === 'c-position')!;
    const cInd = q.bookRulesRef.sixConditions.find((c) => c.ruleId === 'c-indicator')!;
    const cTrend = q.bookRulesRef.sixConditions.find((c) => c.ruleId === 'c-trend')!;
    expect(cPos.triggered).toBe(false);
    expect(cInd.triggered).toBe(false);
    expect(cTrend.triggered).toBe(true);
  });

  test('thresholdsSummary 從 strategy 取出', () => {
    const row = makeMockRow();
    const q = buildTechnicalQuestion({
      runId: 'r1', date: '2026-05-22', symbol: row.symbol,
      session: makeMockSession(row), candidateRow: row, strategy: ZHU_PURE_BOOK,
    });
    expect(q.thresholdsSummary.maShortPeriod).toBe(5);
    expect(q.thresholdsSummary.maMidPeriod).toBe(10);
    expect(q.thresholdsSummary.maLongPeriod).toBe(20);
    expect(q.thresholdsSummary.volumeRatioMin).toBe(1.3);
  });

  test('schemaVersion + agent + runId 正確填入', () => {
    const row = makeMockRow();
    const q = buildTechnicalQuestion({
      runId: 'my-run-id', date: '2026-05-22', symbol: row.symbol,
      session: makeMockSession(row), candidateRow: row, strategy: ZHU_PURE_BOOK,
    });
    expect(q.schemaVersion).toBe(1);
    expect(q.agent).toBe('technical');
    expect(q.runId).toBe('my-run-id');
    expect(q.market).toBe('TW');
  });
});
