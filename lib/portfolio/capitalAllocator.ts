import type { StockScanResult, MarketId } from '../scanner/types';
import {
  type BuyRecommendation,
  type CapitalAllocationConfig,
  type Holding,
  DEFAULT_TW_CONFIG,
  DEFAULT_CN_CONFIG,
} from './types';

/**
 * 預期停損距離百分比（用於資金分配，新部位尚無進場 K 棒）
 * 朱 5 步驟法 -7%（書本 Part 3 p.247）
 */
const ASSUMED_STOP_LOSS_PCT = 0.07;

/** 最小進場金額（避免推薦 100 元的部位） */
const MIN_POSITION_AMOUNT = 5000;

export interface AllocateInput {
  config: CapitalAllocationConfig;
  /** 已持倉（會被排除避免重複買，並用來計算剩餘 slot） */
  currentHoldings: Holding[];
  /** 候選池（已用 applyPanelFilter 排序） */
  candidates: StockScanResult[];
  /** 該市場可用現金（呼叫端先扣掉預留比例） */
  cashAvailable: number;
}

export interface AllocateOutput {
  recommendations: BuyRecommendation[];
  cashRemaining: number;
}

/**
 * 對候選池產生買進建議
 *
 * 規則（朱 5 步驟 + 林穎 + 通用 2% 法則）：
 * 1. 同時持倉上限：TW 5 檔、CN 3 檔
 * 2. 預留現金：呼叫端控制，allocator 直接拿可用現金
 * 3. 單筆最大風險 = 總資產 × 2%（停損距離反推部位）
 * 4. 單檔部位上限 = 總資產 × 20%（避免停損太近時部位過大）
 * 5. 公式：部位金額 = min(totalCapital × 2% / 停損距離%, totalCapital × 20%, 可用現金)
 */
export function allocateCapital(input: AllocateInput): AllocateOutput {
  const { config, currentHoldings, candidates } = input;
  const { totalCapital, maxPositions, riskPerTradePct, maxPositionPct, shareUnit } = config;
  let cashAvailable = Math.max(0, input.cashAvailable);

  // 已持倉的 symbol（避免重複推薦）
  const heldSymbols = new Set(currentHoldings.map(h => h.symbol));
  const availableSlots = Math.max(0, maxPositions - currentHoldings.length);

  if (availableSlots === 0 || cashAvailable < MIN_POSITION_AMOUNT) {
    return { recommendations: [], cashRemaining: cashAvailable };
  }

  const filteredCandidates = candidates.filter(c => !heldSymbols.has(c.symbol));
  const recommendations: BuyRecommendation[] = [];

  for (const candidate of filteredCandidates) {
    if (recommendations.length >= availableSlots) break;
    if (cashAvailable < MIN_POSITION_AMOUNT) break;

    const entryPrice = candidate.price;
    if (entryPrice <= 0) continue;

    const stopLossPrice = entryPrice * (1 - ASSUMED_STOP_LOSS_PCT);
    const stopLossDistancePct = ASSUMED_STOP_LOSS_PCT * 100; // 7%

    // 2% 風險法則：部位金額 = 風險上限 / 停損距離
    const riskBasedAmount = (totalCapital * (riskPerTradePct / 100)) / (stopLossDistancePct / 100);
    // 單檔部位上限
    const positionCap = totalCapital * (maxPositionPct / 100);
    // 三者取最小
    const targetAmount = Math.min(riskBasedAmount, positionCap, cashAvailable);

    // 換算股數，向下取整到 shareUnit
    const rawShares = Math.floor(targetAmount / entryPrice);
    const shares = Math.floor(rawShares / shareUnit) * shareUnit;
    if (shares < shareUnit) continue;

    const suggestedAmount = shares * entryPrice;
    if (suggestedAmount < MIN_POSITION_AMOUNT) continue;

    const riskAmount = shares * (entryPrice - stopLossPrice);
    const positionPct = (suggestedAmount / totalCapital) * 100;

    recommendations.push({
      symbol: candidate.symbol,
      name: candidate.name,
      market: candidate.market,
      rank: recommendations.length + 1,
      entryPrice,
      stopLossPrice: +stopLossPrice.toFixed(2),
      stopLossDistancePct: +stopLossDistancePct.toFixed(2),
      suggestedShares: shares,
      suggestedAmount: +suggestedAmount.toFixed(0),
      positionPct: +positionPct.toFixed(2),
      riskAmount: +riskAmount.toFixed(0),
      reasons: buildEntryReasons(candidate),
      scanResult: candidate,
    });

    cashAvailable -= suggestedAmount;
  }

  return { recommendations, cashRemaining: cashAvailable };
}

/** 取得指定市場的預設資金管理設定 */
export function getDefaultConfig(market: MarketId, totalCapital: number): CapitalAllocationConfig {
  const base = market === 'CN' ? DEFAULT_CN_CONFIG : DEFAULT_TW_CONFIG;
  return { ...base, totalCapital };
}

function buildEntryReasons(c: StockScanResult): string[] {
  // 打板候選（CN）走另一套說明
  const dabanRule = c.triggeredRules?.find(r => r.ruleId === 'daban');
  if (dabanRule) {
    return [
      `打板：${dabanRule.reason}`,
      '進場：明早 9:25 集合競價結束後，開盤 ≥ 漲停 × 1.02 才確認進場',
      '出場：跌破今日漲停 K 棒最低點即出（不設固定 % 停損）',
    ];
  }

  const reasons: string[] = [];
  reasons.push(`六條件 ${c.sixConditionsScore}/6（${c.trendState}・${c.trendPosition}）`);
  if (c.mtfScore != null && c.mtfScore >= 3) {
    reasons.push(`MTF 長線保護 ${c.mtfScore}/4（週月線多排）`);
  }
  if (c.highWinRateScore != null && c.highWinRateScore > 0) {
    reasons.push(`高勝率位置 +${c.highWinRateScore}（${(c.highWinRateTypes ?? []).join('/')}）`);
  }
  if (c.histWinRate != null && c.histWinRate >= 60) {
    reasons.push(`歷史 20 日勝率 ${c.histWinRate.toFixed(0)}%`);
  }
  if (c.chipScore != null && c.chipScore >= 60) {
    reasons.push(`籌碼面 ${c.chipGrade ?? c.chipScore}（${c.chipSignal ?? '主力進場'}）`);
  }
  return reasons;
}
