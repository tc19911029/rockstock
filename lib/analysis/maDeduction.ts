/**
 * 移動扣抵預測（課程 CH3-2「移動扣抵」· 顯示層 · 純函式）
 *
 * 課程判準（CH3-2 投影片 p01 表格，抄原文）：
 *   抵（加入今日最新收盤）> 扣（減去最前面那一天的收盤）→ 總數增加 → 均線上彎
 *   抵 = 扣 → 總數不變 → 均線走平
 *   抵 < 扣 → 總數減少 → 均線下彎
 *
 * 「未卜先知」（CH3-2 標題頁原文「可以提前預知均線方向何時改變」）：
 * 未來每一根要扣的收盤都是**已知歷史資料**，不用預測未來價 —
 * 假設未來收盤凍在今收 C，第 j 根的均線增減 = (C − closes[asOf−N+j]) / N，
 * 符號只看「今收 vs 該根扣抵價」：
 *
 *   今收 > 扣抵值  → 均線會往上（扣低補高）
 *   今收 < 扣抵值  → 均線會往下（扣高補低）
 *   今收 = 扣抵值  → 均線走平
 *
 * 再往前推幾根，就能估「幾天後均線會翻向」「兩條均線幾天後黃金交叉」
 * （CH3-2 應用一：加權指數 2022/11/7 收 13223 > 明天扣抵 13106 → 明天月線翻上；
 *   應用二：聯亞 3081 用扣抵估 10MA/20MA 約 4~5 天黃金交叉）。
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
 * 課程 CH3-2：看盤軟體在 K 線下方用「小三角形」標出明天要扣哪一根（不要扣錯），
 * 游標移上去讀它的收盤就是扣抵價（本站 CandleChart 已畫此三角形）。
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
  /**
   * 幾天後均線會翻向 — 課程數法：均線在「未來第 s 根」翻向 → days = s（1 = 明天）。
   * direction 描述的就是明天那根，所以這裡偵測到的翻向最早是 2；
   * 「明天就翻」的課程情境（今天還下彎、明天翻上）看 todayDirection ≠ direction。
   * 資料不足或視窗內方向不變回 null。
   */
  days: number | null;
  /** 明天那根均線的方向（今收 vs 明天扣抵值；課程 CH3-2：抵>扣上彎、抵<扣下彎）*/
  direction: 'up' | 'down' | 'flat';
  /** 預測會翻去的方向；direction 已定、預測未翻則同 direction */
  turnTo: 'up' | 'down' | 'flat';
  /** 今天實際那根均線方向（真資料：今收 vs 今天丟掉的 closes[asOf−N]）；資料不足 null */
  todayDirection: 'up' | 'down' | 'flat' | null;
  /** 造成翻向那根「被扣掉的歷史 K 棒」索引（呼叫端可對回日期）；未翻 null */
  turnDeductIdx: number | null;
  /** 造成翻向的扣抵價（課程：「N 天後要扣的高價/低價」）；未翻 null */
  turnDeductPrice: number | null;
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
  const none: MaTurnForecast = {
    days: null, direction: 'flat', turnTo: 'flat',
    todayDirection: null, turnDeductIdx: null, turnDeductPrice: null,
  };
  if (maN <= 1) return none;
  if (asOf < maN - 1 || asOf >= closes.length) return none;

  const todayClose = closes[asOf];

  // 用「均線值差」判斷方向：nextMA - curMA 的正負。
  // nextMA = curMA + (today - drop)/maN，故方向 = sign(today - drop)（課程：抵 vs 扣）。
  const dirOf = (futureStep: number): 'up' | 'down' | 'flat' => {
    // 第 futureStep 根（1 = 明天；0 = 今天實際那步）要丟掉的歷史扣抵值
    const dropIdx = asOf - maN + futureStep;
    // dropIdx 落在歷史序列內才是真扣抵；超過 asOf 表示丟掉的也是今收 → 走平
    const dropPrice = dropIdx >= 0 && dropIdx <= asOf ? closes[dropIdx] : todayClose;
    const diff = todayClose - dropPrice;
    if (Math.abs(diff) < 1e-9) return 'flat';
    return diff > 0 ? 'up' : 'down';
  };

  const direction = dirOf(1);
  // 今天實際方向（真資料）：今天丟掉的是 closes[asOf−N]，窗口剛滿時沒有這根
  const todayDirection = asOf - maN >= 0 ? dirOf(0) : null;

  if (direction === 'flat') {
    return { ...none, todayDirection };
  }

  // 課程數法：dirOf(s) 是「未來第 s 根」的均線增減，s 就是「幾天後」（1 = 明天）。
  // 舊版回 s−1 少算一天，2026-07-05 對齊課程 CH3-2 修正。
  const cap = Math.max(1, Math.min(maxLookahead, maN));
  for (let step = 2; step <= cap; step++) {
    const d = dirOf(step);
    if (d !== direction) {
      const dropIdx = asOf - maN + step;
      return {
        days: step, direction, turnTo: d, todayDirection,
        turnDeductIdx: dropIdx, turnDeductPrice: closes[dropIdx],
      };
    }
  }
  return { days: null, direction, turnTo: direction, todayDirection, turnDeductIdx: null, turnDeductPrice: null };
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

