import type { YahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';

export const LARGE_TRADE_RATIO_THRESHOLD = 70;
export const LARGE_DIFF_RATIO_THRESHOLD = 20;

export type SmartMoneyRotationZone = 'leading' | 'improving' | 'weakening' | 'lagging';

export interface SmartMoneyRotationPoint {
  code: string;
  name: string | null;
  date: string;
  /** Yahoo 前 15 大買方分點的實際買進張數合計。 */
  largeBuyVolume: number;
  /** Yahoo 前 15 大賣方分點的實際賣出張數合計。 */
  largeSellVolume: number;
  /** Yahoo 主力集中度反推、或 L1 K 線取得的當日總成交張數。 */
  totalVolume: number;
  /** （大戶買進 + 大戶賣出）÷ 總成交量 × 100。 */
  largeTradeRatio: number;
  /** （大戶買進 − 大戶賣出）÷ 總成交量 × 100。 */
  largeDiffRatio: number;
  largeBuyShare: number;
  largeSellShare: number;
  zone: SmartMoneyRotationZone;
  source: 'yahoo_top15_volume_proxy';
}
export function classifySmartMoneyRotation(
  largeTradeRatio: number,
  largeDiffRatio: number,
): SmartMoneyRotationZone {
  if (largeTradeRatio >= LARGE_TRADE_RATIO_THRESHOLD) {
    return largeDiffRatio >= LARGE_DIFF_RATIO_THRESHOLD ? 'leading' : 'weakening';
  }
  return largeDiffRatio >= LARGE_DIFF_RATIO_THRESHOLD ? 'improving' : 'lagging';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 將 Yahoo 券商分點資料依節目圖上的公式轉成四象限座標。
 *
 * Yahoo 沒有 XQ 的逐筆「大單／特大單成交金額」，所以這裡以：
 * - 大戶買進：前 15 大買方分點的 gross buy volume
 * - 大戶賣出：前 15 大賣方分點的 gross sell volume
 * 作張數等價近似。不能標示為 XQ 原始數值。
 */
export function rotationPointFromYahoo(args: {
  code: string;
  name?: string | null;
  trades: YahooBrokerTrades;
  fallbackTotalVolume?: number | null;
}): SmartMoneyRotationPoint | null {
  const { code, name = null, trades } = args;
  const largeBuyVolume = trades.buyerRankList.reduce((sum, row) => sum + row.buyVolK, 0);
  const largeSellVolume = trades.sellerRankList.reduce((sum, row) => sum + row.sellVolK, 0);

  // Yahoo tradeVolumeRate 是正值，方向另看 totalDifferenceVolK。
  // 因此以 abs(net) / concentration 反推單邊總成交量；無法反推時才退回 L1。
  const impliedTotalVolume = trades.concentration > 0 && trades.totalDifferenceVolK !== 0
    ? Math.abs(trades.totalDifferenceVolK) / trades.concentration
    : null;
  const totalVolume = impliedTotalVolume && Number.isFinite(impliedTotalVolume) && impliedTotalVolume > 0
    ? impliedTotalVolume
    : args.fallbackTotalVolume;

  if (!(totalVolume && Number.isFinite(totalVolume) && totalVolume > 0)) return null;

  const largeBuyShare = (largeBuyVolume / totalVolume) * 100;
  const largeSellShare = (largeSellVolume / totalVolume) * 100;
  const largeTradeRatio = largeBuyShare + largeSellShare;
  const largeDiffRatio = largeBuyShare - largeSellShare;

  return {
    code,
    name,
    date: trades.date,
    largeBuyVolume: round2(largeBuyVolume),
    largeSellVolume: round2(largeSellVolume),
    totalVolume: round2(totalVolume),
    largeTradeRatio: round2(largeTradeRatio),
    largeDiffRatio: round2(largeDiffRatio),
    largeBuyShare: round2(largeBuyShare),
    largeSellShare: round2(largeSellShare),
    zone: classifySmartMoneyRotation(largeTradeRatio, largeDiffRatio),
    source: 'yahoo_top15_volume_proxy',
  };
}
