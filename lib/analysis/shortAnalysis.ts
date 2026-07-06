/**
 * shortAnalysis.ts — 朱家泓《活用技術分析寶典》p.82-85
 * 短線做空完整體系（與做多版本對稱）
 *
 * 包含：
 * 1. 做空六條件（ShortSixConditions）
 * 2. 做空獲利方程式（ShortProfitEquation — 出場/回補規則）
 * 3. 做空進場10大戒律（ShortEntryMistakes — 不應做空的情況）
 *
 * Phase 3 啟用：做空功能已完整整合進 MarketScanner.scanShortCandidates() 及 BacktestEngine.runShortSOPBacktest()。
 * 也可用於多頭持股的出場判斷（空頭訊號 = 多頭出場警示）。
 */

import { CandleWithIndicators } from '@/types';
import { detectTrend, detectTrendPosition, findPivots } from './trendAnalysis';
import type { TrendState, TrendPosition, ConditionResult } from './trendAnalysis';
import {
  BLACKK_MIN_BODY_PCT,
  BLACKK_MIN_VOL_RATIO,
  BASE_HIGH_VOL_RATIO,
  TRUE_BREAKDOWN_PCT,
} from './bookThresholds';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShortSixConditionsResult {
  trend:     ConditionResult & { state: TrendState };
  ma:        ConditionResult & { alignment: string };
  position:  ConditionResult & { stage: TrendPosition };
  volume:    ConditionResult & { ratio: number | null };
  kbar:      ConditionResult & { type: string };
  indicator: ConditionResult & { macd: boolean; kd: boolean };
  totalScore: number; // 0–6
  coreScore:  number; // 0–5（前5個必要條件）
  isCoreReady: boolean;
}