export interface MaRiseForecast {
  /** 幾個交易日後開始向上；目前已向上 = 0，情境內估不到 = null */
  days: number | null;
  /** 今天實際均線已向上（需有前一根均線可比較） */
  alreadyRising: boolean;
  /** 今天實際方向；資料不足以算前一根均線時為 null */
  currentDirection: 'up' | 'down' | 'flat' | null;
  /** 開始向上時扣掉的歷史 K 棒索引；已在向上或估不到時為 null */
  deductIndex: number | null;
  /** 開始向上時的扣抵價；已在向上或估不到時為 null */
  deductPrice: number | null;
}

/**
 * 依移動扣抵估「N 日線何時開始向上」。
 *
 * 今天的實際方向用 close[asOf] − close[asOf−N]；未來第 step 根則假設
 * 收盤維持今收，方向由今收 − close[asOf−N+step] 決定。與 daysUntilMaTurn
 * 不同，本函式會略過中間的走平，繼續找第一個真正向上的交易日。
 */
export function daysUntilMaRises(
  closes: ReadonlyArray<number>,
  maN: number,
  asOf: number = closes.length - 1,
  maxLookahead: number = maN,
): MaRiseForecast {
  const none: MaRiseForecast = {
    days: null,
    alreadyRising: false,
    currentDirection: null,
    deductIndex: null,
    deductPrice: null,
  };
  if (maN <= 1 || asOf < maN - 1 || asOf >= closes.length) return none;

  const todayClose = closes[asOf];
  const directionFromDiff = (diff: number): 'up' | 'down' | 'flat' => {
    if (Math.abs(diff) < 1e-9) return 'flat';
    return diff > 0 ? 'up' : 'down';
  };
  const currentDirection = asOf - maN >= 0
    ? directionFromDiff(todayClose - closes[asOf - maN])
    : null;

  if (currentDirection === 'up') {
    return { ...none, days: 0, alreadyRising: true, currentDirection };
  }

  const cap = Math.max(1, Math.min(Math.floor(maxLookahead), maN));
  for (let step = 1; step <= cap; step++) {
    const deductIndex = asOf - maN + step;
    const deduct = closes[deductIndex];
    if (directionFromDiff(todayClose - deduct) === 'up') {
      return {
        days: step,
        alreadyRising: false,
        currentDirection,
        deductIndex,
        deductPrice: deduct,
      };
    }
  }

  return { ...none, currentDirection };
}

export interface BullishAlignmentForecast {
  /** 幾個交易日後形成嚴格多排；目前已多排 = 0，情境內估不到 = null */
  days: number | null;
  /** 今天是否已是短至長嚴格遞減（例 MA5 > MA10 > MA20） */
  alreadyAligned: boolean;
  /** 成立當下各均線模擬值，順序與 periods 相同；估不到時為 null */
  values: number[] | null;
}

