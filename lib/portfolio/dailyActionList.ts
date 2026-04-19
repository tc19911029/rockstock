import type { CandleWithIndicators } from '../../types';
import type { MarketId, StockScanResult } from '../scanner/types';
import type { ProhibitionContext } from '../rules/entryProhibitions';
import { allocateCapital, getDefaultConfig } from './capitalAllocator';
import { monitorHolding } from './holdingMonitor';
import type {
  DailyActionList,
  Holding,
  HoldingMonitor,
  MarketAccountSummary,
  WatchItem,
} from './types';

export interface ComposeDailyActionInput {
  asOfDate: string;
  market: MarketId | 'ALL';
  /** 各市場現金（兩個獨立帳戶） */
  cashBalance: Record<MarketId, number>;
  /** 從現金中保留多少 % 不買股票（每市場通用，預設 0） */
  cashReservePct: number;
  holdings: Holding[];
  /** Map<symbol, CandleWithIndicators[]> 進場日至今的 K 棒（含指標） */
  holdingCandles: Map<string, CandleWithIndicators[]>;
  /** Map<symbol, currentPrice> L2 最新報價，缺值時用 candles 末根 close */
  currentPrices: Map<string, number>;
  /** Map<symbol, institutionalHistory> 法人籌碼歷史（戒律 8 用），可選 */
  institutionalHistory?: Map<string, ProhibitionContext['institutionalHistory']>;
  /** 候選池（已用 applyPanelFilter 排序），按市場分開 */
  candidatesByMarket: Partial<Record<MarketId, StockScanResult[]>>;
}

/**
 * 純函式組合層：把監控結果 + 資金分配組成 DailyActionList
 * 不做任何 I/O；I/O 由 API route 負責
 *
 * 資金邏輯（TW/CN 完全獨立）：
 *   各市場 totalCapital = 該市場持倉市值 + 該市場 cashBalance
 *   各市場 cashAvailable = cashBalance × (1 - cashReservePct/100)
 *   2% 風險基數用各市場自己的 totalCapital
 */
export function composeDailyActionList(input: ComposeDailyActionInput): DailyActionList {
  const {
    asOfDate, market, cashBalance, cashReservePct,
    holdings, holdingCandles, currentPrices, institutionalHistory,
    candidatesByMarket,
  } = input;

  // ── 1. 持倉監控（全市場一次跑完）─────────────────────────────────────
  const monitors: HoldingMonitor[] = [];
  for (const holding of holdings) {
    const candles = holdingCandles.get(holding.symbol) ?? [];
    if (candles.length === 0) continue;
    monitors.push(monitorHolding({
      holding,
      candles,
      currentPrice: currentPrices.get(holding.symbol),
      institutionalHistory: institutionalHistory?.get(holding.symbol),
    }));
  }

  // ── 2. 各市場帳戶獨立計算 ───────────────────────────────────────────
  const buyRecommendations = [];
  const watchList: WatchItem[] = [];
  const accounts: MarketAccountSummary[] = [];
  const markets: MarketId[] = market === 'ALL' ? ['TW', 'CN'] : [market];

  for (const m of markets) {
    const marketMonitors = monitors.filter(x => x.market === m);
    const marketHoldings = holdings.filter(h => h.market === m);
    const candidates = candidatesByMarket[m] ?? [];

    const invested = marketMonitors.reduce((sum, x) => sum + x.marketValue, 0);
    const totalCost = marketMonitors.reduce((sum, x) => sum + x.costPrice * x.shares, 0);
    const upl = invested - totalCost;
    const uplPct = totalCost > 0 ? (upl / totalCost) * 100 : 0;
    const cash = cashBalance[m] ?? 0;
    const totalCapital = invested + cash;
    const cashAvailableInitial = Math.max(0, cash * (1 - cashReservePct / 100));

    const config = getDefaultConfig(m, totalCapital);
    const result = allocateCapital({
      config,
      currentHoldings: marketHoldings,
      candidates,
      cashAvailable: cashAvailableInitial,
    });
    buyRecommendations.push(...result.recommendations);

    accounts.push({
      market: m,
      cashBalance: +cash.toFixed(0),
      invested: +invested.toFixed(0),
      totalCapital: +totalCapital.toFixed(0),
      cashAvailable: +result.cashRemaining.toFixed(0),
      unrealizedPL: +upl.toFixed(0),
      unrealizedPLPct: +uplPct.toFixed(2),
    });

    // 候選池中沒被推薦但分數高的 → 觀察清單
    const recommendedSymbols = new Set(result.recommendations.map(r => r.symbol));
    const heldSymbols = new Set(marketHoldings.map(h => h.symbol));
    for (const c of candidates.slice(0, 10)) {
      if (recommendedSymbols.has(c.symbol) || heldSymbols.has(c.symbol)) continue;
      watchList.push({
        symbol: c.symbol,
        name: c.name,
        market: c.market,
        currentPrice: c.price,
        reason: `六條件 ${c.sixConditionsScore}/6（資金/額度滿）`,
      });
      if (watchList.length >= 5) break;
    }
  }

  // ── 3. 全帳戶合計（DailyActionList 仍提供 top-level 摘要） ─────────────
  const sumTotalCapital = accounts.reduce((s, a) => s + a.totalCapital, 0);
  const sumInvested = accounts.reduce((s, a) => s + a.invested, 0);
  const sumCashAvailable = accounts.reduce((s, a) => s + a.cashAvailable, 0);
  const sumUPL = accounts.reduce((s, a) => s + a.unrealizedPL, 0);
  const sumCost = sumInvested - sumUPL;
  const sumUPLPct = sumCost > 0 ? (sumUPL / sumCost) * 100 : 0;

  return {
    asOfDate,
    market,
    totalCapital: +sumTotalCapital.toFixed(0),
    invested: +sumInvested.toFixed(0),
    cashAvailable: +sumCashAvailable.toFixed(0),
    cashReservePct,
    unrealizedPL: +sumUPL.toFixed(0),
    unrealizedPLPct: +sumUPLPct.toFixed(2),
    holdings: monitors,
    buyRecommendations,
    watchList,
    accounts,
  };
}
