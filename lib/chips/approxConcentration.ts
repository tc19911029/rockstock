export interface BrokerNetPoint {
  date: string;
  netDifference: number;
}

export interface VolumePoint {
  date: string;
  volume: number;
}

export interface ApproxConcentrationResult {
  value: number | null;
  presentDays: number;
  requiredDays: number;
  coverage: number;
}

/**
 * Yahoo 每日「前 15 大買賣超淨額」近似 N 日集中度。
 *
 * 這不是 FinMind 全分點的「整段重新排名」正式公式，因此回傳結果必須標為 approximate。
 * 容許少量單日快照缺漏，但至少需 60% 天數；分母只採有分點快照的同日成交量。
 */
export function calculateApproxBrokerConcentration(
  candles: readonly VolumePoint[],
  broker: readonly BrokerNetPoint[],
  asOfDate: string,
  period: number,
  minCoverage = 0.6,
): ApproxConcentrationResult {
  const eligible = candles.filter(candle => candle.date <= asOfDate).slice(-period);
  const requiredDays = eligible.length;
  if (requiredDays < period) {
    return { value: null, presentDays: 0, requiredDays, coverage: 0 };
  }

  const byDate = new Map(broker.map(point => [point.date, point.netDifference]));
  let net = 0;
  let volume = 0;
  let presentDays = 0;
  for (const candle of eligible) {
    const dayNet = byDate.get(candle.date);
    if (dayNet == null || !Number.isFinite(dayNet)) continue;
    net += dayNet;
    volume += Number.isFinite(candle.volume) ? candle.volume : 0;
    presentDays++;
  }
  const coverage = requiredDays > 0 ? presentDays / requiredDays : 0;
  const value = coverage >= minCoverage && volume > 0
    ? +((net / volume) * 100).toFixed(2)
    : null;
  return { value, presentDays, requiredDays, coverage: +coverage.toFixed(4) };
}
