import type { Candle, CandleWithIndicators } from '../../types';
import { detectTrend } from '../analysis/trendAnalysis';
import { checkLongProhibitions, type ProhibitionContext } from '../rules/entryProhibitions';
import { evaluateElimination } from '../scanner/eliminationFilter';
import { calcStopLoss, calcDabanStopLoss, stopLossDistancePct } from './stopLoss';
import type { Holding, HoldingMonitor } from './types';

/**
 * 從 K 棒陣列中找出對應 buyDate 的 K 棒（停損計算用）
 * 規則：找 date >= buyDate 的第一根（涵蓋週末/假日後第一個交易日的情況）
 */
function findEntryKbar(buyDate: string, candles: CandleWithIndicators[]): Candle | undefined {
  if (!buyDate || candles.length === 0) return undefined;
  const match = candles.find(c => c.date >= buyDate);
  if (!match) return undefined;
  return {
    date: match.date,
    open: match.open,
    high: match.high,
    low: match.low,
    close: match.close,
    volume: match.volume,
  };
}

export interface MonitorInput {
  holding: Holding;
  /** 進場日至今的 K 棒（含技術指標），最後一根為「今日」 */
  candles: CandleWithIndicators[];
  /** L2 最新報價（盤中），若無則用 candles 末根 close */
  currentPrice?: number;
  /** 法人籌碼歷史（戒律 8 用） */
  institutionalHistory?: ProhibitionContext['institutionalHistory'];
  /** 戒律 8 的閾值（CN 用元，TW 用股） */
  minMeaningfulOutflow?: number;
}

/** WATCH 警示：距停損 < N % 視為接近停損 */
const STOP_LOSS_WATCH_PCT = 3;

/** 打板：開盤跳空向下幅度 ≥ 5% 視為崩盤訊號 */
const DABAN_GAP_DOWN_THRESHOLD = -5;

/**
 * 對單檔持倉計算今日操作建議
 *
 * 雙市場分流：
 * - TW：朱老師六條件派 → S1 停損 + 頭頭低 + 戒律 + 淘汰法
 * - CN：打板派 → 跌破漲停 K 低 + 開盤跳空缺口
 */
export function monitorHolding(input: MonitorInput): HoldingMonitor {
  if (input.holding.market === 'CN') return monitorDabanHolding(input);
  return monitorLongHolding(input);
}

function monitorLongHolding(input: MonitorInput): HoldingMonitor {
  const { holding, candles, institutionalHistory, minMeaningfulOutflow } = input;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const currentPrice = input.currentPrice ?? last?.close ?? holding.costPrice;

  // 進場 K 棒優先用 holding.entryKbar，沒有就從 candles 找 buyDate 對應 K 棒
  const entryKbar = holding.entryKbar ?? findEntryKbar(holding.buyDate, candles);
  const stopLossPrice = calcStopLoss(holding.costPrice, entryKbar);
  const stopLossBasis = entryKbar
    ? `進場日 ${entryKbar.date} K 低 ${entryKbar.low.toFixed(2)}（朱 5 步驟 S1）`
    : `成本 -7%（朱 Part 3 p.247，找不到進場 K 棒）`;
  const stopLossDist = stopLossDistancePct(currentPrice, stopLossPrice);
  const marketValue = currentPrice * holding.shares;
  const unrealizedPL = (currentPrice - holding.costPrice) * holding.shares;
  const unrealizedPLPct = holding.costPrice > 0
    ? ((currentPrice - holding.costPrice) / holding.costPrice) * 100
    : 0;

  const reasons: string[] = [];
  const warnings: string[] = [];
  let action: HoldingMonitor['action'] = 'HOLD';

  // 1. 停損優先：跌破停損價立即出場
  if (currentPrice < stopLossPrice) {
    action = 'SELL_STOP';
    const basis = entryKbar
      ? `進場日 ${entryKbar.date} K 低 ${entryKbar.low.toFixed(2)}`
      : '成本 -7% 預設';
    reasons.push(
      `跌破停損 ${stopLossPrice.toFixed(2)}（朱 5 步驟 S1：${basis}）`,
    );
  }

  // 2. 戒律：觸發任一條即出場（書本：戒律是硬性禁忌）
  if (action === 'HOLD' && lastIdx >= 5) {
    const prohibitionResult = checkLongProhibitions(candles, lastIdx, {
      institutionalHistory,
      minMeaningfulOutflow,
    });
    if (prohibitionResult.prohibited) {
      action = 'SELL_PROHIBITION';
      reasons.push(...prohibitionResult.reasons);
    }
  }

  // 3. 淘汰法：嚴重條件 1 條或一般條件 2 條以上
  if (action === 'HOLD' && lastIdx >= 20) {
    const eliminationResult = evaluateElimination(candles, lastIdx);
    if (eliminationResult.eliminated) {
      action = 'SELL_ELIMINATION';
      reasons.push(...eliminationResult.reasons.map(r => `淘汰法：${r}`));
    }
  }

  // 4. 頭頭低（趨勢由多轉空）
  if (action === 'HOLD' && lastIdx >= 20) {
    const trend = detectTrend(candles, lastIdx);
    if (trend === '空頭') {
      action = 'SELL_TREND';
      reasons.push('頭頭低確認，趨勢轉空（書本 p.39 多頭結束訊號）');
    }
  }

  // 5. WATCH 警示：接近停損但未破
  if (action === 'HOLD' && stopLossDist < STOP_LOSS_WATCH_PCT && stopLossDist >= 0) {
    action = 'WATCH';
    warnings.push(`距停損僅 ${stopLossDist.toFixed(2)}%，留意盤中波動`);
  }

  if (action === 'HOLD') {
    reasons.push(
      unrealizedPLPct >= 0
        ? `獲利 +${unrealizedPLPct.toFixed(2)}%，趨勢未破`
        : `小幅虧損 ${unrealizedPLPct.toFixed(2)}%，停損未到`,
    );
  }

  return {
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    shares: holding.shares,
    costPrice: holding.costPrice,
    currentPrice,
    marketValue,
    unrealizedPL,
    unrealizedPLPct,
    stopLossPrice,
    stopLossDistancePct: stopLossDist,
    stopLossBasis,
    action,
    reasons,
    warnings,
  };
}

