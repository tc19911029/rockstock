/**
 * 換股建議引擎（Phase 2.2）
 *
 * 為什麼存在：使用者目前零現金 + 100% 半導體集中。任何新進場必須先平倉舊持股。
 * 這支模組依「規則式優先順序」推薦該賣哪檔換新標的，**不加權平均**（與 portfolio-review
 * 整合 action 同樣風格）。
 *
 * 排序規則（top-down match，priority 越小越優先賣）：
 *
 *   priority | reasonPath               | 條件
 *   ---------|--------------------------|----------------------------------
 *   1        | risk_red_force           | review.risk.verdict='red' 或 action='stop_loss'
 *   2        | target_hit_profit_lock   | review.action='take_profit'（達 target）
 *   3        | technical_fail_reduce    | review.action='reduce'（technical_fail）
 *   4        | near_stop_loss           | 距停損 ≤ 3%
 *   5        | deep_underwater          | 含費 returnPct < -5%
 *   6        | hold_observe_neutral     | review.action='hold_observe'
 *   7        | underwater_small         | 含費 returnPct < 0（小賠 — 課程 CH11-1 汰弱換強）
 *   8        | small_gain_lock          | 0 < 含費 returnPct < 5%（小賺鎖利）
 *   9        | strong_hold_keep         | review.action='hold_strong'（最不該賣）
 *   10       | unknown_default          | 無 review 資料
 *
 * ⚠️ 2026-07-20 第七輪：新增 priority 7 小賠級並把 8/9/10 往後推。
 *   課程 CH11-1 逐字稿：「才賺 1% 也是賺的，你就繼續抱；跌 3%、跌 5% 的趕快離開。」
 *   舊版沒有小賠級 → 小賠且無 review 的持倉落到 unknown_default（最末），
 *   排序上竟比「小賺」還晚才被建議賣，與課程原則相反。
 *
 * 同 priority tiebreaker：netReturnPct 升序（賠最多先賣）→ proceedsNet 降序
 *
 * 不變式：
 *   - 純函式，不讀檔不打 API
 *   - **CN holdings 不會被排序**（2026-05-23 用戶決議「不要管陸股」）— caller 端應已過濾
 *   - 不修改輸入的 holdings 陣列
 *   - 信用：netPnL 走 calcNetPnL 含費，不另計
 */

import type { MarketId } from '@/lib/scanner/types';
import { calcNetPnL, FEE_RATES } from '@/lib/portfolio/fees';
import type { PortfolioHoldingReview } from '@/lib/agents/portfolio/types';

export interface HoldingForSwap {
  symbol: string;
  name: string;
  market: MarketId;
  industry?: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stopLoss?: number;
}

export interface SwapCandidate {
  sellSymbol: string;
  sellName: string;
  sellMarket: MarketId;
  sellIndustry?: string;
  currentPrice: number;
  shares: number;
  /** 賣出毛收（含費前） = shares × currentPrice */
  proceedsGross: number;
  /** 含費淨收 = grossProceeds - sellFees */
  proceedsNet: number;
  /** 累計含費損益 % */
  netReturnPct: number;
  /** 距停損百分比；無 stopLoss 回 null。正值表「距下方停損還有多少 buffer」*/
  distanceToStopPct: number | null;
  reasonPath: string;
  priority: number;
  /** 命中此 priority 的根據（給 reasoning 顯示用）*/
  matchedRule: string;
  reviewAction?: string;
  reviewRisk?: string;
  reviewTechnical?: string;
}

