import type { Candle } from '@/types';
import { computeEntryState, type EntryGateThresholds } from './entryGate';
import { ABSOLUTE_STOP_LOSS_PCT, ABSOLUTE_STOP_LOSS_PRICE_MULT } from '@/lib/sell/v12StopLoss';
import { LOSS_WATCH_PCT, PROFIT_HIGH_TIER_PCT } from '@/lib/analysis/bookThresholds';
import { trackOf } from '@/lib/scanner/buyMethodTracks';
import { computeIndicators } from '@/lib/indicators';
import { detectShortExitSignals } from '@/lib/analysis/shortAnalysis';

export type HoldingAction =
  | 'stop_loss'
  | 'exit_all'
  | 'reduce_half'
  | 'can_add'
  | 'watch_stop'
  | 'hold'
  // ── 賠少-1：做空 live 風控動作（只在 positionSide==='short' 出現）──
  | 'cover_all';   // 回補（做空版「全出」）

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
  /**
   * 賠少-17：進場買法字母（holding.ui.triggerSignal）。用來判斷此部位是否
   * 屬「逆勢/搶反彈軌」（反轉軌 D/F/N/O = 抓底/反轉/V 反轉/打底完成）。
   * 逆勢部位走專屬出場（翻黑/趨勢轉空立即走），缺值 → 走一般順勢出場。
   */
  triggerSignal?: string;

  /**
   * 賠少-1：部位方向。'short' = 做空（放空）；'long' / 缺省 = 做多。
   * 只有 'short' 才走 evaluateHolding 的做空分支（進場黑K最高點停損 + 底底高/突破MA5/急跌長紅回補）；
   * 'long' / 缺省一律走原本做多邏輯，行為位元不變。
   */
  positionSide?: 'long' | 'short';

  /**
   * 賠少-1：做空進場黑K最高點（停損價）。書本做空停損 = 進場黑K最高點上方觸發（5-7%）。
   * 缺值 → fallback 用 stopLoss（既有欄位）當回補價。
   */
  entryHigh?: number;
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

// export（2026-06-12）：shadowLedger 紀律影子帳本重放同一套書本出場規則，
// 常數必須單一事實 — 改門檻這裡改，影子帳本自動跟上。
export const PROFIT_SHORT_RULE = 0.10;
export const PROFIT_MID_RULE = 0.10;
export const PROFIT_LONG_RULE = 0.20;

/**
 * 持倉缺 stopLoss 時的預設停損價係數（entryPrice × 0.93 = 書本 7% 停損）。
 * 單一事實：daily-action route 與 realtime holdingsGuard 皆 import 此值。
 */
export const DEFAULT_STOP_LOSS_MULT = 0.93;

export function sma(closes: number[], end: number, n: number): number | null {
  if (end < n - 1 || n <= 0) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i];
  return s / n;
}

/**
 * 賠少-11：飆股動能轉弱訊號 — 最後一根 K 是「爆量黑K」或「爆量長上影線」。
 * 沿用既有量價門檻（與 sellSignals.HIGH_VOL_UPPER_SHADOW / volumePatterns.blowoff 同口徑）：
 *   - 量比 = 今日量 / 前 5 日均量
 *   - 爆量黑K：量比 ≥ 2（blowoff）且收黑
 *   - 爆量長上影：量比 > 1.5 且上影線 > 實體 × 2
 * 回 null 表示無訊號。
 */
