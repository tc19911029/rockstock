/**
 * 移動扣抵預測（W3c · 顯示層 · 純函式）
 *
 * 「移動扣抵」是均線的內建確定性：N 日均線每往前走一根，就把 N 天前那一根的
 * 收盤（＝扣抵值）丟掉、補進今天的收盤。所以只要拿「今天收盤」對比「即將被丟掉的
 * 扣抵值」，就能在 K 棒還沒出來前先知道均線「下一步往上還往下」——
 *
 *   今收 > 扣抵值  → 均線會往上（扣低補高）
 *   今收 < 扣抵值  → 均線會往下（扣高補低）
 *   今收 = 扣抵值  → 均線走平
 *
 * 再往前推幾根，就能估「幾天後均線會翻向」「兩條均線幾天後黃金交叉」。
 *
 * ⚠️ 純顯示／提示用：給走圖右側「均線預測」資訊欄。
 *    刻意**不接選股 gate、不做排序因子**（Wave2 已知此類預測對選股無穩定 edge，
 *    要當訊號需另行回測）。預測往未來 K 棒一律假設「價格停在今天收盤」，
 *    是粗估而非保證，越往後誤差越大。
 *
 * 全部用既有收盤序列計算，不打 API、無魔術門檻。
 */

/**
 * 扣抵值 — N 日均線「下一根」要丟掉的那一根收盤價。
 *
 * 以 asOf 那根為「最新一根」，下一根均線會丟掉窗口最舊的收盤，
 * 也就是 closes[asOf - period + 1]。把它和今收一比就知道均線下一步方向。
 *
 * @param closes 收盤序列（舊到新）
 * @param maN    均線天數（例：5 / 10 / 20 / 60）
 * @param asOf   基準索引（預設最後一根）
 * @returns 扣抵價；資料不足回 undefined
 */
export function deductPrice(
  closes: ReadonlyArray<number>,
  maN: number,
  asOf: number = closes.length - 1,
): number | undefined {
  if (maN <= 0) return undefined;
  if (asOf < 0 || asOf >= closes.length) return undefined;
  const dropIdx = asOf - maN + 1;
  if (dropIdx < 0) return undefined; // 窗口還沒滿，沒有可丟掉的最舊根
  return closes[dropIdx];
}

export interface MaTurnForecast {
  /** 幾天後均線會翻向（1 = 下一根就翻；資料不足或方向不變回 null）*/
  days: number | null;
  /** 目前均線的方向（用「今收 vs 扣抵值」判斷下一根會往哪走）*/
  direction: 'up' | 'down' | 'flat';
  /** 預測會翻去的方向；direction 已定、預測未翻則同 direction */
  turnTo: 'up' | 'down' | 'flat';
}

/**
 * 依移動扣抵估「幾天後均線會翻向」。
 *
 * 假設未來價格停在今天收盤（asOf 收盤），逐根模擬均線往前走：
 * 每往前一根丟掉一個歷史扣抵值、補進「今收」，看均線值的增減方向何時反轉。
 *
 * - direction：均線「現在這一步」的走向（今收 vs 下一根扣抵值）
 * - days：幾根之後均線走向會由 up→down 或 down→up（翻向）
 *
 * @param maxLookahead 最多往前估幾根（預設 = maN，因為 maN 根後窗口全是今收 → 必走平）
 */
