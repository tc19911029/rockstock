/**
 * 跨券商共識 — 近窗內同一檔被多家券商同向覆蓋時的加權標記（類比 YouTube 跨節目共識）。
 *
 * 規則：
 *   - 取 asOfDate 往前 windowDays 日曆天內所有報告
 *   - 同券商同股取「最新一份」rating（不重複計票）
 *   - 跨券商計票：bullish_brokers / bearish_brokers
 *   - high_consensus = bullish>=2 || bearish>=2
 */

import { loadReportsInRange } from './brokerStorage';

export interface BrokerConsensusStock {
  stock_code: string;
  stock_name: string;
  bullish_brokers: string[];      // 券商 display 名
  bearish_brokers: string[];
  neutral_brokers: string[];
  broker_count: number;           // distinct 券商數
  net_direction: number;          // bullish - bearish
  avg_target_price: number | null;
  target_price_min: number | null;
  target_price_max: number | null;
  high_consensus: boolean;
  latest_report_date: string;
}

function ymdMinusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function computeConsensus(asOfDate: string, windowDays = 5): Promise<BrokerConsensusStock[]> {
  const start = ymdMinusDays(asOfDate, windowDays);
  const days = await loadReportsInRange(start, asOfDate);

  // 同 (code, broker) 取最新一份
  interface Latest { code: string; name: string; broker: string; broker_display: string; sentiment: string; target: number | null; currency: string; date: string; }
  const latestByKey = new Map<string, Latest>();

  for (const day of days) {
    for (const r of day.reports) {
      for (const s of r.stocks) {
        if (!s.matched) continue; // 只統計台股
        if (s.sentiment === 'mentioned_only') continue; // 純提及（如 Computex 點名）無觀點，不計票
        const key = `${s.matched.code}|${r.broker}`;
        const prev = latestByKey.get(key);
        if (!prev || r.report_date > prev.date) {
          latestByKey.set(key, {
            code: s.matched.code, name: s.matched.name,
            broker: r.broker, broker_display: r.broker_display,
            sentiment: s.sentiment, target: s.target_price, currency: s.report_currency,
            date: r.report_date,
          });
        }
      }
    }
  }

  // 按 code 聚合
  const byCode = new Map<string, {
    name: string;
    bull: Set<string>; bear: Set<string>; neut: Set<string>;
    brokers: Set<string>;
    targets: number[];
    latest: string;
  }>();

  for (const v of latestByKey.values()) {
    let agg = byCode.get(v.code);
    if (!agg) {
      agg = { name: v.name, bull: new Set(), bear: new Set(), neut: new Set(), brokers: new Set(), targets: [], latest: v.date };
      byCode.set(v.code, agg);
    }
    agg.brokers.add(v.broker_display);
    if (v.sentiment === 'bullish') agg.bull.add(v.broker_display);
    else if (v.sentiment === 'bearish') agg.bear.add(v.broker_display);
    else agg.neut.add(v.broker_display);
    if (v.target != null && (v.currency || 'TWD').toUpperCase() === 'TWD') agg.targets.push(v.target);
    if (v.date > agg.latest) agg.latest = v.date;
  }

  const out: BrokerConsensusStock[] = Array.from(byCode.entries()).map(([code, a]) => {
    const targets = a.targets;
    const avgT = targets.length ? Math.round((targets.reduce((s, x) => s + x, 0) / targets.length) * 100) / 100 : null;
    const bull = a.bull.size, bear = a.bear.size;
    return {
      stock_code: code,
      stock_name: a.name,
      bullish_brokers: Array.from(a.bull),
      bearish_brokers: Array.from(a.bear),
      neutral_brokers: Array.from(a.neut),
      broker_count: a.brokers.size,
      net_direction: bull - bear,
      avg_target_price: avgT,
      target_price_min: targets.length ? Math.min(...targets) : null,
      target_price_max: targets.length ? Math.max(...targets) : null,
      high_consensus: bull >= 2 || bear >= 2,
      latest_report_date: a.latest,
    };
  });

  // 高共識優先、券商數多優先
  out.sort((x, y) =>
    Number(y.high_consensus) - Number(x.high_consensus) ||
    y.broker_count - x.broker_count ||
    Math.abs(y.net_direction) - Math.abs(x.net_direction),
  );
  return out;
}