export interface BullishAlignmentDurabilityForecast {
  /** 由短至長的均線週期；嚴格多排要求前一條均線 > 後一條均線。 */
  periods: number[];
  /** 情境中的每日報酬率；0 代表未來收盤維持今收。 */
  dailyReturn: number;
  /** 要連續成立幾個交易日才視為穩定。 */
  requiredConsecutiveDays: number;
  /** 今天是否已形成嚴格多排。 */
  alreadyAligned: boolean;
  /** 第一次形成多排的交易日；今天已成立為 0，情境窗內未成立為 null。 */
  firstAlignedDay: number | null;
  /** 第一次形成多排時的各均線值。 */
  firstAlignedValues: number[] | null;
  /** 第一次多排從成立日起連續維持的日數（只計算到情境窗上限）。 */
  firstRunLength: number;
  /** 第一次多排失效日；情境窗內未失效為 null。 */
  firstBreakDay: number | null;
  /** 首次達到 requiredConsecutiveDays 連續多排的起始日。 */
  firstDurableDay: number | null;
  /** 穩定多排起始日的各均線值。 */
  firstDurableValues: number[] | null;
}

/** 第 step 個未來交易日的模擬均線；未來收盤一律以今收補入。 */
function simulatedMa(
  closes: ReadonlyArray<number>,
  period: number,
  asOf: number,
  step: number,
): number {
  const todayClose = closes[asOf];
  let sum = 0;
  for (let k = 0; k < period; k++) {
    const idx = asOf - k + step;
    sum += idx <= asOf ? closes[idx] : todayClose;
  }
  return sum / period;
}

/** 第 step 個未來交易日的模擬均線；可傳入逐日情境收盤，未傳則依固定日報酬推估。 */
function simulatedMaByScenario(
  closes: ReadonlyArray<number>,
  period: number,
  asOf: number,
  step: number,
  dailyReturn: number,
  futureCloses?: ReadonlyArray<number>,
): number {
  const todayClose = closes[asOf];
  let sum = 0;
  for (let k = 0; k < period; k++) {
    const idx = asOf - k + step;
    if (idx <= asOf) {
      sum += closes[idx];
      continue;
    }
    const futureStep = idx - asOf;
    const provided = futureCloses?.[futureStep - 1];
    sum += Number.isFinite(provided)
      ? provided as number
      : todayClose * ((1 + dailyReturn) ** futureStep);
  }
  return sum / period;
}

/**
 * 依扣抵情境估短／中／長均線何時形成嚴格多頭排列。
 * 例 periods=[5,10,20] 時，判準是 MA5 > MA10 > MA20。
 */
export function daysUntilBullishAlignment(
  closes: ReadonlyArray<number>,
  periods: ReadonlyArray<number> = [5, 10, 20],
  asOf: number = closes.length - 1,
  maxLookahead: number = Math.max(...periods),
): BullishAlignmentForecast {
  const none: BullishAlignmentForecast = { days: null, alreadyAligned: false, values: null };
  if (periods.length < 2 || periods.some((n, i) => n <= 0 || (i > 0 && n <= periods[i - 1]))) return none;
  const longest = periods[periods.length - 1];
  if (asOf < longest - 1 || asOf >= closes.length) return none;

  const valuesAt = (step: number) => periods.map(period => simulatedMa(closes, period, asOf, step));
  const isAligned = (values: ReadonlyArray<number>) => values.every((value, i) => i === 0 || values[i - 1] > value);
  const now = valuesAt(0);
  if (isAligned(now)) return { days: 0, alreadyAligned: true, values: now };

  const cap = Math.max(1, Math.min(Math.floor(maxLookahead), longest));
  for (let step = 1; step <= cap; step++) {
    const values = valuesAt(step);
    if (isAligned(values)) return { days: step, alreadyAligned: false, values };
  }
  return none;
}

/**
 * 推估「四線多排」第一次出現與是否能穩定維持。
 *
 * 這和「四線同步助漲」是兩個不同概念：
 * - 多排看均線位置：MA5 > MA10 > MA20 > MA60。
 * - 全助漲看均線方向：當日收盤同時高於四條線各自的扣抵價。
 *
 * `futureCloses` 可覆蓋固定日報酬情境，供顯示層納入已知除息等機械調整。
 */
