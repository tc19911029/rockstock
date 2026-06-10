/**
 * 各券商命中率 scorecard — 跨歷史報告統計「喊完之後真的對嗎」。
 *
 * 命中定義（合約測試鎖）：
 *   - 只納入「已結算」call：performance.status==='fresh'（d1-d20 全到位 = 報告日後 ≥20 交易日且有資料）
 *   - 只納入「方向性」call：covered && sentiment ∈ {bullish, bearish}（neutral/mentioned_only 無方向，不計）
 *   - bullish 命中 = d20Return > 0；bearish 命中 = d20Return < 0
 *   - target_reached_rate 另計（達標度，僅對有目標價者）
 *
 * 重用 computeBrokerPerformance（逐日算 performance + target），不重造漲跌幅邏輯。
 */

import { listReportDates } from './brokerStorage';
import { computeBrokerPerformance } from './brokerPerformance';

export interface BrokerScorecard {
  broker: string;
  broker_display: string;
  total_calls: number;          // 已結算的方向性 call 數
  hits: number;
  hit_rate: number | null;      // hits / total_calls
  d20_positive_rate: number | null;
  avg_d20_return: number | null;
  avg_max_gain: number | null;
  avg_max_loss: number | null;
  target_calls: number;         // 有目標價的方向性 call
  target_reached: number;
  target_reached_rate: number | null;
  sample_dates: string[];
}

export interface ScorecardResult {
  generated_at: string;
  window: { start: string; end: string } | null;
  min_settled_note: string;
  brokers: BrokerScorecard[];
}

interface Acc {
  broker: string;
  broker_display: string;
  total: number;
  hits: number;
  d20pos: number;
  d20sum: number;
  maxGainSum: number;
  maxLossSum: number;
  targetCalls: number;
  targetReached: number;
  dates: Set<string>;
}

const avg = (sum: number, n: number): number | null => (n > 0 ? Math.round((sum / n) * 100) / 100 : null);
const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

export async function computeScorecard(opts?: { start?: string; end?: string }): Promise<ScorecardResult> {
  let dates = await listReportDates();
  if (opts?.start) dates = dates.filter(d => d >= opts.start!);
  if (opts?.end) dates = dates.filter(d => d <= opts.end!);
  dates = dates.sort();

  const accByBroker = new Map<string, Acc>();

  for (const date of dates) {
    const dayPerf = await computeBrokerPerformance(date);
    for (const it of dayPerf.items) {
      // 只納入已結算（fresh）+ 方向性 + covered
      if (it.performance.status !== 'fresh') continue;
      if (!it.covered) continue;
      if (it.sentiment !== 'bullish' && it.sentiment !== 'bearish') continue;
      const d20 = it.performance.d20Return;
      if (d20 == null) continue;

      let acc = accByBroker.get(it.broker);
      if (!acc) {
        acc = {
          broker: it.broker, broker_display: it.broker_display,
          total: 0, hits: 0, d20pos: 0, d20sum: 0, maxGainSum: 0, maxLossSum: 0,
          targetCalls: 0, targetReached: 0, dates: new Set(),
        };
        accByBroker.set(it.broker, acc);
      }
      acc.total += 1;
      acc.dates.add(it.report_date);
      acc.d20sum += d20;
      if (d20 > 0) acc.d20pos += 1;
      if (it.performance.maxGain != null) acc.maxGainSum += it.performance.maxGain;
      if (it.performance.maxLoss != null) acc.maxLossSum += it.performance.maxLoss;

      const hit = it.sentiment === 'bullish' ? d20 > 0 : d20 < 0;
      if (hit) acc.hits += 1;

      if (it.target_price != null && !it.target.currencyMismatch) {
        acc.targetCalls += 1;
        if (it.target.reached) acc.targetReached += 1;
      }
    }
  }

  const brokers: BrokerScorecard[] = Array.from(accByBroker.values())
    .map(a => ({
      broker: a.broker,
      broker_display: a.broker_display,
      total_calls: a.total,
      hits: a.hits,
      hit_rate: rate(a.hits, a.total),
      d20_positive_rate: rate(a.d20pos, a.total),
      avg_d20_return: avg(a.d20sum, a.total),
      avg_max_gain: avg(a.maxGainSum, a.total),
      avg_max_loss: avg(a.maxLossSum, a.total),
      target_calls: a.targetCalls,
      target_reached: a.targetReached,
      target_reached_rate: rate(a.targetReached, a.targetCalls),
      sample_dates: Array.from(a.dates).sort(),
    }))
    .sort((x, y) => (y.hit_rate ?? -1) - (x.hit_rate ?? -1) || y.total_calls - x.total_calls);

  return {
    generated_at: new Date().toISOString(),
    window: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    min_settled_note: '只統計報告日後滿 20 交易日且 K 線到位（performance.status=fresh）的方向性 covered call；未結算不進分母。',
    brokers,
  };
}