export interface ShortExitSignal {
  type: string;
  label: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * 空頭續跌避雷訊號（賠少-12 / CH4-08、CH4-06）
 *
 * 與 `ShortExitSignal`（回補空單，趨勢將盡）方向相反：這裡是「空頭續勢、別搶反彈接刀」
 * 的純避雷顯示訊號。兩種型態（書本「空頭進場 2 大口訣」之延伸觀察）：
 *   1. 行進間大量長黑（midTrendBigBlack）— 空頭行進間出現大量長黑且破前日低 → 還有低點，續跌
 *   2. 彈後支撐線跌破（reboundSupportBreak）— 反彈後再下跌、收盤跌破前波低點(支撐線) → 換手失敗、續跌
 *
 * 純避雷/出場側顯示，**不接做多選股 gate、不進掃描 universe**。
 */
export interface ShortContinuationSignal {
  type: string;
  label: string;
  detail: string;
  severity: 'high' | 'medium' | 'low';
}

export interface ShortEntryMistake {
  id: string;
  label: string;
  detail: string;
}

// ── 做空六條件 ─────────────────────────────────────────────────────────────────

/**
 * 朱老師做空六大條件（《活用技術分析寶典》p.82-83）
 *
 * ① 趨勢條件：日線波浪型態符合「頭頭低、底底低」空頭架構
 * ② 均線條件：MA10、MA20 空頭排列，均線向下
 * ③ 股價位置：收盤在 MA10、MA20 之下，判斷初跌/主跌/末跌段
 * ④ 成交量：黑K + 大量配合（≥前一日×1.3）
 * ⑤ 進場K線：價跌、黑K實體棒 > 2%
 * ⑥ 指標參考：MACD 綠柱延長；KD 死亡交叉向下空排
 *
 * 條件 1~5 為必要，第6個為輔助
 */
export function evaluateShortSixConditions(
  candles: CandleWithIndicators[],
  index: number,
): ShortSixConditionsResult {
  const c    = candles[index];
  const prev = index > 0 ? candles[index - 1] : null;

  // ① 趨勢條件：空頭架構
  const trendState = detectTrend(candles, index);
  const trendPass  = trendState === '空頭';
  const trendDetail = trendState === '空頭'
    ? '✅ 空頭趨勢（頭頭低、底底低）'
    : trendState === '多頭'
    ? '❌ 多頭趨勢 — 不宜做空'
    : '⚠️ 盤整 — 觀望';

  // ② 均線條件：空頭排列（MA5 < MA10 < MA20），均線向下
  const { ma5, ma10 } = c;
  const ma20 = c.ma20;
  const prevMa5  = prev?.ma5;
  const prevMa20 = prev?.ma20;

  const maFullBear = ma5 != null && ma10 != null && ma20 != null
    && ma5 < ma10 && ma10 < ma20;
  const belowMA5   = ma5 != null && c.close <= ma5;
  const ma5Falling = ma5 != null && prevMa5 != null && ma5 < prevMa5;
  const ma20NonRising = ma20 != null && (prevMa20 == null || ma20 <= prevMa20 * 1.001);

  const bearishAlign = maFullBear && belowMA5 && ma5Falling && ma20NonRising;

  const maAlignment = bearishAlign
    ? `✅ MA5(${ma5?.toFixed(1)})<MA10(${ma10?.toFixed(1)})<MA20(${ma20?.toFixed(1)})，MA5向下`
    : '⚠️ 均線未完整空排';

  // ③ 股價位置：收盤在 MA10、MA20 之下
  const stage = detectTrendPosition(candles, index);
  const ma20Dev = ma20 && ma20 > 0 ? (ma20 - c.close) / ma20 : null;

  const positionPass = c.close < (ma10 ?? Infinity) && c.close < (ma20 ?? Infinity)
    && ma20Dev !== null && ma20Dev > 0 && ma20Dev < 0.15;

  const positionDetail = ma20Dev !== null
    ? positionPass
      ? `✅ 股價在均線下方（MA20乖離${(ma20Dev*100).toFixed(1)}%，${stage}）`
      : ma20Dev >= 0.15
        ? `❌ 乖離過大禁追空（${(ma20Dev*100).toFixed(1)}%）`
        : `⚠️ 股價在均線上方`
    : '均線資料不足';

  // ④ 成交量：黑K + 大量（≥前一日×1.3）
  const prevDayVol = prev?.volume ?? 0;
  const volVsPrevDay = prevDayVol > 0 ? +(c.volume / prevDayVol).toFixed(2) : null;

  const volumePass = volVsPrevDay !== null && volVsPrevDay >= 1.3 && c.close < c.open;
  const volumeDetail = volVsPrevDay !== null
    ? volumePass
      ? `✅ 大量下跌 ${volVsPrevDay}x 前日`
      : `⚠️ 量比 ${volVsPrevDay}x（未達1.3x或非黑K）`
    : '前日量資料不足';

  // ⑤ 進場K線：價跌、黑K實體棒 > 2%
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const isBlackK = c.close < c.open;
  const isLongBlack = isBlackK && bodyPct >= 0.02;

  const kbarPass = isLongBlack;
  const kbarType = isLongBlack
    ? `✅ 長黑K（實體${(bodyPct*100).toFixed(1)}%）`
    : isBlackK
    ? `⚠️ 小黑K（實體${(bodyPct*100).toFixed(1)}%，未達2%）`
    : `❌ 紅K / 不符合做空K線`;

  // ⑥ 指標參考：MACD 綠柱延長；KD 死亡交叉向下空排
  const macdBear = c.macdOSC != null && c.macdOSC < 0;
  const kdDeathCross = prev != null
    && c.kdK != null && c.kdD != null
    && prev.kdK != null && prev.kdD != null
    && c.kdK < c.kdD && prev.kdK >= prev.kdD;
  const kdBear = c.kdK != null && c.kdD != null
    && c.kdK < c.kdD && c.kdK <= 80 && c.kdK >= 15;

  const indicatorPass = macdBear || kdBear || kdDeathCross;
  const indicatorDetail = [
    macdBear ? `✅ MACD綠柱(OSC=${c.macdOSC?.toFixed(3)})` : `⚠️ MACD紅柱`,
    kdDeathCross
      ? `✅ KD死亡交叉(K=${c.kdK?.toFixed(0)}↓D=${c.kdD?.toFixed(0)})`
      : kdBear
      ? `✅ KD空排(K=${c.kdK?.toFixed(0)},D=${c.kdD?.toFixed(0)})`
      : `⚠️ KD未空排`,
  ].join('；');

  // 總分
  const coreConditions = [trendPass, bearishAlign, positionPass, volumePass, kbarPass];
  const coreScore = coreConditions.filter(Boolean).length;
  const isCoreReady = coreScore === 5;
  const totalScore = coreScore + (indicatorPass ? 1 : 0);

  return {
    trend:     { pass: trendPass,     state: trendState, detail: trendDetail },
    ma:        { pass: bearishAlign,  alignment: maAlignment, detail: maAlignment },
    position:  { pass: positionPass,  stage,             detail: positionDetail },
    volume:    { pass: volumePass,    ratio: volVsPrevDay, detail: volumeDetail },
    kbar:      { pass: kbarPass,      type: kbarType,    detail: kbarType },
    indicator: { pass: indicatorPass, macd: macdBear, kd: kdBear || kdDeathCross, detail: indicatorDetail },
    totalScore,
    coreScore,
    isCoreReady,
  };
}

// ── 做空獲利方程式（出場/回補訊號） ──────────────────────────────────────────

/**
 * 偵測做空出場訊號（朱老師p.83 做空獲利方程式8條）
 * 注：這些訊號在做多時也可作為「可能反彈」的觀察指標
 */
export function detectShortExitSignals(
  candles: CandleWithIndicators[],
  index: number,
): ShortExitSignal[] {
  if (index < 5) return [];
  const signals: ShortExitSignal[] = [];
  const c    = candles[index];
  const prev = candles[index - 1];

  // 第4條：收盤出現「底底高」→ 回補
  if (index >= 10) {
    const pivots = findPivots(candles, index, 6);
    const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
    if (lows.length >= 2 && lows[0].price > lows[1].price) {
      signals.push({
        type: 'SHORT_HIGHER_LOW',
        label: '底底高回補',
        detail: `近期低點${lows[1].price.toFixed(1)}→${lows[0].price.toFixed(1)}底底高，空頭力竭`,
        severity: 'high',
      });
    }
  }

  // 課程 CH1-6 第4點：「突破前高壓力＝頭頭高＝空頭趨勢改變 → 不宜再繼續做空」
  // （CH1-3 出場標準：六字只要有改變就回補。底底高在上面第4條，這裡補另一半「頭頭高」。）
  // 事件型觸發：今日為「首次收盤突破最近一個反彈高點」才報，之後不重複（鏡像多單側頭頭低出場的寫法）。
  if (index >= 10) {
    const recentHighs: { idx: number; price: number }[] = [];
    for (let i = index - 1; i >= Math.max(1, index - 20) && recentHighs.length < 2; i--) {
      const ci = candles[i];
      if (ci.high > candles[i - 1].high && ci.high > candles[i + 1].high) {
        recentHighs.push({ idx: i, price: ci.high });
      }
    }
    if (recentHighs.length >= 1) {
      const newerHigh = recentHighs[0];
      let firstBreakIdx = -1;
      for (let i = newerHigh.idx + 1; i <= index; i++) {
        if (candles[i].close > newerHigh.price) { firstBreakIdx = i; break; }
      }
      if (firstBreakIdx === index) {
        signals.push({
          type: 'SHORT_BREAK_PREV_HIGH',
          label: '過前高回補（頭頭高）',
          detail: `收盤(${c.close.toFixed(1)})突破前反彈高點${newerHigh.price.toFixed(1)}＝頭頭高，空頭趨勢改變，不宜再空`,
          severity: 'high',
        });
      }
    }
  }

  // 第7條：收盤從 MA5 之下突破上來 → 空單考慮回補（書本「獲利>10% + 突破MA5 出場」需 ctx.avgCost 才能精確判斷，這裡只發 MA5 結構訊號）
  if (c.ma5 != null && prev?.ma5 != null) {
    if (prev.close <= prev.ma5 && c.close > c.ma5) {
      // 逐字-4a（課程 CH6-10 橫盤例外）：K線橫盤中紅K站上5均→短線空單「暫不用出場」、改守橫盤突破。
      // 偵測近 4 根（不含今日）是否為窄幅橫盤（高低區間 < 5%）；是則降級為 watch 並附課程指引。
      let consolidating = false;
      if (index >= 5) {
        const win = [candles[index-1], candles[index-2], candles[index-3], candles[index-4]];
        const hi = Math.max(...win.map(x => x.high));
        const lo = Math.min(...win.map(x => x.low));
        consolidating = lo > 0 && (hi - lo) / lo < 0.05;
      }
      signals.push({
        type: 'SHORT_BREAK_ABOVE_MA5',
        label: consolidating ? '突破MA5回補（橫盤例外·暫可續抱）' : '突破MA5回補',
        detail: consolidating
          ? `收盤(${c.close.toFixed(1)})突破MA5(${c.ma5.toFixed(1)})，但前 4 日為K線橫盤。課程 CH6-10：橫盤中紅K站上5均空單暫不用出場，改守「橫盤突破」（區間高）才回補`
          : `收盤(${c.close.toFixed(1)})突破MA5(${c.ma5.toFixed(1)})，空單考慮回補`,
        severity: consolidating ? 'medium' : 'medium',
      });
    }
  }

  // 逐字-5（課程 CH1-6／1-8 長線空單三回補時機之一）：收盤從月線之下突破月線 → 長線空單回補。
  // 短線走 MA5（上方第7條），長線守 MA20；「突破月線就回補、還沒站上20均就不補」是長空明確出場點。
  if (c.ma20 != null && prev?.ma20 != null) {
    if (prev.close <= prev.ma20 && c.close > c.ma20) {
      signals.push({
        type: 'SHORT_BREAK_ABOVE_MA20',
        label: '突破月線回補（長線空單）',
        detail: `收盤(${c.close.toFixed(1)})突破月線MA20(${c.ma20.toFixed(1)})，課程 CH1-8：長線空單「反彈突破月線才回補」，此為長空出場時機`,
        severity: 'high',
      });
    }
  }

  // 逐字-4b（課程 CH6-8 第7點）：空頭下跌黑K，次日出現「並排紅K實體棒」（左長黑右長紅、實體重疊）
  // → 容易是假下跌，準備停損/回補。比「收盤過黑K高點」的硬停損早一天提醒。
  if (prev) {
    const prevBlackBody = (prev.open - prev.close) / (prev.open || 1);
    const todayRedBody = (c.close - c.open) / (c.open || 1);
    const prevIsLongBlack = prev.close < prev.open && prevBlackBody >= 0.02;
    const todayIsLongRed = c.close > c.open && todayRedBody >= 0.02;
    // 並排＝今日紅K實體與昨日黑K實體有明顯重疊（今開落在昨日實體區間內、今收 ≥ 昨收）
    const sideBySide = c.open <= prev.open && c.open >= prev.close && c.close >= prev.close;
    if (prevIsLongBlack && todayIsLongRed && sideBySide) {
      signals.push({
        type: 'SHORT_PARALLEL_RED_FALSE_BREAK',
        label: '並排紅K（假跌破警示）',
        detail: `昨長黑、今長紅並排實體（左長黑右長紅）。課程 CH6-8：容易是假的下跌，做空/剛跌破者準備停損回補（比過黑K高點早一天）`,
        severity: 'medium',
      });
    }
  }

  // 第8條：連續3天急跌 + 大量長紅K覆蓋 → 回補
  if (index >= 3) {
    const prev3Down = [candles[index-1], candles[index-2], candles[index-3]]
      .every(x => x.close < x.open);
    const isLongRed = c.close > c.open && (c.close - c.open) / c.open >= 0.02;
    const avgVol5 = c.avgVol5;
    const bigVolume = avgVol5 != null && avgVol5 > 0 && c.volume >= avgVol5 * 1.5;

    if (prev3Down && isLongRed && bigVolume) {
      signals.push({
        type: 'SHORT_CLIMAX_COVER',
        label: '急跌後長紅回補',
        detail: `連續3日急跌後出現大量長紅K覆蓋，空單立即回補`,
        severity: 'high',
      });
    }
  }

  // 低檔爆量長下影線 = 止跌訊號（33種贏家圖像 #11）
  const dayRange = c.high - c.low;
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const bodySize = Math.abs(c.close - c.open);
  if (dayRange > 0 && lowerShadow > bodySize * 2) {
    const avgVol5 = c.avgVol5;
    if (avgVol5 != null && avgVol5 > 0 && c.volume >= avgVol5 * 1.5) {
      signals.push({
        type: 'SHORT_LONG_LOWER_SHADOW',
        label: '低檔長下影線',
        detail: `爆量長下影線（下影線為實體${(lowerShadow/bodySize).toFixed(1)}倍），止跌訊號`,
        severity: 'medium',
      });
    }
  }

  return signals;
}

// ── 空頭續跌避雷（賠少-12 / CH4-08、CH4-06）──────────────────────────────────

/**
 * 偵測空頭續跌避雷訊號 — 行進間大量長黑 + 彈後支撐線跌破與否（書本 CH4-08 / CH4-06）
 *
 * 純避雷/出場側顯示：提醒「空頭還沒走完、別搶反彈接刀」（多單避雷）／「空單續抱」（做空側）。
 * **不接做多選股 gate、不進掃描 universe、不加任何排序因子。**
 *
 * 門檻全部沿用既有 bookThresholds 常數，不新增魔術數字：
 *   - 大量：avg5 × BASE_HIGH_VOL_RATIO(1.5) 或 前日 × BLACKK_MIN_VOL_RATIO(1.3)
 *   - 長黑：實體 ≥ BLACKK_MIN_BODY_PCT(1.5%)
 *   - 真跌破支撐：收盤 < 前波低點 ×(1 - TRUE_BREAKDOWN_PCT(3%))
 */
export function detectShortContinuationSignals(
  candles: CandleWithIndicators[],
  index: number,
): ShortContinuationSignal[] {
  if (index < 10) return [];
  const c = candles[index];
  const prev = candles[index - 1];
  if (!c || !prev) return [];

  // 僅在空頭趨勢中才談「續跌」；多頭/盤整的黑K是回檔或洗盤，不在此判定。
  const trend = detectTrend(candles, index);
  if (trend !== '空頭') return [];

  // 末跌段已乖離過大 → 反而易反彈，不要再喊「續跌」（與做空戒律 3 同精神）。
  const stage = detectTrendPosition(candles, index);
  if (stage === '末跌段(低檔)') return [];

  const signals: ShortContinuationSignal[] = [];

  // 共用「大量長黑」判定（書本「大量長黑 K」之長 + 大量門檻）
  const avg5 = c.avgVol5 ?? 0;
  const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
  const isBlackK = c.close < c.open;
  const isLongBlack = isBlackK && bodyPct >= BLACKK_MIN_BODY_PCT / 100;
  const isBigVol =
    (avg5 > 0 && c.volume >= avg5 * BASE_HIGH_VOL_RATIO) ||
    (prev.volume > 0 && c.volume >= prev.volume * BLACKK_MIN_VOL_RATIO);

  // ① 行進間大量長黑（CH4-08）：空頭行進間出現大量長黑 + 收盤破前日低 → 還有低點，續跌。
  if (isLongBlack && isBigVol && c.close < prev.low) {
    signals.push({
      type: 'SHORT_MIDTREND_BIG_BLACK',
      label: '行進間大量長黑',
      detail: `空頭${stage}出現大量長黑K（實體${(bodyPct * 100).toFixed(1)}%）破前日低${prev.low.toFixed(1)}，續跌、別接刀`,
      severity: 'high',
    });
  }

  // ② 彈後看支撐線跌破與否（CH4-06）：先有一段反彈（近 6 根 close 曾站回 MA5），
  //    今日再下跌且收盤真跌破前波低點(支撐線) → 換手失敗 / 反彈結束、續跌。
  const recentRebound =
    c.ma5 != null &&
    (() => {
      for (let i = Math.max(1, index - 6); i < index; i++) {
        const k = candles[i];
        if (k.ma5 != null && k.close > k.ma5) return true;
      }
      return false;
    })();

  if (recentRebound && isBlackK) {
    // 支撐線 = 最近一個前波低點（findPivots 回傳 most-recent-first）
    const lows = findPivots(candles, index, 8).filter((p) => p.type === 'low');
    const support = lows.length > 0 ? lows[0].price : null;
    if (support != null) {
      const brokeSupport = c.close < support * (1 - TRUE_BREAKDOWN_PCT);
      if (brokeSupport) {
        signals.push({
          type: 'SHORT_REBOUND_SUPPORT_BREAK',
          label: '彈後跌破支撐線',
          detail: `反彈後再下跌、收盤(${c.close.toFixed(1)})真跌破前波低支撐${support.toFixed(1)}，換手失敗、空頭續跌`,
          severity: 'high',
        });
      }
    }
  }

  return signals;
}

// ── 做空進場10大戒律 ──────────────────────────────────────────────────────────

/**
 * 檢查做空進場戒律（朱老師p.85 做空10大戒律）
 * @returns 違反的戒律列表，空陣列 = 可以做空
 */
export function checkShortEntryMistakes(
  candles: CandleWithIndicators[],
  index: number,
): ShortEntryMistake[] {
  if (index < 30) return [];
  const mistakes: ShortEntryMistake[] = [];
  const c = candles[index];

  // 戒律1：盤頭還沒有跌破月線，勿進場做空
  if (c.ma20 != null && c.close >= c.ma20) {
    mistakes.push({
      id: 'short-mistake-1',
      label: '⚠未破月線勿做空',
      detail: `收盤${c.close.toFixed(1)}仍在MA20(${c.ma20.toFixed(1)})上方`,
    });
  }

  // 戒律2：連續下跌第3根以上，勿殺低做空
  let consecutiveDown = 0;
  for (let i = index; i >= Math.max(0, index - 5); i--) {
    if (candles[i].close < candles[i].open) consecutiveDown++;
    else break;
  }
  if (consecutiveDown >= 3) {
    mistakes.push({
      id: 'short-mistake-2',
      label: '⚠勿殺低追空',
      detail: `已連續${consecutiveDown}根黑K下跌，勿追空`,
    });
  }

  // 戒律3：量價背離+KD低檔+乖離過大
  if (c.kdK != null && c.kdK < 20) {
    const dev = c.ma20 != null ? (c.ma20 - c.close) / c.ma20 : 0;
    if (dev > 0.10) {
      mistakes.push({
        id: 'short-mistake-3',
        label: '⚠KD低檔+乖離大勿追空',
        detail: `KD=${c.kdK.toFixed(0)}低檔，乖離${(dev*100).toFixed(1)}%過大`,
      });
    }
  }

  // 戒律4：週線遇支撐前，勿做空（用MA60近似）
  if (c.ma60 != null && c.close > c.ma60) {
    const distToMa60 = (c.close - c.ma60) / c.close;
    if (distToMa60 < 0.03) {
      mistakes.push({
        id: 'short-mistake-4',
        label: '⚠接近MA60支撐勿做空',
        detail: `收盤接近MA60(${c.ma60.toFixed(1)})支撐位`,
      });
    }
  }

  // 戒律5：反彈突破月線，再下跌未跌破月線，勿做空
  if (c.ma20 != null && c.close > c.ma20 * 0.99 && c.close < c.ma20 * 1.01) {
    // 在月線附近但未有效跌破
    const prevMa20 = candles[index - 3]?.ma20;
    if (prevMa20 != null && c.ma20 > prevMa20) {
      mistakes.push({
        id: 'short-mistake-5',
        label: '⚠月線未跌破勿做空',
        detail: `MA20上揚中，未有效跌破月線`,
      });
    }
  }

  // 戒律7：盤整區內勿做空
  if (c.bbBandwidth != null && c.bbBandwidth < 0.08) {
    mistakes.push({
      id: 'short-mistake-7',
      label: '⚠盤整勿做空',
      detail: `BB帶寬${(c.bbBandwidth*100).toFixed(1)}%，盤整區內勿做空`,
    });
  }

  // 戒律8：一般多頭的回檔，勿做空
  const trend = detectTrend(candles, index);
  if (trend === '多頭' && c.close < c.open) {
    mistakes.push({
      id: 'short-mistake-8',
      label: '⚠多頭回檔勿做空',
      detail: `趨勢仍為多頭，黑K只是回檔不是反轉`,
    });
  }

  // 戒律9：連續急跌的大量長黑K低檔，勿做空
  if (index >= 3) {
    const prev3BigBlack = [candles[index-1], candles[index-2], candles[index-3]]
      .every(x => {
        const bp = x.open > 0 ? Math.abs(x.close - x.open) / x.open : 0;
        return x.close < x.open && bp >= 0.02;
      });
    if (prev3BigBlack) {
      mistakes.push({
        id: 'short-mistake-9',
        label: '⚠急跌低檔勿做空',
        detail: `連續3天長黑急跌，低檔反彈機率高`,
      });
    }
  }

  // 戒律10：空頭進場位置是價跌的紅K，勿做空
  if (c.close > c.open && trend === '空頭') {
    mistakes.push({
      id: 'short-mistake-10',
      label: '⚠空頭紅K勿做空',
      detail: `空頭趨勢中收紅K，等黑K再做空`,
    });
  }

  return mistakes;
}
