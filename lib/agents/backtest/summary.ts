/**
 * 區間 Backtest summary — 統計各 action / 各 agent verdict 的平均收益與勝率
 *
 * 規則：
 *   - winRateD5 = 樣本中 d5Return > 0 的比例
 *   - avgD5Return = sum(d5Return) / sampleSize
 *   - 樣本只計入 d5Return != null 的（避免存活偏差）
 */

import type {
  AgentAccuracyStats,
  BacktestReport,
  BacktestSummary,
} from './types';
import { BACKTEST_SCHEMA_VERSION } from './types';
const AGENT_KEYS = ['technical', 'news', 'chip', 'fundamental', 'risk'] as const;

export function aggregateBacktestSummary(
  reports: BacktestReport[],
  from: string,
  to: string,
): BacktestSummary {
  const allEntries = reports.flatMap(r => r.entries);

  const byAction: BacktestSummary['byAction'] = {
    buy:   computeStats(allEntries.filter(e => e.action === 'buy')),
    watch: computeStats(allEntries.filter(e => e.action === 'watch')),
    skip:  computeStats(allEntries.filter(e => e.action === 'skip')),
  };

  const agentAccuracy: AgentAccuracyStats[] = AGENT_KEYS.map(agent => {
    const byVerdict: AgentAccuracyStats['byVerdict'] = {};
    // 對該 agent 收集所有 verdict 值
    const verdictMap = new Map<string, typeof allEntries>();
    for (const e of allEntries) {
      const v = e.verdictsByAgent[agent];
      if (!v) continue;
      const arr = verdictMap.get(v) ?? [];
      arr.push(e);
      verdictMap.set(v, arr);
    }
    for (const [verdict, entries] of verdictMap) {
      byVerdict[verdict] = computeStats(entries);
    }
    return { agent, byVerdict };
  });

  return {
    schemaVersion: BACKTEST_SCHEMA_VERSION,
    from,
    to,
    totalDecisions: allEntries.length,
    byAction,
    agentAccuracy,
  };
}

function computeStats(entries: BacktestReport['entries']): {
  sampleSize: number;
  avgD1Return: number | null;
  avgD5Return: number | null;
  avgD20Return: number | null;
  winRateD5: number | null;
  winRateD20: number | null;
} {
  const d1 = entries.map(e => e.d1Return).filter((v): v is number => v != null);
  const d5 = entries.map(e => e.d5Return).filter((v): v is number => v != null);
  const d20 = entries.map(e => e.d20Return).filter((v): v is number => v != null);
  const avg = (arr: number[]): number | null => arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
  const winRate = (arr: number[]): number | null => arr.length === 0 ? null : arr.filter(x => x > 0).length / arr.length;
  return {
    sampleSize: entries.length,
    avgD1Return:  avg(d1),
    avgD5Return:  avg(d5),
    avgD20Return: avg(d20),
    winRateD5:  winRate(d5),
    winRateD20: winRate(d20),
  };
}