function detectMomentumFadeBlowoff(candles: Candle[]): { type: string; label: string; detail: string } | null {
  const i = candles.length - 1;
  if (i < 5) return null;
  const c = candles[i];
  const avg5 = candles.slice(i - 5, i).map(x => x.volume).filter(v => v > 0);
  if (avg5.length === 0) return null;
  const volRatio = c.volume / (avg5.reduce((a, b) => a + b, 0) / avg5.length);
  const body = Math.abs(c.close - c.open);
  const upperShadow = c.high - Math.max(c.close, c.open);
  const isBlack = c.close < c.open;

  // 爆量黑K（volumePatterns.blowoff 口徑：≥ 5 日均量 × 2）
  if (volRatio >= 2 && isBlack && body > 0) {
    return {
      type: 'blowoff_black_reduce',
      label: '飆股爆量黑K（動能轉弱）',
      detail: `量比 ${volRatio.toFixed(1)}x 爆量收黑，主力出貨警訊，先賣一半`,
    };
  }
  // 爆量長上影線（sellSignals.HIGH_VOL_UPPER_SHADOW 口徑）
  if (volRatio > 1.5 && body > 0 && upperShadow > body * 2) {
    return {
      type: 'blowoff_upper_shadow_reduce',
      label: '飆股爆量長上影（動能轉弱）',
      detail: `量比 ${volRatio.toFixed(1)}x、上影線為實體 ${(upperShadow / body).toFixed(1)} 倍，先賣一半`,
    };
  }
  return null;
}

/**
 * 賠少-17：逆勢/搶反彈買法（反轉軌 D/F/N/O）的專屬「翻黑就走」出場。
 *
 * 書本 CH7-1 / CH7-3：逆勢交易（抓底/搶反彈）自成一類 —「不對立刻跑、不拘泥停損價、
 * 翻黑/趨勢轉空立刻走」。大趨勢還是空頭，搶的是反彈，一旦反彈失敗（當日收黑K）或
 * 趨勢確認轉空（收盤跌破 MA20 操作線）就出，不等固定停損價。
 *
 * 只在 trackOf(letter) === 'reversal' 時觸發；其他軌（順勢多頭/戰法/機械…）不受影響。
 * 回 null 表示「非逆勢部位」或「逆勢但反彈仍健康」→ 繼續走一般順勢出場邏輯。
 */
function detectReversalTurnBlack(
  triggerSignal: string | undefined,
  todayCandle: Candle,
  ma20: number | null,
): { type: string; label: string; detail: string } | null {
  if (!triggerSignal) return null;
  if (trackOf(triggerSignal) !== 'reversal') return null;

  const isBlack = todayCandle.close < todayCandle.open;
  const brokeMa20 = ma20 != null && todayCandle.close < ma20;

  if (isBlack) {
    return {
      type: 'reversal_turn_black_exit',
      label: '逆勢搶反彈翻黑（立即出）',
      detail: `逆勢部位當日收黑K（收 ${todayCandle.close.toFixed(2)} < 開 ${todayCandle.open.toFixed(2)}），反彈失敗，書本不拘泥停損價立即出`,
    };
  }
  if (brokeMa20) {
    return {
      type: 'reversal_trend_down_exit',
      label: '逆勢搶反彈趨勢轉空（立即出）',
      detail: `逆勢部位收盤跌破 MA20 ${ma20!.toFixed(2)}，趨勢確認轉空，書本不拘泥停損價立即出`,
    };
  }
  return null;
}

const ACTION_LABEL: Record<HoldingAction, string> = {
  stop_loss:   '🛑 停損',
  exit_all:    '⛔ 全出',
  reduce_half: '✂️ 減半',
  can_add:     '➕ 可加碼',
  watch_stop:  '⚠️ 緊盯停損',
  hold:        '✓ 續抱',
  cover_all:   '⛔ 回補', // 賠少-1：做空回補（全出）
};

/**
 * 賠少-1：做空 live 風控分支（書本 CH6-9~14 / CH7-2「做空獲利方程式」）。
 *
 * 與做多完全對稱、但語意全反：
 *   - 停損 = 收盤站上「進場黑K最高點」（entryHigh）→ 反彈過頭，立即回補（書本做空停損 5-7%）
 *     缺 entryHigh 時 fallback 用 stopLoss 當回補價（向下相容）。
 *   - 回補訊號 = 底底高 / 突破MA5 / 急跌後大量長紅 → 直接複用 shortAnalysis.detectShortExitSignals
 *     （單一事實，不做第二套做空出場規則）。high severity → cover_all、medium → watch_stop。
 *   - profitPct 做空反向：(entry − close) / entry（下跌為正獲利）。
 *
 * **完全獨立於做多路徑**：只有 positionSide==='short' 才進來；long 部位永遠走原邏輯。
 */
