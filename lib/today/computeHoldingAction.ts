/**
 * computeHoldingAction — 純規則式判斷單檔持股當下該動作
 *
 * 用於 /today 與 TodayBriefing 在 portfolio-review skill 沒跑當天時的 fallback。
 * 規則對齊 app/today/page.tsx:164-176 既有邏輯，避免兩處 drift。
 *
 * 規則：
 *   1. close <= stopLoss              → 'stop_loss' （已跌破）
 *   2. distToStop < 3%                → 'stop_loss' （即將跌破）
 *   3. returnPct >= 10%               → 'take_profit'（短線達標、留意 MA5）
 *   4. else                           → 'hold_observe'
 *   5. close == null                  → 'no_data'
 */

export type HoldingActionRule =
  | 'stop_loss'
  | 'take_profit'
  | 'hold_observe'
  | 'no_data';

export interface HoldingActionInput {
  entryPrice: number;
  currentPrice: number | null;
  stopLoss?: number | null;
}

export interface HoldingActionResult {
  action: HoldingActionRule;
  returnPct: number | null;
  distToStopPct: number | null;
  hint: string;
}

export function computeHoldingAction(input: HoldingActionInput): HoldingActionResult {
  const { entryPrice, currentPrice, stopLoss } = input;
  if (currentPrice == null || currentPrice <= 0) {
    return { action: 'no_data', returnPct: null, distToStopPct: null, hint: '無最新報價' };
  }
  const returnPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
  const distToStopPct = stopLoss && stopLoss > 0
    ? ((currentPrice - stopLoss) / currentPrice) * 100
    : null;

  if (stopLoss && currentPrice <= stopLoss) {
    return { action: 'stop_loss', returnPct, distToStopPct, hint: `已跌破停損 ${stopLoss.toFixed(2)}` };
  }
  if (distToStopPct !== null && distToStopPct < 3) {
    return { action: 'stop_loss', returnPct, distToStopPct, hint: `距停損僅 ${distToStopPct.toFixed(1)}%` };
  }
  if (returnPct >= 10) {
    return { action: 'take_profit', returnPct, distToStopPct, hint: `已漲 ${returnPct.toFixed(1)}%，留意短線 MA5 跌破` };
  }
  return { action: 'hold_observe', returnPct, distToStopPct, hint: '續抱觀察' };
}