export function forecastBullishAlignmentDurability(
  closes: ReadonlyArray<number>,
  periods: ReadonlyArray<number> = [5, 10, 20, 60],
  asOf: number = closes.length - 1,
  options: {
    maxLookahead?: number;
    dailyReturn?: number;
    requiredConsecutiveDays?: number;
    futureCloses?: ReadonlyArray<number>;
  } = {},
): BullishAlignmentDurabilityForecast {
  const dailyReturn = options.dailyReturn ?? 0;
  const requiredConsecutiveDays = Math.max(1, Math.floor(options.requiredConsecutiveDays ?? 3));
  const cleanPeriods = [...periods];
  const empty: BullishAlignmentDurabilityForecast = {
    periods: cleanPeriods,
    dailyReturn,
    requiredConsecutiveDays,
    alreadyAligned: false,
    firstAlignedDay: null,
    firstAlignedValues: null,
    firstRunLength: 0,
    firstBreakDay: null,
    firstDurableDay: null,
    firstDurableValues: null,
  };
  if (
    cleanPeriods.length < 2 ||
    cleanPeriods.some((period, i) => !Number.isInteger(period) || period <= 1 || (i > 0 && period <= cleanPeriods[i - 1])) ||
    asOf < cleanPeriods[cleanPeriods.length - 1] - 1 || asOf >= closes.length ||
    !Number.isFinite(closes[asOf]) || closes[asOf] <= 0 ||
    !Number.isFinite(dailyReturn) || dailyReturn <= -1
  ) return empty;

  const cap = Math.max(0, Math.floor(options.maxLookahead ?? 20));
  const valuesAt = (step: number) => cleanPeriods.map(period =>
    simulatedMaByScenario(closes, period, asOf, step, dailyReturn, options.futureCloses));
  const alignedAt = (values: ReadonlyArray<number>) =>
    values.every((value, i) => i === 0 || values[i - 1] > value + 1e-9);

  const valuesByDay = Array.from({ length: cap + 1 }, (_, step) => valuesAt(step));
  const alignedByDay = valuesByDay.map(alignedAt);
  const firstAlignedDay = alignedByDay.findIndex(Boolean);
  if (firstAlignedDay < 0) return empty;

  let firstRunLength = 0;
  while (firstAlignedDay + firstRunLength <= cap && alignedByDay[firstAlignedDay + firstRunLength]) {
    firstRunLength++;
  }
  const firstBreakDay = firstAlignedDay + firstRunLength <= cap
    ? firstAlignedDay + firstRunLength
    : null;

  let firstDurableDay: number | null = null;
  for (let start = firstAlignedDay; start + requiredConsecutiveDays - 1 <= cap; start++) {
    let durable = true;
    for (let offset = 0; offset < requiredConsecutiveDays; offset++) {
      if (!alignedByDay[start + offset]) {
        durable = false;
        break;
      }
    }
    if (durable) {
      firstDurableDay = start;
      break;
    }
  }

  return {
    periods: cleanPeriods,
    dailyReturn,
    requiredConsecutiveDays,
    alreadyAligned: alignedByDay[0],
    firstAlignedDay,
    firstAlignedValues: valuesByDay[firstAlignedDay],
    firstRunLength,
    firstBreakDay,
    firstDurableDay,
    firstDurableValues: firstDurableDay == null ? null : valuesByDay[firstDurableDay],
  };
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

  const shortNow = simulatedMa(closes, shortN, asOf, 0);
  const longNow = simulatedMa(closes, longN, asOf, 0);
  const diffNow = shortNow - longNow;
  const alreadyAbove = diffNow >= 0;

  // 趨勢：比較今天與下一根的差距絕對值
  const shortNext = simulatedMa(closes, shortN, asOf, 1);
  const longNext = simulatedMa(closes, longN, asOf, 1);
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
    const s = simulatedMa(closes, shortN, asOf, step);
    const l = simulatedMa(closes, longN, asOf, step);
    if (s - l >= 0) {
      return { days: step, alreadyAbove: false, trend };
    }
  }
  return { days: null, alreadyAbove: false, trend };
}

export interface DeductionPoint {
  /** 未來第幾根（1 = 明天） */
  daysAhead: number;
  /** 該根要扣掉的歷史收盤在 closes 的索引（可對回日期） */
  index: number;
  /** 扣抵價 */
  price: number;
}

/**
 * 未來 k 根的扣抵價序列 — 課程 CH3-2「未卜先知」的原料，全部是已知歷史資料。
 *
 * 未來第 j 根（1 = 明天）要扣 closes[asOf − maN + j]；j > maN 之後扣的是
 * 「未來自己的收盤」不再是已知資料，所以序列天然只到 min(k, maN)。
 */