function evaluateShortHolding(input: HoldingActionInput): HoldingActionResult {
  const { entryPrice, stopLoss, candles, todayClose, entryHigh } = input;
  const closes = candles.map(c => c.close);
  const last = closes.length - 1;
  const ma5 = sma(closes, last, 5);
  const ma10 = sma(closes, last, 10);
  const ma20 = sma(closes, last, 20);
  // 做空：下跌為正獲利
  const profitPct = (entryPrice - todayClose) / entryPrice;
  const distToMa5Pct = ma5 != null ? (todayClose - ma5) / ma5 : null;
  const distToMa10Pct = ma10 != null ? (todayClose - ma10) / ma10 : null;
  const distToMa20Pct = ma20 != null ? (todayClose - ma20) / ma20 : null;
  // 做空停損價 = 進場黑K最高點（在現價上方）；distToStopPct = 距停損還有多少（正 = 尚未觸發）
  const coverStop = entryHigh ?? stopLoss;
  const distToStopPct = coverStop > 0 ? (coverStop - todayClose) / todayClose : 0;

  const metrics: HoldingActionResult['metrics'] = {
    ma5, ma10, ma20, distToMa5Pct, distToMa10Pct, distToMa20Pct, distToStopPct,
  };

  // ① 停損回補：收盤站上進場黑K最高點 → 反彈過頭，書本立即回補。
  if (todayClose >= coverStop) {
    return {
      action: 'stop_loss',
      label: ACTION_LABEL.stop_loss,
      signals: [{
        type: 'short_stop_cover',
        label: '站上進場黑K高點（停損回補）',
        detail: `today ${todayClose.toFixed(2)} ≥ 進場黑K高點 ${coverStop.toFixed(2)}，做空反彈過頭，立即回補`,
        severity: 'high',
      }],
      profitPct,
      suggestedStop: coverStop,
      metrics,
    };
  }

  // ② 書本「做空獲利方程式」回補訊號（單一事實 = shortAnalysis.detectShortExitSignals）：
  //    底底高 / 突破MA5 / 急跌後大量長紅 / 低檔長下影。high → cover_all、其餘 → watch_stop。
  const withInd = computeIndicators(candles);
  const exitSignals = detectShortExitSignals(withInd, withInd.length - 1);
  if (exitSignals.length > 0) {
    const sigs: HoldingActionSignal[] = exitSignals.map(s => ({
      type: s.type, label: s.label, detail: s.detail, severity: s.severity,
    }));
    const hasHigh = exitSignals.some(s => s.severity === 'high');
    const action: HoldingAction = hasHigh ? 'cover_all' : 'watch_stop';
    return { action, label: ACTION_LABEL[action], signals: sigs, profitPct, suggestedStop: coverStop, metrics };
  }

  // ③ 距停損 <3% 緊盯（做空版：現價快碰到回補停損點）。
  if (distToStopPct > 0 && distToStopPct < 0.03) {
    return {
      action: 'watch_stop',
      label: ACTION_LABEL.watch_stop,
      signals: [{
        type: 'short_near_cover_stop',
        label: '距回補停損 < 3%',
        detail: `現價距進場黑K高點 ${coverStop.toFixed(2)} 僅 ${(distToStopPct * 100).toFixed(1)}%`,
        severity: 'medium',
      }],
      profitPct,
      suggestedStop: coverStop,
      metrics,
    };
  }

  // ④ 其餘：空單續抱（趨勢續跌、未觸發回補）。
  return { action: 'hold', label: ACTION_LABEL.hold, signals: [], profitPct, suggestedStop: coverStop, metrics };
}

