import type {
  DabanScanResult,
  DabanScanSession,
  StockScanResult,
} from '../scanner/types';
import { listDabanDates, loadDabanSession } from '../storage/dabanStorage';

/**
 * 把 DabanScanResult 轉成 StockScanResult，讓每日操作助手共用同一條 pipeline
 *
 * 規則：
 * - price = 今日漲停收盤（buy 入會看 buyThresholdPrice = closePrice × 1.02）
 * - changePercent = 今日漲幅 ≈ limitUpPct
 * - sixConditionsScore = 6（打板候選視為滿分；面板門檻才不會卡掉）
 * - 用 triggeredRules 帶上「打板訊號」
 * - 用 entryProhibitionReasons 不帶，所以不會被當禁止
 */
export function dabanToScanResult(d: DabanScanResult): StockScanResult {
  const entry = d.openConfirmed && typeof d.openPrice === 'number'
    ? d.openPrice
    : d.buyThresholdPrice;

  return {
    symbol: d.symbol,
    name: d.name,
    market: 'CN',
    industry: undefined,
    price: entry,
    changePercent: d.limitUpPct,
    volume: 0,
    triggeredRules: [
      {
        ruleId: 'daban',
        ruleName: '打板買進法',
        signalType: 'BUY',
        reason: `${d.limitUpType} (${d.consecutiveBoards} 板)・成交額 ${(d.turnover / 1e8).toFixed(2)} 億`,
      },
    ],
    sixConditionsScore: 6,
    sixConditionsBreakdown: { trend: true, position: true, kbar: true, ma: true, volume: true, indicator: true },
    trendState: '多頭',
    trendPosition: `${d.limitUpType}（${d.consecutiveBoards} 板）`,
    scanTime: d.scanDate,
    turnoverRank: 0,
  };
}

/**
 * 載入指定日期的打板 session 並轉為 StockScanResult[]
 * 會過濾掉「一字板」（買不到）
 */
export async function loadDabanCandidatesForDate(date: string): Promise<{
  session: DabanScanSession | null;
  results: StockScanResult[];
}> {
  const session = await loadDabanSession(date);
  if (!session) return { session: null, results: [] };
  const filtered = session.results.filter(r => !r.isYiZiBan);
  return {
    session,
    results: filtered.map(dabanToScanResult),
  };
}

/** 取最新一場打板 session 作為候選池 */
export async function loadLatestDabanCandidates(): Promise<{
  date: string;
  session: DabanScanSession | null;
  results: StockScanResult[];
}> {
  const dates = await listDabanDates();
  if (dates.length === 0) {
    return { date: '', session: null, results: [] };
  }
  const latest = dates[0];
  const { session, results } = await loadDabanCandidatesForDate(latest.date);
  return { date: latest.date, session, results };
}