function monitorDabanHolding(input: MonitorInput): HoldingMonitor {
  const { holding, candles } = input;
  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];
  const currentPrice = input.currentPrice ?? last?.close ?? holding.costPrice;

  const entryKbar = holding.entryKbar ?? findEntryKbar(holding.buyDate, candles);
  const stopLossPrice = calcDabanStopLoss(entryKbar);
  const stopLossBasis = entryKbar
    ? `漲停日 ${entryKbar.date} K 低 ${entryKbar.low.toFixed(2)}（打板出場鐵律）`
    : `找不到漲停日 K 棒，無停損保護`;
  const stopLossDist = stopLossDistancePct(currentPrice, stopLossPrice);
  const marketValue = currentPrice * holding.shares;
  const unrealizedPL = (currentPrice - holding.costPrice) * holding.shares;
  const unrealizedPLPct = holding.costPrice > 0
    ? ((currentPrice - holding.costPrice) / holding.costPrice) * 100
    : 0;

  const reasons: string[] = [];
  const warnings: string[] = [];
  let action: HoldingMonitor['action'] = 'HOLD';

  // 1. 跌破漲停 K 低（打板出場鐵律）
  if (stopLossPrice > 0 && currentPrice < stopLossPrice) {
    action = 'SELL_DABAN_BREAK';
    reasons.push(`跌破漲停 K 棒最低點 ${stopLossPrice.toFixed(2)}（打板出場鐵律）`);
  }

  // 2. 開盤跳空向下 ≥ 5%（情緒崩盤）
  if (action === 'HOLD' && lastIdx >= 1) {
    const prev = candles[lastIdx - 1];
    const gapPct = prev.close > 0 ? ((last.open - prev.close) / prev.close) * 100 : 0;
    if (gapPct <= DABAN_GAP_DOWN_THRESHOLD) {
      action = 'SELL_DABAN_BREAK';
      reasons.push(`開盤跳空向下 ${gapPct.toFixed(2)}%（情緒崩盤）`);
    }
  }

  // 3. WATCH 警示
  if (action === 'HOLD' && stopLossDist < STOP_LOSS_WATCH_PCT && stopLossDist >= 0) {
    action = 'WATCH';
    warnings.push(`距漲停 K 低僅 ${stopLossDist.toFixed(2)}%`);
  }

  if (action === 'HOLD') {
    reasons.push(
      unrealizedPLPct >= 0
        ? `獲利 +${unrealizedPLPct.toFixed(2)}%，未跌破漲停 K 低`
        : `回檔 ${unrealizedPLPct.toFixed(2)}%，停損未到`,
    );
  }

  return {
    symbol: holding.symbol,
    name: holding.name,
    market: holding.market,
    shares: holding.shares,
    costPrice: holding.costPrice,
    currentPrice,
    marketValue,
    unrealizedPL,
    unrealizedPLPct,
    stopLossPrice,
    stopLossDistancePct: stopLossDist,
    stopLossBasis,
    action,
    reasons,
    warnings,
  };
}
