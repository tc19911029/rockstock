import type { MarketId, StockScanResult } from '@/lib/scanner/types';

export interface FundamentalScanRow {
  symbol: string;
  name: string;
  todayPrice: number;
  breakdown: { total: number; grade: string };
  baseUpside: number | null;
}

/** 將 V 軌分數放在專用欄位，禁止偽裝成 0–6 的六條件分數。 */
export function adaptFundamentalRows(
  rows: FundamentalScanRow[],
  market: MarketId,
  computedAt: string,
): StockScanResult[] {
  return rows.map(row => ({
    symbol: row.symbol,
    name: row.name,
    market,
    price: row.todayPrice,
    changePercent: 0,
    volume: 0,
    triggeredRules: [{
      ruleId: 'fundamental-revaluation',
      ruleName: `基本面補漲 ${row.breakdown.grade}`,
      signalType: 'BUY',
      reason: `基本面評分 ${row.breakdown.total}；中性上漲空間 ${row.baseUpside == null ? '資料不足' : `${(row.baseUpside * 100).toFixed(1)}%`}`,
    }],
    matchedMethods: ['V'],
    sixConditionsScore: 0,
    strategyScore: row.breakdown.total,
    strategyScoreScale: 100,
    strategyScoreLabel: '基本面補漲評分',
    sixConditionsBreakdown: { trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false },
    trendState: '盤整',
    trendPosition: '基本面策略（不使用六條件分數）',
    scanTime: computedAt,
  }));
}
