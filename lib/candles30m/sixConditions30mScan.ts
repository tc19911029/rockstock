/**
 * 六條件(30分K)掃描 — 純函式,吃 30分K宇宙,套「原封不動」的六條件(ZHU_PURE_BOOK)。
 *
 * 重用不可改:evaluateSixConditions / computeIndicators / detectTrend / detectTrendPosition / ZHU_PURE_BOOK。
 * 這只是把同一套六條件跑在 30分K 序列上(鐵則 #5:選股邏輯單一事實,不加自創因子)。
 */
import type { Candle } from '@/types/index';
import type { StockScanResult, MarketId } from '@/lib/scanner/types';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions, detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';

const MIN_BARS = 60; // MA60 暖機需 ≥60 根 30分K

export interface Scan30mStats {
  universe: number;    // 宇宙檔數
  evaluated: number;   // 根數足夠、有跑六條件的檔數
  tooFew: number;      // 根數 <60 暖機不足
  passed: number;      // 六條件 5/5 通過
}

export interface Scan30mMeta {
  name?: string;
  industry?: string;
  turnoverRank?: number;
}

function dayOf(barDate: string): string { return barDate.slice(0, 10); }

/**
 * @param universe  symbol(帶 .TW) → 升序 30分K
 * @param metaMap   symbol(帶 .TW) → { name, industry, turnoverRank }
 * @param scanTime  ISO 時間戳(寫進每筆結果)
 */
export function scanSixConditions30m(
  universe: Record<string, Candle[]>,
  metaMap: Map<string, Scan30mMeta>,
  scanTime: string,
): { results: StockScanResult[]; stats: Scan30mStats } {
  const thresholds = ZHU_PURE_BOOK.thresholds;
  const minScore = thresholds.minScore ?? 5;
  const results: StockScanResult[] = [];
  const stats: Scan30mStats = { universe: 0, evaluated: 0, tooFew: 0, passed: 0 };

  for (const [sym, candles] of Object.entries(universe)) {
    if (sym.startsWith('^')) continue; // 跳過指數
    stats.universe++;
    if (!Array.isArray(candles) || candles.length < MIN_BARS) { stats.tooFew++; continue; }
    stats.evaluated++;

    const ci = computeIndicators(candles);
    const lastIdx = ci.length - 1;
    const last = ci[lastIdx];

    let sixConds;
    try {
      sixConds = evaluateSixConditions(ci, lastIdx, thresholds);
    } catch { continue; }
    if (!sixConds.isCoreReady || sixConds.totalScore < minScore) continue;

    // 日內漲跌幅 = vs 前一交易日最後一根 30分K 收盤(真·當日漲跌%)
    const lastDay = dayOf(candles[lastIdx].date);
    let prevClose = candles[lastIdx - 1]?.close ?? last.close;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (dayOf(candles[i].date) !== lastDay) { prevClose = candles[i].close; break; }
    }
    const changePercent = prevClose > 0 ? +(((last.close - prevClose) / prevClose) * 100).toFixed(2) : 0;

    const meta = metaMap.get(sym);
    const trend = detectTrend(ci, lastIdx);
    const position = detectTrendPosition(ci, lastIdx);

    results.push({
      symbol: sym,
      name: meta?.name ?? sym,
      market: 'TW' as MarketId,
      industry: meta?.industry,
      price: last.close,
      changePercent,
      volume: last.volume,
      triggeredRules: [],
      matchedMethods: ['A30'],        // 自己的池子,不套「含 A」
      sixConditionsScore: sixConds.totalScore,
      sixConditionsBreakdown: {
        trend:     sixConds.trend.pass,
        position:  sixConds.position.pass,
        kbar:      sixConds.kbar.pass,
        ma:        sixConds.ma.pass,
        volume:    sixConds.volume.pass,
        indicator: sixConds.indicator.pass,
      },
      trendState: trend,
      trendPosition: position,
      scanTime,
      turnoverRank: meta?.turnoverRank,
    });
    stats.passed++;
  }

  // 依六條件分數 → 漲跌幅排序(高分優先,同分漲多優先)
  results.sort((a, b) => (b.sixConditionsScore - a.sixConditionsScore) || (b.changePercent - a.changePercent));
  return { results, stats };
}