export function deductSeries(
  closes: ReadonlyArray<number>,
  maN: number,
  k: number = maN,
  asOf: number = closes.length - 1,
): DeductionPoint[] {
  if (maN <= 0 || asOf < maN - 1 || asOf >= closes.length) return [];
  const cap = Math.min(Math.max(1, Math.floor(k)), maN);
  const out: DeductionPoint[] = [];
  for (let j = 1; j <= cap; j++) {
    const index = asOf - maN + j;
    out.push({ daysAhead: j, index, price: closes[index] });
  }
  return out;
}

// ── 多週期扣抵狀態與「四線同步助漲」窗口 ───────────────────────────────

export type MaDeductionDirection = 'up' | 'down' | 'flat';

export interface MaDeductionState {
  period: number;
  /** 今天這根均線實際扣掉的價格（close[asOf-period]）。 */
  currentDeductPrice: number | null;
  /** 下一交易日將扣掉的價格（close[asOf-period+1]）。 */
  nextDeductPrice: number;
  /** 今天均線的實際方向。資料剛好只夠一個窗口時為 null。 */
  currentDirection: MaDeductionDirection | null;
  /** 假設下一交易日收盤維持今收時，均線下一步的方向。 */
  nextDirection: MaDeductionDirection;
  /** 下一扣抵價相較今日扣抵價的變化；正值代表扣抵壓力升高。 */
  deductChange: number | null;
  /** 扣抵變化相對自身過去 lookback 次的百分位（0~1）；資料不足為 null。 */
  changePercentile: number | null;
}

const deductionDirection = (diff: number): MaDeductionDirection => {
  if (Math.abs(diff) < 1e-9) return 'flat';
  return diff > 0 ? 'up' : 'down';
};

/**
 * 同時整理 MA5/10/20/60 的「今日」與「下一交易日」扣抵狀態。
 *
 * 百分位只衡量扣抵價是否突然跳高／轉低，不把它冒充成股價漲跌勝率：
 * 每個歷史樣本都用當時收盤正規化，再和目前的扣抵變化比較。
 */
export function multiMaDeductionStates(
  closes: ReadonlyArray<number>,
  periods: ReadonlyArray<number> = [5, 10, 20, 60],
  asOf: number = closes.length - 1,
  lookback: number = 120,
): MaDeductionState[] {
  if (asOf < 0 || asOf >= closes.length) return [];
  const todayClose = closes[asOf];
  if (!Number.isFinite(todayClose) || todayClose <= 0) return [];

  return periods.flatMap((period): MaDeductionState[] => {
    if (!Number.isInteger(period) || period <= 1 || asOf < period - 1) return [];

    const nextIdx = asOf - period + 1;
    const currentIdx = asOf - period;
    const nextDeductPrice = closes[nextIdx];
    if (!Number.isFinite(nextDeductPrice)) return [];

    const currentDeductPrice = currentIdx >= 0 && Number.isFinite(closes[currentIdx])
      ? closes[currentIdx]
      : null;
    const deductChange = currentDeductPrice == null ? null : nextDeductPrice - currentDeductPrice;

    let changePercentile: number | null = null;
    if (deductChange != null) {
      const currentNormalized = deductChange / todayClose;
      const samples: number[] = [];
      const firstAnchor = Math.max(period, asOf - Math.max(1, Math.floor(lookback)));
      for (let anchor = firstAnchor; anchor < asOf; anchor++) {
        const historicalClose = closes[anchor];
        const older = closes[anchor - period];
        const newer = closes[anchor - period + 1];
        if (
          Number.isFinite(historicalClose) && historicalClose > 0 &&
          Number.isFinite(older) && Number.isFinite(newer)
        ) {
          samples.push((newer - older) / historicalClose);
        }
      }
      if (samples.length >= Math.min(20, lookback)) {
        let less = 0;
        let equal = 0;
        for (const sample of samples) {
          if (sample < currentNormalized) less++;
          else if (Math.abs(sample - currentNormalized) < 1e-12) equal++;
        }
        changePercentile = (less + equal * 0.5) / samples.length;
      }
    }

    return [{
      period,
      currentDeductPrice,
      nextDeductPrice,
      currentDirection: currentDeductPrice == null
        ? null
        : deductionDirection(todayClose - currentDeductPrice),
      nextDirection: deductionDirection(todayClose - nextDeductPrice),
      deductChange,
      changePercentile,
    }];
  });
}