export function evaluateHolding(input: HoldingActionInput): HoldingActionResult {
  // 賠少-1：做空部位走完全獨立的分支（進場黑K高點停損 + 做空回補訊號）。
  // long / 缺省一律落到下面原本做多邏輯，行為位元不變、向下相容。
  if (input.positionSide === 'short') {
    return evaluateShortHolding(input);
  }

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

  // 賠少-2：書本「絕對停損：跌幅 >10% 必走」硬規則（議題 S3-7 / v12 ⑥-4）。
  // 獨立於固定價 stopLoss — 即使設定的停損點較寬，跌幅破 10% 一律強制停損。
  if (todayClose <= entryPrice * ABSOLUTE_STOP_LOSS_PRICE_MULT) {
    return finalize('stop_loss', [{
      type: 'hard_stop_10pct',
      label: '跌幅 >10% 強制停損',
      severity: 'high',
      detail: `跌幅 ${(profitPct * 100).toFixed(1)}% ≤ -${(ABSOLUTE_STOP_LOSS_PCT * 100).toFixed(0)}%（書本絕對停損下限）`,
    }]);
  }

  // 賠少-17：逆勢/搶反彈部位（反轉軌 D/F/N/O）專屬出場 —「翻黑或趨勢轉空立即走」。
  // 排在絕對停損 / 硬停損之後（保護地板仍優先），但在順勢停利 / 固定停損之前 →
  // 不拘泥固定停損價，反彈一失敗就出。非逆勢部位 detectReversalTurnBlack 回 null、不影響原 long 行為。
  const reversalExit = detectReversalTurnBlack(input.triggerSignal, candles[candles.length - 1], ma20);
  if (reversalExit) {
    return finalize('exit_all', [{
      type: reversalExit.type,
      label: reversalExit.label,
      severity: 'high',
      detail: reversalExit.detail,
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

  // 賠少-11：飆股獲利 >20% 後動能轉弱（爆量黑K / 爆量長上影線）→ 先賣一半。
  // 書本 CH6-15 / CH2-04：飆股續抱看量，爆量黑K或長上影是動能轉弱訊號，減一半。
  if (profitPct >= PROFIT_HIGH_TIER_PCT) {
    const fade = detectMomentumFadeBlowoff(candles);
    if (fade) {
      signals.push({
        type: fade.type,
        label: fade.label,
        severity: 'high',
        detail: `漲幅 +${(profitPct * 100).toFixed(1)}% ≥ 20%，${fade.detail}`,
      });
      return finalize('reduce_half', signals);
    }
  }

  if (profitPct >= PROFIT_SHORT_RULE && distToMa5Pct != null && distToMa5Pct < 0) {
    signals.push({
      type: 'break_ma5_short',
      label: '跌破 MA5（短線停利）',
      severity: 'medium',
      detail: `today ${todayClose.toFixed(2)} < MA5 ${ma5!.toFixed(2)}, 漲幅 +${(profitPct * 100).toFixed(1)}% ≥ 10%`,
    });
    return finalize('reduce_half', signals);
  }

  // 賠少-16：書本 CH7-3「跌幅 >5% 列警示股準備賣」與既有「距停損 <3%」並存（兩套基準都保留）。
  const watchSigs: HoldingActionSignal[] = [];
  if (profitPct <= -LOSS_WATCH_PCT) {
    watchSigs.push({
      type: 'loss_over_5pct',
      label: '當日帳上虧損 >5%',
      severity: 'medium',
      detail: `跌幅 ${(profitPct * 100).toFixed(1)}% ≤ -${(LOSS_WATCH_PCT * 100).toFixed(0)}%，書本列警示股、準備賣`,
    });
  }
  if (distToStopPct > 0 && distToStopPct < 0.03) {
    watchSigs.push({
      type: 'near_stop',
      label: '距停損 < 3%',
      severity: 'medium',
      detail: `距停損僅 ${(distToStopPct * 100).toFixed(1)}%`,
    });
  }
  if (watchSigs.length > 0) {
    signals.push(...watchSigs);
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
