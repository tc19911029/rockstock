/**
 * CH8 8-5 三條均線「分批」操作（2026-06-29）
 *
 * 課程依據：朱家泓技術分析全攻略 線上課 CH8-5「三條均線的短中長線綜合戰法」。
 *
 * 做多核心（做空鏡像）：
 * - 一筆部位拆 3 份。MA5 顧短、MA10 顧中、MA20 顧長。
 * - 收盤跌破 MA5 → 出 1/3；續跌破 MA10 → 再出 1/3；續跌破 MA20 → 出最後 1/3（清空）。
 * - 多頭趨勢不變，收盤站回 MA5 → 買回 1/3；站回 MA10 → 再 1/3；站回 MA20 → 滿倉。
 * - 停損：進場價 −5%（收盤跌破即全出）。
 * - 賺 > 20% 且收盤跌破 MA5 → 剩餘全部停利（總停利）。
 * - 「多頭趨勢不變」是**買回側**前提（2026-07-05 巡邏修）：排列非多排時暫不買回；
 *   賣出階梯純看收盤 vs 三線位置（課程 8-5 分批出場本身沒有多排前提 —
 *   舊版排列一破就全出，會讓「破 MA10 賣 1/3、破 MA20 賣最後 1/3」兩階走不到、階梯退化）。
 *
 * 設計：以「收盤相對三條均線的位置」決定**今天應持有幾份**（path-independent，洗盤來回也穩定）：
 *   收盤 ≥ MA5 → 3 份；MA5↔MA10 → 2 份；MA10↔MA20 → 1 份；跌破 MA20 → 0 份。
 * 停損 / 總停利 / 趨勢破壞為「終止事件」，覆寫為 0 份並標記方法結束。
 *
 * ⚠️ 回測定位（誠實 edge，見記憶 ch8_operation_already_in_rockstock）：
 *   分批**不是「賺最多」工具**（期望值輸固定停損 -10%），而是**「賠少 / 控回撤」工具**
 *   （順勢進場回測 train/test 一致，最大賠 -50% vs 固定停損跳空 -75%）。
 *   因此這是**選用的出場模式**，不改既有預設出場。
 */

import type { CandleWithIndicators } from '../../types';

export type PartialDirection = 'long' | 'short';

export type PartialAction =
  | 'hold'          // 持平，不動
  | 'sell-third'    // 做多出 1/3（做空回補 1/3）
  | 'buy-third'     // 做多買回 1/3（做空加空 1/3）
  | 'exit-all'      // 全部出場（停損 / 總停利 / 趨勢破壞）
  | 'flat';         // 已空手

export type PartialEndReason = 'stop-loss' | 'full-take-profit' | 'trend-broken' | null;

export interface PartialLadderDay {
  date: string;
  unitsHeld: number;     // 當日收盤後應持有份數（0~totalUnits）
  action: PartialAction;
  reason: string;
}

export interface PartialExitState {
  /** 今天收盤後「應該」持有幾份（0~totalUnits）*/
  unitsHeld: number;
  totalUnits: number;
  /** 今天該做的動作 */
  todayAction: PartialAction;
  todayReason: string;
  /** 方法是否已終止（停損/總停利/趨勢破壞）*/
  ended: boolean;
  endReason: PartialEndReason;
  /** 進場日至今的逐日階梯（給 UI drill-down）*/
  ladder: PartialLadderDay[];
}

const TOTAL_UNITS = 3;
const STOP_PCT = 0.05;          // −5% 停損（做空 +5%）
const FULL_TP_PCT = 0.20;       // 賺 > 20% + 跌破 MA5 → 全出

function sma(cs: { close: number }[], i: number, n: number): number {
  if (i < n - 1) return 0;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += cs[k].close;
  return s / n;
}

/**
 * 依「收盤相對三均線」算今天**應持有份數**（不含終止事件覆寫）。
 * - 數字 0~3：應持有份數
 * - 'insufficient'：均線資料不足（進場日前歷史 <19 根）→ 無法評估，當日持平不動
 *
 * 2026-07-05 巡邏修：拿掉排列 gate — 賣出階梯純看收盤 vs 三線（課程 8-5 原文只說
 * 「跌破 5 均賣 1/3、續跌破 10 均再 1/3、破 20 均最後 1/3」）；
 * 排列判定移到呼叫端、只擋**買回**（課程「多頭趨勢不變 → 站回買回」）。
 */
function desiredUnits(
  close: number, ma5: number, ma10: number, ma20: number, dir: PartialDirection,
): number | 'insufficient' {
  if (!(ma5 > 0 && ma10 > 0 && ma20 > 0)) return 'insufficient';
  if (dir === 'long') {
    if (close >= ma5) return 3;
    if (close >= ma10) return 2;
    if (close >= ma20) return 1;
    return 0;
  } else {
    if (close <= ma5) return 3;
    if (close <= ma10) return 2;
    if (close <= ma20) return 1;
    return 0;
  }
}