export interface AllMaRiseDay {
  /** 未來第幾個交易日（1 = 下一交易日）。 */
  daysAhead: number;
  /** 仍可由既有歷史價格確定的各期扣抵價。 */
  knownDeductions: Record<number, number>;
  /** 因已超過該均線週期、必須等待未來收盤才能知道的扣抵週期。 */
  unknownPeriods: number[];
  /** 已知扣抵價中的最高值；當日收盤必須高於它。 */
  knownThreshold: number;
  /** 目前由哪些均線主導最高門檻。 */
  limitingPeriods: number[];
  /** 若未來收盤維持今收，已知部分是否已滿足助漲門檻。 */
  nearCurrentPrice: boolean;
}

export interface AllMaRiseForecast {
  periods: number[];
  /** 今天四條均線是否已全部實際向上。 */
  currentlyAllRising: boolean;
  /** 下一交易日的完整已知門檻。 */
  nextDay: AllMaRiseDay | null;
  /** 所有扣抵價都已知的近窗（四線時天然最多精確到5個交易日）。 */
  exactDays: AllMaRiseDay[];
  /** 依今收凍結情境，近窗第一個可確定四線全助漲的日子。 */
  firstExactAtCurrentPrice: AllMaRiseDay | null;
  /** 超出短均線已知窗後，第一個接近今收的條件窗口。 */
  firstConditionalNearCurrentPrice: AllMaRiseDay | null;
}

/**
 * 推估「四線何時可同步助漲」。某日成立的必要且充分條件是：
 * 當日收盤 > max(該日 D5, D10, D20, D60)。
 *
 * step <= 最短週期時四個扣抵價全為已知歷史資料，可給完整門檻；超出後短線
 * 扣抵會落在尚未發生的收盤，只能列條件窗口，不能宣稱確定日期。
 */
export function forecastAllMaRising(
  closes: ReadonlyArray<number>,
  periods: ReadonlyArray<number> = [5, 10, 20, 60],
  asOf: number = closes.length - 1,
  maxLookahead: number = 10,
): AllMaRiseForecast {
  const cleanPeriods = [...new Set(periods)]
    .filter(period => Number.isInteger(period) && period > 1)
    .sort((a, b) => a - b);
  const empty: AllMaRiseForecast = {
    periods: cleanPeriods,
    currentlyAllRising: false,
    nextDay: null,
    exactDays: [],
    firstExactAtCurrentPrice: null,
    firstConditionalNearCurrentPrice: null,
  };
  if (
    cleanPeriods.length < 2 || asOf < Math.max(...cleanPeriods) ||
    asOf >= closes.length || !Number.isFinite(closes[asOf])
  ) return empty;

  const todayClose = closes[asOf];
  const currentlyAllRising = cleanPeriods.every(period =>
    deductionDirection(todayClose - closes[asOf - period]) === 'up');
  const days: AllMaRiseDay[] = [];
  const cap = Math.max(1, Math.floor(maxLookahead));

  for (let step = 1; step <= cap; step++) {
    const knownDeductions: Record<number, number> = {};
    const unknownPeriods: number[] = [];
    for (const period of cleanPeriods) {
      const idx = asOf - period + step;
      if (idx >= 0 && idx <= asOf && Number.isFinite(closes[idx])) {
        knownDeductions[period] = closes[idx];
      } else {
        unknownPeriods.push(period);
      }
    }
    const knownValues = Object.values(knownDeductions);
    if (knownValues.length === 0) continue;
    const knownThreshold = Math.max(...knownValues);
    const limitingPeriods = Object.entries(knownDeductions)
      .filter(([, price]) => Math.abs(price - knownThreshold) < 1e-9)
      .map(([period]) => Number(period));
    days.push({
      daysAhead: step,
      knownDeductions,
      unknownPeriods,
      knownThreshold,
      limitingPeriods,
      nearCurrentPrice: todayClose > knownThreshold,
    });
  }

  const exactDays = days.filter(day => day.unknownPeriods.length === 0);
  return {
    periods: cleanPeriods,
    currentlyAllRising,
    nextDay: days[0] ?? null,
    exactDays,
    firstExactAtCurrentPrice: exactDays.find(day => day.nearCurrentPrice) ?? null,
    firstConditionalNearCurrentPrice: days.find(day =>
      day.unknownPeriods.length > 0 && day.nearCurrentPrice) ?? null,
  };
}

