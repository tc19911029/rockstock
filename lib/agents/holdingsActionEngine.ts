import type { Candle } from '@/types';
import { computeEntryState, type EntryGateThresholds } from './entryGate';

export type HoldingAction =
  | 'stop_loss'
  | 'exit_all'
  | 'reduce_half'
  | 'can_add'
  | 'watch_stop'
  | 'hold';

export interface HoldingActionSignal {
  type: string;
  label: string;
  severity: 'high' | 'medium' | 'low';
  detail: string;
}

export interface HoldingActionInput {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  candles: Candle[];
  todayClose: number;
  thresholds?: EntryGateThresholds;
}

export interface HoldingActionResult {
  action: HoldingAction;
  label: string;
  signals: HoldingActionSignal[];
  profitPct: number;
  suggestedStop: number;
  metrics: {
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    distToMa5Pct: number | null;
    distToMa10Pct: number | null;
    distToMa20Pct: number | null;
    distToStopPct: number;
  };
}

const PROFIT_SHORT_RULE = 0.10;
const PROFIT_MID_RULE = 0.10;
const PROFIT_LONG_RULE = 0.20;

function sma(closes: number[], end: number, n: number): number | null {
  if (end < n - 1 || n <= 0) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i];
  return s / n;
}

const ACTION_LABEL: Record<HoldingAction, string> = {
  stop_loss:   '🛑 停損',
  exit_all:    '⛔ 全出',
  reduce_half: '✂️ 減半',
  can_add:     '➕ 可加碼',
  watch_stop:  '⚠️ 緊盯停損',
  hold:        '✓ 續抱',
};

export function evaluateHolding(input: HoldingActionInput): HoldingActionResult {
  const { entryPrice, stopLoss, candles, todayClose } = input;
  const closes = candles.map(c => c.close);
  const last = closes.length - 1;
  const ma5 = sma(closes, last, 5);
  const ma10 = sma(closes, last, 10);
  const ma20 = sma(closes, last, 20);
  const profitPct = (todayClose - entryPrice) / entryPrice;
  const distToMa5Pct = ma5 != null ? (todayClose - ma5) / ma5 : null;
  const distToMa10Pct = ma10 != null ? (todayClose - ma10) / ma10 : null;
  const distToMa20Pct = ma20 != null ? (todayClose - ma20) / ma20 : null;
  const distToStopPct = (todayClose - stopLoss) / todayClose;

  const signals: HoldingActionSignal[] = [];

  if (todayClose <= stopLoss) {
    return finalize('stop_loss', [{
      type: 'absolute_stop',
      label: '觸發停損',
      severity: 'high',
      detail: `today ${todayClose.toFixed(2)} ≤ 停損 ${stopLoss.toFixed(2)}`,
    }]);
  }

  const exitAllSigs: HoldingActionSignal[] = [];
  if (profitPct >= PROFIT_LONG_RULE && distToMa20Pct != null && distToMa20Pct < 0) {
    exitAllSigs.push({
      type: 'break_ma20_long',
      label: '跌破 MA20（長線停利）',
      severity: 'high',
      detail: `today ${todayClose.toFixed(2)} < MA20 ${ma20!.toFixed(2)}, 漲幅 +${(profitPct * 100).toFixed(1)}% ≥ 20%`,
    });
  }
  if (profitPct >= PROFIT_MID_RULE && distToMa10Pct != null && distToMa10Pct < 0) {
    exitAllSigs.push({
      type: 'break_ma10_mid',
      label: '跌破 MA10（中線停利）',
      severity: 'high',
      detail: `today ${todayClose.toFixed(2)} < MA10 ${ma10!.toFixed(2)}, 漲幅 +${(profitPct * 100).toFixed(1)}% ≥ 10%`,
    });
  }
  if (exitAllSigs.length > 0) return finalize('exit_all', exitAllSigs);

  if (profitPct >= PROFIT_SHORT_RULE && distToMa5Pct != null && distToMa5Pct < 0) {
    signals.push({
      type: 'break_ma5_short',
      label: '跌破 MA5（短線停利）',
      severity: 'medium',
      detail: `today ${todayClose.toFixed(2)} < MA5 ${ma5!.toFixed(2)}, 漲幅 +${(profitPct * 100).toFixed(1)}% ≥ 10%`,
    });
    return finalize('reduce_half', signals);
  }

  if (distToStopPct > 0 && distToStopPct < 0.03) {
    signals.push({
      type: 'near_stop',
      label: '距停損 < 3%',
      severity: 'medium',
      detail: `距停損僅 ${(distToStopPct * 100).toFixed(1)}%`,
    });
    return finalize('watch_stop', signals);
  }

  // 加碼條件（書本「同向加碼」邏輯）— 只在剛進場、漲幅還小、回測均線時加碼，
  // 不在已有大幅 paper profit 時追高（會把平均成本拉到接近 today price，破壞 risk/reward）
  const gate = computeEntryState({ symbol: input.symbol, candles, thresholds: input.thresholds });
  const aboveMa20 = ma20 == null || todayClose >= ma20;
  const profitInAddRange = profitPct >= -0.05 && profitPct < 0.10;
  if (gate.state === 'can_enter' && aboveMa20 && distToStopPct >= 0.05 && profitInAddRange) {
    signals.push({
      type: 'pullback_ma5_ok',
      label: '回測 MA5 不破（漲幅 < 10% 仍可加碼）',
      severity: 'low',
      detail: gate.reasons[0] ?? '可考慮加碼',
    });
    return finalize('can_add', signals);
  }

  // 已大幅獲利但 MA 結構未破 → hold，附「強勢但已過加碼點」說明
  if (gate.state === 'can_enter' && profitPct >= 0.10) {
    signals.push({
      type: 'past_add_zone',
      label: '強勢續抱（已過加碼點）',
      severity: 'low',
      detail: `漲幅 +${(profitPct * 100).toFixed(1)}% ≥ 10%，加碼會拉高平均成本，續抱跟均線走即可`,
    });
  }

  return finalize('hold', signals);

  function finalize(action: HoldingAction, sigs: HoldingActionSignal[]): HoldingActionResult {
    let stop = stopLoss;
    if (action !== 'stop_loss') {
      if (profitPct >= PROFIT_LONG_RULE && ma20 != null) {
        stop = Math.max(stop, ma20 * 0.995);
      } else if (profitPct >= PROFIT_MID_RULE && ma10 != null) {
        stop = Math.max(stop, ma10 * 0.995);
      }
    }
    return {
      action,
      label: ACTION_LABEL[action],
      signals: sigs,
      profitPct,
      suggestedStop: stop,
      metrics: {
        ma5, ma10, ma20,
        distToMa5Pct, distToMa10Pct, distToMa20Pct,
        distToStopPct,
      },
    };
  }
}