/** 純函式：給 holdings + reviews + 現價 → 排序 */
export function rankHoldingsForSwap(args: {
  holdings: readonly HoldingForSwap[];
  currentPrices: ReadonlyMap<string, number>;
  reviewsBySymbol: ReadonlyMap<string, PortfolioHoldingReview>;
}): SwapCandidate[] {
  const candidates: SwapCandidate[] = [];

  for (const h of args.holdings) {
    const currentPrice = args.currentPrices.get(h.symbol);
    if (currentPrice == null || currentPrice <= 0) continue;

    const review = args.reviewsBySymbol.get(h.symbol);
    const proceedsGross = h.shares * currentPrice;
    // 賣出含費（單邊）
    const rates = FEE_RATES[h.market];
    const sellFees = proceedsGross * rates.sell;
    const proceedsNet = proceedsGross - sellFees;
    const { pnlPct: netReturnPct } = calcNetPnL(
      h.symbol, h.shares, h.entryPrice, currentPrice,
    );

    const distanceToStopPct = h.stopLoss
      ? +((currentPrice - h.stopLoss) / h.stopLoss * 100).toFixed(2)
      : null;

    const { priority, reasonPath, matchedRule } = classifyPriority({
      review, netReturnPct, distanceToStopPct,
    });

    candidates.push({
      sellSymbol: h.symbol,
      sellName: h.name,
      sellMarket: h.market,
      sellIndustry: h.industry,
      currentPrice,
      shares: h.shares,
      proceedsGross,
      proceedsNet,
      netReturnPct,
      distanceToStopPct,
      reasonPath,
      priority,
      matchedRule,
      reviewAction: review?.action,
      reviewRisk: review?.risk?.verdict,
      reviewTechnical: review?.technical?.verdict,
    });
  }

  // 排序：priority asc → netReturnPct asc → proceedsNet desc
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.netReturnPct !== b.netReturnPct) return a.netReturnPct - b.netReturnPct;
    return b.proceedsNet - a.proceedsNet;
  });

  return candidates;
}

function classifyPriority(args: {
  review?: PortfolioHoldingReview;
  netReturnPct: number;
  distanceToStopPct: number | null;
}): { priority: number; reasonPath: string; matchedRule: string } {
  const { review, netReturnPct, distanceToStopPct } = args;

  // priority 1: risk red 或 stop_loss
  if (review?.risk?.verdict === 'red' || review?.action === 'stop_loss') {
    return {
      priority: 1,
      reasonPath: 'risk_red_force',
      matchedRule: review?.risk?.verdict === 'red'
        ? `風控紅燈：${review.risk.verdictReason}`
        : `已觸停損規則：${review?.actionPath ?? 'unknown'}`,
    };
  }
  // priority 2: take_profit
  if (review?.action === 'take_profit') {
    return {
      priority: 2,
      reasonPath: 'target_hit_profit_lock',
      matchedRule: `達 target1/target2 鎖利：${review.actionPath} (returnPct=${netReturnPct.toFixed(1)}%)`,
    };
  }
  // priority 3: reduce (technical_fail)
  if (review?.action === 'reduce') {
    return {
      priority: 3,
      reasonPath: 'technical_fail_reduce',
      matchedRule: `技術面失效：${review.technical?.verdictReason ?? review.actionPath}`,
    };
  }
  // priority 4: 距停損 ≤ 3%（即 currentPrice 已接近 stopLoss 下方 3% 內）
  if (distanceToStopPct != null && distanceToStopPct <= 3 && distanceToStopPct >= 0) {
    return {
      priority: 4,
      reasonPath: 'near_stop_loss',
      matchedRule: `距停損僅 ${distanceToStopPct}%，下檔風險高`,
    };
  }
  // priority 5: 浸水較深
  if (netReturnPct < -5) {
    return {
      priority: 5,
      reasonPath: 'deep_underwater',
      matchedRule: `含費 ${netReturnPct.toFixed(1)}%，浸水較深`,
    };
  }
  // priority 6: hold_observe
  if (review?.action === 'hold_observe') {
    return {
      priority: 6,
      reasonPath: 'hold_observe_neutral',
      matchedRule: `review=hold_observe（${review.actionPath}）— 中性可換`,
    };
  }
  // priority 9: hold_strong（強訊號優先 check — 不該因小賠/小賺被誤判賣出）
  if (review?.action === 'hold_strong') {
    return {
      priority: 9,
      reasonPath: 'strong_hold_keep',
      matchedRule: `review=hold_strong — 不建議賣，僅在無更弱選項時考慮`,
    };
  }
  // priority 7: 小賠先走（課程 CH11-1 汰弱換強）
  // 2026-07-20 第七輪補：逐字稿「不管我這個才賺 1%，也是賺的……你就繼續抱。
  // 但手中不要留已經跌 3% 的、跌 5% 的，趕快離開。」
  // 舊版沒有這一級 → 小賠且無 review 資料的持倉落到 unknown_default（最末），
  // 排序上比「小賺」還晚才被建議賣，與課程原則正好相反。
  // 注意：3%/5% 是老師的口語舉例不是門檻表（見 ledger），這裡不設數字門檻，
  // 只做「賠 vs 賺」的相對排序 — 賠的一律排在賺的前面。深水 <-5% 已由 priority 5 接走。
  if (netReturnPct < 0) {
    return {
      priority: 7,
      reasonPath: 'underwater_small',
      matchedRule: `小賠 ${netReturnPct.toFixed(1)}% — 課程：手中只留上漲的，走弱的先淘汰`,
    };
  }
  // priority 8: 小賺鎖利
  if (netReturnPct > 0 && netReturnPct < 5) {
    return {
      priority: 8,
      reasonPath: 'small_gain_lock',
      matchedRule: `小賺 ${netReturnPct.toFixed(1)}% 可鎖利`,
    };
  }
  // priority 10: default
  return {
    priority: 10,
    reasonPath: 'unknown_default',
    matchedRule: '無 review 資料 + 無明顯信號',
  };
}