// ── 白話結論句（顯示層文案，先結論、短句）────────────────────────────────

/** 白話均線名（課程慣用），結論句用 */
export const MA_PLAIN_LABEL: Record<number, string> = {
  5: '5日線',
  10: '10日線',
  20: '月線',
  60: '季線',
};

export interface MaDeductionLine {
  text: string;
  /** warn = 將下彎（警覺）；good = 將上彎 */
  tone: 'warn' | 'good';
}

const fmtPrice = (p: number): string => String(Number(p.toFixed(2)));

/** YYYY-MM-DD → M/D；沒有日期回 null */
const fmtDate = (dates: ReadonlyArray<string> | undefined, idx: number): string | null => {
  const d = dates?.[idx];
  const m = d ? /^\d{4}-(\d{2})-(\d{2})/.exec(d) : null;
  return m ? `${Number(m[1])}/${Number(m[2])}` : null;
};

/**
 * 把單一均線的扣抵預測翻成一行白話結論（課程 CH3-2 兩個實戰方向）：
 * - 「上不去就等下來」：未來改扣低價 → 股價不跌，均線就上彎
 * - 頭部對稱用法：未來要扣高價 → 股價不漲，均線就下彎（警覺）
 *
 * 例：「月線 3 天後要扣 6/12 的高價 58.2 → 股價不漲將下彎（警覺）」
 * 沒有翻向結論（方向不變 / 走平 / 資料不足）回 null，面板保持安靜。
 */
export function formatMaTurnLine(opts: {
  /** 白話均線名，例：月線（見 MA_PLAIN_LABEL） */
  label: string;
  closes: ReadonlyArray<number>;
  maN: number;
  asOf?: number;
  /** 最多往前看幾根（課程說 7~8 天前未卜先知，顯示層建議 ≤10） */
  maxLookahead?: number;
  /** 與 closes 對齊的日期（YYYY-MM-DD），有給才會寫出「6/12 的」 */
  dates?: ReadonlyArray<string>;
}): MaDeductionLine | null {
  const { label, closes, maN, dates } = opts;
  const asOf = opts.asOf ?? closes.length - 1;
  const turn = daysUntilMaTurn(closes, maN, asOf, opts.maxLookahead ?? maN);

  const priceAt = (idx: number, price: number, kind: '高價' | '低價'): string => {
    const d = fmtDate(dates, idx);
    return d ? `${d} 的${kind} ${fmtPrice(price)}` : `${kind} ${fmtPrice(price)}`;
  };

  // 情境一（課程加權指數 2022/11/7 例）：今天實際還下彎、明天就翻 → 明天的扣抵價
  if (
    turn.todayDirection != null &&
    turn.direction !== 'flat' &&
    turn.direction !== turn.todayDirection
  ) {
    const dp = deductPrice(closes, maN, asOf);
    if (dp != null) {
      const idx = asOf - maN + 1;
      return turn.direction === 'up'
        ? { tone: 'good', text: `${label}明天改扣 ${priceAt(idx, dp, '低價')} → 股價不跌就上彎` }
        : { tone: 'warn', text: `${label}明天要扣 ${priceAt(idx, dp, '高價')} → 股價不漲就下彎（警覺）` };
    }
  }

  // 情境二：未來第 days 根翻向（days = 課程數法「幾天後」）
  if (
    turn.days != null &&
    turn.turnDeductIdx != null &&
    turn.turnDeductPrice != null &&
    turn.turnTo !== 'flat' &&
    turn.turnTo !== turn.direction
  ) {
    return turn.turnTo === 'down'
      ? { tone: 'warn', text: `${label} ${turn.days} 天後要扣 ${priceAt(turn.turnDeductIdx, turn.turnDeductPrice, '高價')} → 股價不漲將下彎（警覺）` }
      : { tone: 'good', text: `${label} ${turn.days} 天後改扣 ${priceAt(turn.turnDeductIdx, turn.turnDeductPrice, '低價')} → 股價不跌將上彎` };
  }

  return null;
}