/** 買回側前提：均線多/空排列（課程「多頭趨勢不變」的均線代理）。 */
function isAligned(ma5: number, ma10: number, ma20: number, dir: PartialDirection): boolean {
  return dir === 'long' ? (ma5 > ma10 && ma10 > ma20) : (ma5 < ma10 && ma10 < ma20);
}

function actionLabel(prev: number, next: number, dir: PartialDirection): { action: PartialAction; reason: string } {
  if (next === prev) return { action: prev === 0 ? 'flat' : 'hold', reason: prev === 0 ? '已空手' : `維持 ${prev}/${TOTAL_UNITS} 份` };
  if (next < prev) {
    const sellWord = dir === 'long' ? '出' : '回補';
    return { action: 'sell-third', reason: `${sellWord} ${prev - next}/${TOTAL_UNITS} 份 → 持有 ${next}/${TOTAL_UNITS}` };
  }
  const buyWord = dir === 'long' ? '買回' : '加空';
  return { action: 'buy-third', reason: `${buyWord} ${next - prev}/${TOTAL_UNITS} 份 → 持有 ${next}/${TOTAL_UNITS}` };
}

/**
 * 計算分批操作狀態：從進場日 replay 到最後一根，回傳今天的份數/動作 + 逐日階梯。
 *
 * @param candles 含指標的日K（至少要能算 MA20，即進場日前需 ≥19 根）
 * @param entryIdx 進場日（買進那天）在 candles 的 index
 * @param entryPrice 實際進場成本價
 * @param dir 'long'（做多）| 'short'（做空）
 */
export function computePartialExitState(
  candles: CandleWithIndicators[],
  entryIdx: number,
  entryPrice: number,
  dir: PartialDirection = 'long',
): PartialExitState {
  const cs = candles;
  const last = cs.length - 1;
  const ladder: PartialLadderDay[] = [];
  let held = TOTAL_UNITS;          // 進場當天滿倉
  let ended = false;
  let endReason: PartialEndReason = null;

  ladder.push({ date: cs[entryIdx]?.date ?? '', unitsHeld: held, action: 'hold', reason: `進場滿倉 ${TOTAL_UNITS}/${TOTAL_UNITS}` });

  for (let d = entryIdx + 1; d <= last; d++) {
    const c = cs[d].close;
    const ma5 = sma(cs, d, 5), ma10 = sma(cs, d, 10), ma20 = sma(cs, d, 20);
    const profitPct = dir === 'long' ? (c - entryPrice) / entryPrice : (entryPrice - c) / entryPrice;

    if (ended) { ladder.push({ date: cs[d].date, unitsHeld: 0, action: 'flat', reason: '方法已結束' }); continue; }

    // ── 終止事件（覆寫為 0）──
    // −5% 停損（收盤確認）
    const stopHit = dir === 'long' ? c < entryPrice * (1 - STOP_PCT) : c > entryPrice * (1 + STOP_PCT);
    if (stopHit) {
      held = 0; ended = true; endReason = 'stop-loss';
      ladder.push({ date: cs[d].date, unitsHeld: 0, action: 'exit-all', reason: `收盤觸 −${STOP_PCT * 100}% 停損 → 全部出場` });
      continue;
    }
    // 賺 > 20% + 跌破 MA5 → 總停利
    const breakMa5 = dir === 'long' ? (ma5 > 0 && c < ma5) : (ma5 > 0 && c > ma5);
    if (profitPct >= FULL_TP_PCT && breakMa5 && held > 0) {
      held = 0; ended = true; endReason = 'full-take-profit';
      ladder.push({ date: cs[d].date, unitsHeld: 0, action: 'exit-all', reason: `獲利 ${(profitPct * 100).toFixed(0)}% 且跌破 MA5 → 總停利全出` });
      continue;
    }

    const want = desiredUnits(c, ma5, ma10, ma20, dir);
    // 資料不足（進場日前歷史 <19 根）→ 無法評估，持平不動
    if (want === 'insufficient') {
      ladder.push({ date: cs[d].date, unitsHeld: held, action: held === 0 ? 'flat' : 'hold', reason: '均線資料不足，持平' });
      continue;
    }
    // 課程 8-5（2026-07-05 巡邏修）：「多頭趨勢不變」只擋**買回**（站回買回的前提）—
    // 賣出階梯照走；排列非多排時想加份數 → 暫不買回、持平。
    if (want > held && !isAligned(ma5, ma10, ma20, dir)) {
      ladder.push({ date: cs[d].date, unitsHeld: held, action: held === 0 ? 'flat' : 'hold', reason: `站回均線但${dir === 'long' ? '多' : '空'}頭排列未恢復，暫不${dir === 'long' ? '買回' : '加空'}` });
      continue;
    }

    const { action, reason } = actionLabel(held, want, dir);
    held = want;
    ladder.push({ date: cs[d].date, unitsHeld: held, action, reason });
  }

  const today = ladder[ladder.length - 1];
  return {
    unitsHeld: held,
    totalUnits: TOTAL_UNITS,
    todayAction: today?.action ?? 'hold',
    todayReason: today?.reason ?? '',
    ended,
    endReason,
    ladder,
  };
}