export function daysUntilMaTurn(
  closes: ReadonlyArray<number>,
  maN: number,
  asOf: number = closes.length - 1,
  maxLookahead: number = maN,
): MaTurnForecast {
  const flat: MaTurnForecast = { days: null, direction: 'flat', turnTo: 'flat' };
  if (maN <= 1) return flat;
  if (asOf < maN - 1 || asOf >= closes.length) return flat;

  const todayClose = closes[asOf];

  // 用「均線值差」判斷方向：nextMA - curMA 的正負。
  // nextMA = curMA + (today - drop)/maN，故方向 = sign(today - drop)。
  const dirOf = (futureStep: number): 'up' | 'down' | 'flat' => {
    // 第 futureStep 根（1-based）要丟掉的歷史扣抵值
    const dropIdx = asOf - maN + futureStep;
    // dropIdx 落在歷史序列內才是真扣抵；超過 asOf 表示丟掉的也是今收 → 走平
    const dropPrice = dropIdx >= 0 && dropIdx <= asOf ? closes[dropIdx] : todayClose;
    const diff = todayClose - dropPrice;
    if (Math.abs(diff) < 1e-9) return 'flat';
    return diff > 0 ? 'up' : 'down';
  };

  const direction = dirOf(1);
  if (direction === 'flat') {
    return { days: null, direction: 'flat', turnTo: 'flat' };
  }

  const cap = Math.max(1, Math.min(maxLookahead, maN));
  for (let step = 2; step <= cap; step++) {
    const d = dirOf(step);
    if (d !== direction && d !== 'flat') {
      return { days: step - 1, direction, turnTo: d };
    }
    if (d === 'flat') {
      // 走平視為「即將翻向」的臨界 — 回報走平那根
      return { days: step - 1, direction, turnTo: 'flat' };
    }
  }
  return { days: null, direction, turnTo: direction };
}

export interface GoldenCrossForecast {
  /**
   * 幾天後短均線會「黃金交叉」（由下穿上）長均線；
   * 已在上方 = 0；估不到（資料不足 / 反而死叉 / 不會交叉）回 null
   */
  days: number | null;
  /** 目前短均線是否已在長均線上方 */
  alreadyAbove: boolean;
  /** 短均線正往長均線靠近（差距縮小）還是遠離 */
  trend: 'converging' | 'diverging' | 'flat';
}

/**
 * 依移動扣抵估「幾天後短均線黃金交叉長均線」。
 *
 * 兩條均線都假設未來價格停在今收，逐根往前模擬，看短均線何時由
 * 「在長均線下方」翻成「在上方」（黃金交叉）。
 *
 * - alreadyAbove：今天短均線已在長均線之上 → days = 0
 * - trend：短−長 差距是縮小（converging）還是擴大（diverging）
 *
 * @param shortN 短均線天數（例：5）
 * @param longN  長均線天數（例：20）
 * @param maxLookahead 最多估幾根（預設 = longN）
 */
export function daysUntilGoldenCross(
  closes: ReadonlyArray<number>,
  shortN: number,
  longN: number,
  asOf: number = closes.length - 1,
  maxLookahead?: number,
): GoldenCrossForecast {
  const none: GoldenCrossForecast = { days: null, alreadyAbove: false, trend: 'flat' };
  if (shortN <= 0 || longN <= 0 || shortN >= longN) return none;
  if (asOf < longN - 1 || asOf >= closes.length) return none;

  const todayClose = closes[asOf];

  // 模擬第 step 根的短/長均線值（step=0 表示今天）。
  // 第 step 根的窗口 = 原序列尾端，其餘空位用今收補。
  const simMA = (period: number, step: number): number => {
    let sum = 0;
    for (let k = 0; k < period; k++) {
      // 該根（從新到舊第 k 個）對應的原序列索引
      const idx = asOf - k + step;
      sum += idx <= asOf ? closes[idx] : todayClose;
    }
    return sum / period;
  };

  const shortNow = simMA(shortN, 0);
  const longNow = simMA(longN, 0);
  const diffNow = shortNow - longNow;
  const alreadyAbove = diffNow >= 0;

  // 趨勢：比較今天與下一根的差距絕對值
  const shortNext = simMA(shortN, 1);
  const longNext = simMA(longN, 1);
  const diffNext = shortNext - longNext;
  const trend: GoldenCrossForecast['trend'] =
    Math.abs(diffNext) < Math.abs(diffNow) - 1e-9 ? 'converging'
      : Math.abs(diffNext) > Math.abs(diffNow) + 1e-9 ? 'diverging'
        : 'flat';

  if (alreadyAbove) {
    return { days: 0, alreadyAbove: true, trend };
  }

  const cap = Math.max(1, Math.min(maxLookahead ?? longN, longN));
  for (let step = 1; step <= cap; step++) {
    const s = simMA(shortN, step);
    const l = simMA(longN, step);
    if (s - l >= 0) {
      return { days: step, alreadyAbove: false, trend };
    }
  }
  return { days: null, alreadyAbove: false, trend };
}
