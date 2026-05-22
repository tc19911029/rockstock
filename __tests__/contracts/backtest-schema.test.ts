/**
 * Contract test：Backtest schema + summary 聚合
 */

import { aggregateBacktestSummary } from '@/lib/agents/backtest/summary';
import {
  BACKTEST_SCHEMA_VERSION,
  BacktestEntry,
  BacktestReport,
} from '@/lib/agents/backtest/types';

function makeEntry(o: Partial<BacktestEntry> = {}): BacktestEntry {
  return {
    symbol: '2330.TW', name: '台積電', market: 'TW',
    action: 'buy', decisionPath: 'buy_signal',
    bullScore: 12, bearScore: 8, sizeHint: 1,
    verdictsByAgent: { technical: 'pass', news: 'pass', chip: 'pass', fundamental: 'pass', risk: 'green' },
    entryPrice: 1000,
    d1Return: 1.5, d2Return: 2, d3Return: 2.5, d5Return: 3, d10Return: 5, d20Return: 8,
    maxGain: 10, maxLoss: -2,
    ...o,
  };
}

function makeReport(entries: BacktestEntry[]): BacktestReport {
  return {
    schemaVersion: BACKTEST_SCHEMA_VERSION,
    date: '2026-05-22', market: 'TW',
    generatedAt: new Date().toISOString(),
    computedThrough: 'd20+',
    entries,
  };
}

describe('Backtest summary 聚合', () => {
  test('單筆 buy 計算 avg + winRate', () => {
    const summary = aggregateBacktestSummary(
      [makeReport([makeEntry()])],
      '2026-05-22', '2026-05-22',
    );
    expect(summary.totalDecisions).toBe(1);
    expect(summary.byAction.buy.sampleSize).toBe(1);
    expect(summary.byAction.buy.avgD5Return).toBe(3);
    expect(summary.byAction.buy.winRateD5).toBe(1);  // 3 > 0
  });

  test('多筆混合 buy/watch/skip', () => {
    const summary = aggregateBacktestSummary(
      [makeReport([
        makeEntry({ action: 'buy', d5Return: 5 }),
        makeEntry({ action: 'buy', d5Return: -2 }),
        makeEntry({ action: 'watch', d5Return: 1 }),
        makeEntry({ action: 'skip', d5Return: -3 }),
      ])],
      '2026-05-22', '2026-05-22',
    );
    expect(summary.byAction.buy.sampleSize).toBe(2);
    expect(summary.byAction.buy.avgD5Return).toBe(1.5);  // (5 + -2) / 2
    expect(summary.byAction.buy.winRateD5).toBe(0.5);    // 1/2
    expect(summary.byAction.watch.sampleSize).toBe(1);
    expect(summary.byAction.skip.sampleSize).toBe(1);
  });

  test('null return 不算進 sample', () => {
    const summary = aggregateBacktestSummary(
      [makeReport([
        makeEntry({ d5Return: 5 }),
        makeEntry({ d5Return: null }),
        makeEntry({ d5Return: 3 }),
      ])],
      '2026-05-22', '2026-05-22',
    );
    expect(summary.byAction.buy.avgD5Return).toBe(4);  // (5 + 3) / 2 — null 排除
  });

  test('Agent verdict 統計', () => {
    const summary = aggregateBacktestSummary(
      [makeReport([
        makeEntry({ verdictsByAgent: { technical: 'pass', news: null, chip: null, fundamental: null, risk: null }, d5Return: 5 }),
        makeEntry({ verdictsByAgent: { technical: 'pass', news: null, chip: null, fundamental: null, risk: null }, d5Return: 3 }),
        makeEntry({ verdictsByAgent: { technical: 'watch', news: null, chip: null, fundamental: null, risk: null }, d5Return: -1 }),
        makeEntry({ verdictsByAgent: { technical: 'fail', news: null, chip: null, fundamental: null, risk: null }, d5Return: -5 }),
      ])],
      '2026-05-22', '2026-05-22',
    );
    const tech = summary.agentAccuracy.find(a => a.agent === 'technical')!;
    expect(tech.byVerdict.pass.sampleSize).toBe(2);
    expect(tech.byVerdict.pass.avgD5Return).toBe(4);
    expect(tech.byVerdict.pass.winRateD5).toBe(1);  // 兩個都 > 0
    expect(tech.byVerdict.watch.sampleSize).toBe(1);
    expect(tech.byVerdict.fail.sampleSize).toBe(1);
    expect(tech.byVerdict.fail.winRateD5).toBe(0);
  });

  test('Risk green/yellow/red 各自統計', () => {
    const summary = aggregateBacktestSummary(
      [makeReport([
        makeEntry({ verdictsByAgent: { technical: null, news: null, chip: null, fundamental: null, risk: 'green' }, d5Return: 5 }),
        makeEntry({ verdictsByAgent: { technical: null, news: null, chip: null, fundamental: null, risk: 'yellow' }, d5Return: 1 }),
        makeEntry({ verdictsByAgent: { technical: null, news: null, chip: null, fundamental: null, risk: 'red' }, d5Return: -10 }),
      ])],
      '2026-05-22', '2026-05-22',
    );
    const risk = summary.agentAccuracy.find(a => a.agent === 'risk')!;
    expect(risk.byVerdict.green.avgD5Return).toBe(5);
    expect(risk.byVerdict.yellow.avgD5Return).toBe(1);
    expect(risk.byVerdict.red.avgD5Return).toBe(-10);
    expect(risk.byVerdict.red.winRateD5).toBe(0);
  });

  test('空 reports 不爆', () => {
    const summary = aggregateBacktestSummary([], '2026-05-01', '2026-05-22');
    expect(summary.totalDecisions).toBe(0);
    expect(summary.byAction.buy.sampleSize).toBe(0);
    expect(summary.byAction.buy.avgD5Return).toBeNull();
    expect(summary.byAction.buy.winRateD5).toBeNull();
  });

  test('schemaVersion + from/to 正確帶上', () => {
    const summary = aggregateBacktestSummary([], '2026-05-01', '2026-05-22');
    expect(summary.schemaVersion).toBe(1);
    expect(summary.from).toBe('2026-05-01');
    expect(summary.to).toBe('2026-05-22');
  });
});