export interface SwapRecommendation {
  /** 訊號最強的（priority-based）— 不一定資金匹配 */
  recommended: SwapCandidate | null;
  /** 若 targetInvestment 提供，挑「正好覆蓋目標、超出最少」的候選 — 與 recommended 不同時值得另列 */
  sizeFit: SwapCandidate | null;
  alternatives: SwapCandidate[];
  noActionRecommended: boolean;
  reason?: string;
  warnings: string[];
}

/** 對輸入 candidate 給出建議賣哪檔 */
export function recommendSwap(args: {
  candidate: { symbol: string; name: string; entryPrice: number; industry?: string; targetInvestment?: number };
  holdings: readonly HoldingForSwap[];
  currentPrices: ReadonlyMap<string, number>;
  reviewsBySymbol: ReadonlyMap<string, PortfolioHoldingReview>;
}): SwapRecommendation {
  const warnings: string[] = [];

  if (args.holdings.length === 0) {
    return {
      recommended: null,
      sizeFit: null,
      alternatives: [],
      noActionRecommended: true,
      reason: 'no_open_holdings',
      warnings: ['holdings.json 內無 open holdings，無法建議換股；請先匯入持股或走 /api/portfolio/import'],
    };
  }

  const ranked = rankHoldingsForSwap({
    holdings: args.holdings,
    currentPrices: args.currentPrices,
    reviewsBySymbol: args.reviewsBySymbol,
  });

  if (ranked.length === 0) {
    return {
      recommended: null,
      sizeFit: null,
      alternatives: [],
      noActionRecommended: true,
      reason: 'no_current_prices',
      warnings: ['所有 holdings 都缺現價，無法估算換股可行性'],
    };
  }

  // sizeFit：若 targetInvestment 提供，挑「正好覆蓋目標、超出最少」
  let sizeFit: SwapCandidate | null = null;
  if (args.candidate.targetInvestment) {
    const target = args.candidate.targetInvestment;
    const covering = ranked.filter(c => c.proceedsNet >= target);
    if (covering.length > 0) {
      // 在 covering 內挑 proceedsNet 最接近 target（從上方）
      sizeFit = [...covering].sort((a, b) => {
        const oversA = a.proceedsNet - target;
        const oversB = b.proceedsNet - target;
        if (oversA !== oversB) return oversA - oversB;
        return a.priority - b.priority;  // tiebreak by 訊號
      })[0];
    } else {
      // 沒有覆蓋的 → 取最大的（最接近目標）+ 警示
      sizeFit = [...ranked].sort((a, b) => b.proceedsNet - a.proceedsNet)[0];
    }
  }

  // 集中度警示：若所有 holdings + candidate 同產業
  if (args.candidate.industry && args.holdings.every(h => h.industry === args.candidate.industry)) {
    warnings.push(
      `產業集中度警示：所有持股皆為 ${args.candidate.industry}，` +
      `新標的 ${args.candidate.symbol} 同產業，集中度未改善`,
    );
  }
  // 同產業 prefix 警示（半導體 - DRAM vs 半導體 - 晶圓代工 也算同產業）
  if (args.candidate.industry) {
    const candidatePrefix = args.candidate.industry.split(/[-—]/)[0].trim();
    const allSamePrefix = args.holdings.every(h =>
      (h.industry ?? '').split(/[-—]/)[0].trim() === candidatePrefix,
    );
    if (allSamePrefix && candidatePrefix.length > 0) {
      warnings.push(`產業集中度警示：所有持股 prefix=${candidatePrefix}，換股後仍同類`);
    }
  }

  // 資金不足警示
  if (args.candidate.targetInvestment) {
    const top = ranked[0];
    if (top.proceedsNet < args.candidate.targetInvestment) {
      warnings.push(
        `釋出資金不足：賣 ${top.sellName} 預估淨收 ${Math.round(top.proceedsNet).toLocaleString()}，` +
        `但目標投入 ${args.candidate.targetInvestment.toLocaleString()}。考慮多賣或減少投入規模`,
      );
    }
  }

  // 沒最近 review 警示
  const reviewsCount = args.holdings.filter(h => args.reviewsBySymbol.has(h.symbol)).length;
  if (reviewsCount < args.holdings.length) {
    warnings.push(
      `部分持股缺最近 review（${args.holdings.length - reviewsCount}/${args.holdings.length} 檔），` +
      `排序信號減弱。請先跑 /api/agents/portfolio/review`,
    );
  }

  const recommended = ranked[0];
  const altPool = ranked.slice(1);

  // 訊號 vs 資金規模衝突警示（只有當 sizeFit 與 recommended 不同檔時才提）
  if (sizeFit && sizeFit.sellSymbol !== recommended.sellSymbol && args.candidate.targetInvestment) {
    const target = args.candidate.targetInvestment;
    const oversRec = (recommended.proceedsNet - target) / target;
    if (oversRec > 0.5) {
      warnings.push(
        `訊號最強的 ${recommended.sellName}（賣後釋出 ${Math.round(recommended.proceedsNet).toLocaleString()}）` +
        `超出目標 ${target.toLocaleString()} 的 ${(oversRec * 100).toFixed(0)}%；` +
        `若不想釋出過多資金，考慮改賣 sizeFit ${sizeFit.sellName}`,
      );
    } else if (oversRec < -0.3) {
      warnings.push(
        `訊號最強的 ${recommended.sellName}（賣後釋出 ${Math.round(recommended.proceedsNet).toLocaleString()}）` +
        `不足以覆蓋目標 ${target.toLocaleString()}；sizeFit ${sizeFit.sellName} 較適配`,
      );
    }
  }

  return {
    recommended,
    sizeFit,  // 永遠 populate（可能 === recommended，由 UI 自行判斷是否顯示）
    alternatives: altPool.slice(0, 2),
    noActionRecommended: false,
    warnings,
  };
}

/** 估算 candidate 可買多少股（按 lot size 對齊；金額四捨五入到整數元）*/
export function estimateBuyShares(
  proceedsNet: number,
  candidate: { entryPrice: number; market: MarketId },
): { shares: number; lots: number; totalCost: number; remainingCash: number } {
  const lotSize = candidate.market === 'CN' ? 100 : 1000;
  const rawShares = Math.floor(proceedsNet / candidate.entryPrice);
  const lots = Math.floor(rawShares / lotSize);
  const shares = lots * lotSize;
  const totalCost = shares * candidate.entryPrice;
  const buyFee = Math.round(totalCost * FEE_RATES[candidate.market].buy);
  const remainingCash = Math.round(proceedsNet - totalCost - buyFee);
  return { shares, lots, totalCost, remainingCash };
}
