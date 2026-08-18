/**
 * v12 字母 N：型態確認
 *
 * 書本依據：
 * - 寶典 Part 11-1 第 7 位置「等型態確認」p.697
 * - 抓飆股 Part 7「25 種型態附錄」p.314-342（含達成率）
 * - 5 步驟 步驟 1 第 7 章 情況 5 p.110
 *
 * v12 階段 1 實作 3 個高達成率底部型態：
 * - 頭肩底（達成率 83%）
 * - 三重底（達成率 95%）⭐ 最高達成率
 * - 圓弧底（達成率 85%）
 *
 * v12 階段 2 補入：
 * - 複式頭肩底 80% / 跌菱形 80% / 下降楔形 90% / 雙重底 36%
 *
 * 議題 33（第 10 輪修正後）：N 走 LockWatch（頸線突破時 detectTrend
 *   通常還沒翻多 → 觀察階段 → 趨勢確認後升級進場）
 * 議題 6：N 是型態類，套 ×3% + 3 天 provisional
 * 議題 49：N 結構失效 = 跌破對應低點
 *
 * 軌道：reversal（轉折軌）
 * 類別：pattern（型態類）
 */

import type { CandleWithIndicators } from '../../types';

import { findPivots, type Pivot } from './trendAnalysis';
import { isValidRedK } from './redKValidator';
import type { MarketId } from '../scanner/types';
import { BOOK_BODY_PCT_MIN, BOOK_VOL_RATIO_MIN } from './bookThresholds';
import { N_MIN_HISTORY } from './historyMinimums';
import {
  getLegacyBookAchievementRate,
  isCrossMarketObservationOnly,
  isLegacyBookObservationOnly,
  type BottomPatternType,
  type TopPatternType,
} from './patternCatalog';

export type { TopPatternType } from './patternCatalog';

export type PatternType = BottomPatternType;

/** 頂部型態（向下跌破做空 / 出場警示，2026-05-10 補實作；2026-07-07 補 S4 v2 四型） */
// 《抓飆股》附錄有明載者才填；最新線上課合集只稱「高勝率」，沒有印統一百分比。
// N 字底過去的 75% 是系統自行估值，不能再冒充教材數字。
// 線上課 CH6-11 未提供頂部各型態的精確達成率；舊版用底部型態對稱值與人工估值，
// 會讓 UI 看起來像朱老師公布的統計，因此頂部欄位一律不填假數字。

export interface LetterNResult {
  triggered: boolean;
  /** 偵測到的型態（觸發時必有；結構成立但未過真突破時也會回傳，用於走圖視覺化）*/
  patternType?: PatternType;
  /** 達成率（書本明寫，用於排序）*/
  achievementRate?: number;
  /** 頸線價（突破點）*/
  necklinePrice?: number;
  /** ×3% 真突破門檻 */
  breakoutThreshold?: number;
  /** 型態目標價（用於 Step 5 ② 停利）*/
  patternTargetPrice?: number;
  /** 結構失效點（議題 49）*/
  structureBrokenPrice?: number;
  /** 構成形態的關鍵 pivot 點，順序與型態 detector 內部一致（走圖視覺化用）*/
  pivots?: Pivot[];
  bodyPct?: number;
  volumeRatio?: number;
  /** 腳位形狀吻合度（0-100；不含現價距頸線，不是勝率）。 */
  qualityScore?: number;
  /** 品質分數的可解釋摘要，避免 UI 把分數誤認成黑盒機率。 */
  qualityReasons?: string[];
  /** 是否已接近到適合放上主圖（比分析層 current relevance 更嚴格）。 */
  displayReady?: boolean;
  detail: string;
}

const TRUE_BREAKOUT_PCT = 0.03;

/**
 * N 型態確認偵測（階段 1：3 個高達成率型態）
 *
 * 內部依序檢查：三重底 → 頭肩底 → 圓弧底，回傳第一個命中的。
 */
export function detectLetterN(
  candles: CandleWithIndicators[],
  idx: number,
  market: MarketId = 'TW',
  symbol = '',
): LetterNResult {
  const empty: LetterNResult = { triggered: false, detail: 'N 型態確認未觸發' };

  if (idx < N_MIN_HISTORY || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  const prevPrev = candles[idx - 2];
  if (!c || !prev || !prevPrev || prev.volume <= 0 || c.open <= 0) return empty;

  // 共同前置：紅 K + 實體 ≥ 2% + 量 ≥ 1.3
  if (!isValidRedK(c, prevPrev.close, market, symbol)) return empty;
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < BOOK_VOL_RATIO_MIN) return empty;

  // 同一段 K 線常同時符合三重底／頭肩底／雙重底。舊版回傳固定順序第一個，
  // 分類會隨 detector 排列而非結構吻合度改變。現在先收集全部候選，再以品質排序。
  const candidates = getRankedBottomMatches(candles, idx, true)
    .filter(candidate => candidate.quality.score >= BOTTOM_PATTERN_TRIGGER_MIN_QUALITY_SCORE);
  if (candidates.length === 0) return empty;
  const evaluated = candidates.map(candidate =>
    makeResult(candidate.match, c.close, bodyPct, volumeRatio, candidate.quality),
  );
  return evaluated.find(result => result.triggered) ?? evaluated[0];
}

/**
 * 結構偵測（走圖視覺化用）：跳過紅K / 量比 / 真突破 gate，
 * 只回傳「形態結構是否成立」+ pivots / 頸線 / 目標 / 結構失效。
 * triggered 永遠 false（不是進場訊號），用 patternType / pivots 判斷有無結構。
 */
export function detectLetterNStructure(
  candles: CandleWithIndicators[],
  idx: number,
  minimumQualityScore = 0,
): LetterNResult {
  if (idx < N_MIN_HISTORY || candles.length === 0) return { triggered: false, detail: '' };

  const candidate = getRankedBottomMatches(candles, idx, true)
    .find(item => item.quality.score >= minimumQualityScore);
  if (candidate) {
    const { match: m, quality } = candidate;
    return {
      triggered: false,
      patternType: m.patternType,
      achievementRate: getLegacyBookAchievementRate(m.patternType),
      necklinePrice: m.necklinePrice,
      breakoutThreshold: m.necklinePrice * (1 + TRUE_BREAKOUT_PCT),
      patternTargetPrice: m.patternTargetPrice,
      // 結構失效門檻 = 頸線 ×0.97（與真突破對稱）
      structureBrokenPrice: m.structureBrokenPrice * (1 - TRUE_BREAKOUT_PCT),
      pivots: m.pivots,
      qualityScore: quality.score,
      qualityReasons: quality.reasons,
      displayReady: quality.displayReady,
      detail: `結構偵測：${getPatternName(m.patternType)}（形狀吻合 ${quality.score}/100，非勝率）`,
    };
  }
  return { triggered: false, detail: '無底部型態結構' };
}

interface PatternMatch {
  patternType: PatternType;
  necklinePrice: number;
  patternTargetPrice: number;
  structureBrokenPrice: number;
  /** 構成形態的關鍵點，順序由各 detector 決定（CandleChart 依 patternType 推標籤）*/
  pivots: Pivot[];
}

type PatternKind = 'bottom' | 'top';

interface PatternQuality {
  score: number;
  timingScore: number;
  reasons: string[];
  relevant: boolean;
  displayReady: boolean;
}

interface RankedMatch<TMatch> {
  match: TMatch;
  quality: PatternQuality;
}

const MIN_MEASURED_MOVE_PCT = 0.03;
const MAX_MEASURED_MOVE_PCT = 0.50;
const MAX_PENDING_NECKLINE_DISTANCE_PCT = 0.08;
const MAX_STRUCTURE_EVENT_AGE_BARS = 20;
const MAX_TERMINAL_EVENT_AGE_BARS = 10;
const DISPLAY_MAX_PENDING_NECKLINE_DISTANCE_PCT = 0.03;
const DISPLAY_MAX_EVENT_AGE_BARS = 10;
/** 形狀吻合門檻；距頸線與事件新舊只負責 current relevance，不再灌進形狀分數。 */
export const BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE = 90;
export const TOP_PATTERN_DISPLAY_MIN_QUALITY_SCORE = 90;
const BOTTOM_PATTERN_TRIGGER_MIN_QUALITY_SCORE = 80;
const TOP_PATTERN_TRIGGER_MIN_QUALITY_SCORE = 85;
const SUBPATTERN_SUPPRESSION_MIN_QUALITY_SCORE = 75;

/** 複式頭肩的肩帶驗證；公開為純函式，讓真實誤判案例可以鎖成回歸測試。 */
export function hasCoherentComplexShoulders(
  olderSide: readonly number[],
  newerSide: readonly number[],
  headPrice: number,
  kind: PatternKind,
): boolean {
  if (olderSide.length < 2 || newerSide.length < 2) return false;
  const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const olderAverage = average(olderSide);
  const newerAverage = average(newerSide);
  const shoulderAverage = (olderAverage + newerAverage) / 2;
  if (!Number.isFinite(shoulderAverage) || shoulderAverage <= 0) return false;
  if (Math.abs(olderAverage - newerAverage) / shoulderAverage > 0.10) return false;
  if ([...olderSide, ...newerSide].some(price => Math.abs(price - shoulderAverage) / shoulderAverage > 0.12)) return false;
  const prominence = kind === 'bottom'
    ? (shoulderAverage - headPrice) / shoulderAverage
    : (headPrice - shoulderAverage) / shoulderAverage;
  return prominence >= 0.05;
}

function hasValidPatternGeometry(match: {
  patternType: string;
  necklinePrice: number;
  patternTargetPrice: number;
  structureBrokenPrice: number;
  pivots: Pivot[];
}): boolean {
  return [match.necklinePrice, match.patternTargetPrice, match.structureBrokenPrice]
    .every(price => Number.isFinite(price) && price > 0) &&
    match.pivots.length > 0 &&
    // 轉折型態的腳位不可由同一根 K 棒重複擔任；一字頂的兩點是箱體價帶端點，並非相鄰 swing。
    (match.patternType === 'one-line-top' ||
      new Set(match.pivots.map(pivot => pivot.index)).size === match.pivots.length) &&
    match.pivots.every(pivot =>
      Number.isInteger(pivot.index) && pivot.index >= 0 &&
      Number.isFinite(pivot.price) && pivot.price > 0,
    );
}

function isValidPatternMatch(match: PatternMatch): boolean {
  return hasValidPatternGeometry(match) && match.patternTargetPrice > match.necklinePrice;
}

/** 未確認前的原始型態邊界；N／倒 N 要看右腳，不可被更早、較遠的前低／前高取代。 */
export function getPatternFormationBoundaryPrice(
  patternType: string,
  pivots: readonly Pivot[],
  kind: PatternKind,
): number | undefined {
  if (patternType === 'n-shape') return pivots[1]?.price;
  if (patternType === 'inverted-n-top') return pivots[0]?.price;
  const boundaryPivots = pivots.filter(pivot => kind === 'bottom' ? pivot.type === 'low' : pivot.type === 'high');
  if (boundaryPivots.length === 0) return undefined;
  return kind === 'bottom'
    ? Math.min(...boundaryPivots.map(pivot => pivot.price))
    : Math.max(...boundaryPivots.map(pivot => pivot.price));
}

type GeometryScorableMatch = Pick<PatternMatch, 'patternType' | 'necklinePrice' | 'patternTargetPrice' | 'pivots'> | Pick<TopPatternMatch, 'patternType' | 'necklinePrice' | 'patternTargetPrice' | 'pivots'>;

const clampScore = (value: number) => Math.max(0, Math.min(100, value));
const averageScore = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length));
const levelFitScore = (values: number[], tolerance: number): number => {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (!Number.isFinite(minimum) || minimum <= 0) return 0;
  return clampScore(100 - 40 * ((maximum - minimum) / minimum) / tolerance);
};
const balanceFitScore = (leftSpan: number, rightSpan: number): number => {
  if (leftSpan <= 0 || rightSpan <= 0) return 0;
  return 60 + 40 * Math.min(leftSpan, rightSpan) / Math.max(leftSpan, rightSpan);
};

/** 以兩個已確認腳位投射指定 K 棒的切線價；避免斜頸線各 detector 各算一套。 */
export function projectPivotLinePrice(older: Pivot, newer: Pivot, index: number): number | undefined {
  const span = newer.index - older.index;
  if (span <= 0) return undefined;
  const slope = (newer.price - older.price) / span;
  const projected = newer.price + slope * (index - newer.index);
  return Number.isFinite(projected) && projected > 0 ? projected : undefined;
}

/**
 * 水平化頸線必須等價格穿越所有內部轉折點才算完整突破：
 * 底部型態取最高壓力，頂部型態取最低支撐。
 */
export function getConservativeHorizontalNeckline(
  prices: readonly number[],
  kind: PatternKind,
): number | undefined {
  if (prices.length === 0 || prices.some(price => !Number.isFinite(price) || price <= 0)) return undefined;
  return kind === 'bottom' ? Math.max(...prices) : Math.min(...prices);
}

/** 收斂／擴張線型必須由不同 K 棒的高低轉折交替構成，不能一根 K 同時冒充兩個腳位。 */
export function hasAlternatingDistinctPivots(pivots: readonly Pivot[]): boolean {
  if (new Set(pivots.map(pivot => pivot.index)).size !== pivots.length) return false;
  const ordered = [...pivots].sort((a, b) => a.index - b.index);
  return ordered.every((pivot, index) => index === 0 || pivot.type !== ordered[index - 1].type);
}
const prominenceFitScore = (prominence: number, minimum = 0.03, ideal = 0.10): number =>
  clampScore(60 + 40 * (prominence - minimum) / Math.max(0.001, ideal - minimum));
const boundedIdealScore = (value: number, minimum: number, idealLow: number, idealHigh: number, maximum: number): number => {
  if (value < minimum || value > maximum) return 0;
  if (value >= idealLow && value <= idealHigh) return 100;
  if (value < idealLow) return 60 + 40 * (value - minimum) / Math.max(0.001, idealLow - minimum);
  return 60 + 40 * (maximum - value) / Math.max(0.001, maximum - idealHigh);
};

/**
 * 只衡量 detector 已選腳位的幾何吻合度；不讀現價、不看未來，也不把離頸線近當成形狀好。
 * 回傳的分數供畫面候選篩選與多空衝突排序，不代表達成率或交易勝率。
 */
export function scorePatternGeometry(match: GeometryScorableMatch): { score: number; reasons: string[] } {
  const pivots = match.pivots;
  const measuredMove = Math.abs(match.patternTargetPrice - match.necklinePrice) / match.necklinePrice;
  let components: Array<{ label: string; score: number }> = [];

  switch (match.patternType) {
    case 'triple-bottom':
    case 'triple-top': {
      const levels = pivots.slice(0, 3);
      const necks = pivots.slice(3, 5);
      components = [
        { label: '三點齊度', score: levelFitScore(levels.map(p => p.price), 0.05) },
        { label: '兩段時間', score: balanceFitScore(levels[0].index - levels[1].index, levels[1].index - levels[2].index) },
        { label: '頸線齊度', score: levelFitScore(necks.map(p => p.price), 0.15) },
      ];
      break;
    }
    case 'head-shoulder':
    case 'head-shoulder-top': {
      const [rightShoulder, head, leftShoulder, rightNeck, leftNeck] = pivots;
      const shoulderAverage = (rightShoulder.price + leftShoulder.price) / 2;
      const prominence = Math.abs(head.price - shoulderAverage) / shoulderAverage;
      components = [
        { label: '肩線齊度', score: levelFitScore([rightShoulder.price, leftShoulder.price], 0.10) },
        { label: '頭部突出', score: prominenceFitScore(prominence) },
        { label: '左右時間', score: balanceFitScore(rightShoulder.index - head.index, head.index - leftShoulder.index) },
        { label: '頸線齊度', score: levelFitScore([rightNeck.price, leftNeck.price], 0.15) },
      ];
      break;
    }
    case 'complex-head-shoulder':
    case 'complex-head-shoulder-top': {
      const structureType = match.patternType === 'complex-head-shoulder' ? 'low' : 'high';
      const structure = pivots.filter(p => p.type === structureType).slice(0, 5);
      const head = match.patternType === 'complex-head-shoulder'
        ? structure.reduce((best, pivot) => pivot.price < best.price ? pivot : best)
        : structure.reduce((best, pivot) => pivot.price > best.price ? pivot : best);
      const shoulders = structure.filter(pivot => pivot !== head);
      const shoulderAverage = shoulders.reduce((sum, pivot) => sum + pivot.price, 0) / shoulders.length;
      const prominence = Math.abs(head.price - shoulderAverage) / shoulderAverage;
      components = [
        { label: '肩帶齊度', score: levelFitScore(shoulders.map(p => p.price), 0.12) },
        { label: '頭部突出', score: prominenceFitScore(prominence, 0.05, 0.12) },
        { label: '左右時間', score: balanceFitScore(Math.max(...shoulders.map(p => p.index)) - head.index, head.index - Math.min(...shoulders.map(p => p.index))) },
      ];
      break;
    }
    case 'double-bottom':
    case 'double-top':
    case 'long-double-top': {
      components = [
        { label: '雙點齊度', score: levelFitScore(pivots.slice(0, 2).map(p => p.price), 0.05) },
        { label: '型態深度', score: boundedIdealScore(measuredMove, 0.03, 0.08, 0.20, 0.35) },
      ];
      if (match.patternType === 'long-double-top') {
        components.push({ label: '長週期間距', score: clampScore(60 + Math.min(40, (pivots[0].index - pivots[1].index - LONG_DOUBLE_MIN_GAP) * 2)) });
      }
      break;
    }
    case 'rounding-bottom': {
      const [rightRim, bottom, leftRim] = pivots;
      components = [
        { label: '杯緣齊度', score: levelFitScore([rightRim.price, leftRim.price], 0.15) },
        { label: '左右弧長', score: balanceFitScore(rightRim.index - bottom.index, bottom.index - leftRim.index) },
        { label: '弧底深度', score: boundedIdealScore(measuredMove, 0.03, 0.10, 0.30, 0.50) },
      ];
      break;
    }
    case 'descending-wedge': {
      const [newHigh, oldHigh, newLow, oldLow] = pivots;
      const highSlope = Math.abs(oldHigh.price - newHigh.price) / (newHigh.index - oldHigh.index);
      const lowSlope = Math.abs(oldLow.price - newLow.price) / (newLow.index - oldLow.index);
      const oldWidth = oldHigh.price - oldLow.price;
      const newWidth = newHigh.price - newLow.price;
      const convergence = lowSlope > 0 ? highSlope / lowSlope : 4;
      const contraction = oldWidth > 0 ? 1 - newWidth / oldWidth : 0;
      components = [
        { label: '切線收斂', score: boundedIdealScore(convergence, 1.2, 1.5, 3.0, 6.0) },
        { label: '寬度縮小', score: boundedIdealScore(contraction, 0.05, 0.20, 0.60, 0.90) },
        { label: '兩線跨度', score: balanceFitScore(newHigh.index - oldHigh.index, newLow.index - oldLow.index) },
      ];
      break;
    }
    case 'falling-diamond': {
      const [h0, h1, h2, h3, l0, l1, l2, l3] = pivots;
      const upperBalance = Math.min(h2.price - h3.price, h1.price - h0.price) / Math.max(h2.price - h3.price, h1.price - h0.price);
      const lowerBalance = Math.min(l3.price - l2.price, l0.price - l1.price) / Math.max(l3.price - l2.price, l0.price - l1.price);
      components = [
        { label: '上緣開收', score: clampScore(60 + 40 * upperBalance) },
        { label: '下緣開收', score: clampScore(60 + 40 * lowerBalance) },
        { label: '菱形深度', score: boundedIdealScore(measuredMove, 0.05, 0.12, 0.30, 0.50) },
      ];
      break;
    }
    case 'n-shape': {
      const [a, b, previousLow] = pivots;
      const leg = a.price - previousLow.price;
      const retracement = leg > 0 ? (a.price - b.price) / leg : 1;
      components = [
        { label: '回檔比例', score: boundedIdealScore(retracement, 0.10, 0.30, 0.65, 0.90) },
        { label: '兩段時間', score: balanceFitScore(b.index - a.index, a.index - previousLow.index) },
      ];
      break;
    }
    case 'inverted-n-top': {
      const [c, a, b] = pivots;
      const leg = a.price - b.price;
      const retracement = leg > 0 ? (c.price - b.price) / leg : 1;
      components = [
        { label: '反彈比例', score: boundedIdealScore(retracement, 0.10, 0.30, 0.65, 0.90) },
        { label: '兩段時間', score: balanceFitScore(c.index - b.index, b.index - a.index) },
      ];
      break;
    }
    case 'one-line-top': {
      const [boxHigh, support] = pivots;
      const range = (boxHigh.price - support.price) / support.price;
      components = [
        { label: '箱型窄幅', score: boundedIdealScore(range, 0.005, 0.02, 0.06, 0.10) },
      ];
      break;
    }
  }

  const valid = components.filter(component => Number.isFinite(component.score));
  const score = averageScore(valid.map(component => clampScore(component.score)));
  return {
    score,
    reasons: valid.map(component => `${component.label} ${Math.round(component.score)}`),
  };
}

function evaluatePatternQuality(
  match: PatternMatch | TopPatternMatch,
  candles: CandleWithIndicators[],
  idx: number,
  kind: PatternKind,
): PatternQuality {
  const currentClose = candles[idx]?.close ?? 0;
  const neckline = match.necklinePrice;
  const confirmation = neckline * (kind === 'bottom'
    ? 1 + TRUE_BREAKOUT_PCT
    : 1 - TRUE_BREAKDOWN_PCT);
  const measuredMovePct = Math.abs(match.patternTargetPrice - neckline) / neckline;
  // 一字頂本來就是 ≤10% 窄幅箱型，允許較淺的 0.5% 結構；其他型態至少 3%。
  const minimumMeasuredMovePct = match.patternType === 'one-line-top' ? 0.005 : MIN_MEASURED_MOVE_PCT;
  const latestPivotIndex = Math.max(...match.pivots.map(pivot => pivot.index));
  const formationBoundary = getPatternFormationBoundaryPrice(match.patternType, match.pivots, kind);
  const sinceFormation = candles.slice(latestPivotIndex, idx + 1);
  const confirmationOffset = sinceFormation.findIndex(candle =>
    kind === 'bottom' ? candle.close >= confirmation : candle.close <= confirmation,
  );
  const confirmationIndex = confirmationOffset >= 0 ? latestPivotIndex + confirmationOffset : -1;
  const afterConfirmation = confirmationIndex >= 0 ? candles.slice(confirmationIndex, idx + 1) : [];
  const terminalOffset = afterConfirmation.findIndex(candle =>
    kind === 'bottom'
      ? candle.close >= match.patternTargetPrice || candle.close <= match.structureBrokenPrice * (1 - TRUE_BREAKOUT_PCT)
      : candle.close <= match.patternTargetPrice || candle.close >= match.structureBrokenPrice * (1 + TRUE_BREAKDOWN_PCT),
  );
  const terminalIndex = terminalOffset >= 0 ? confirmationIndex + terminalOffset : -1;
  const eventIndex = terminalIndex >= 0
    ? terminalIndex
    : confirmationIndex >= 0
      ? confirmationIndex
      : latestPivotIndex;
  const eventAge = Math.max(0, idx - eventIndex);
  const pendingDistance = kind === 'bottom'
    ? Math.max(0, (neckline - currentClose) / neckline)
    : Math.max(0, (currentClose - neckline) / neckline);
  const confirmedOvershoot = kind === 'bottom'
    ? Math.max(0, (currentClose - neckline) / neckline)
    : Math.max(0, (neckline - currentClose) / neckline);
  const formationBroken = confirmationIndex < 0 && formationBoundary != null && Number.isFinite(formationBoundary) && sinceFormation.some(candle =>
    kind === 'bottom'
      ? candle.close < formationBoundary
      : candle.close > formationBoundary,
  );

  const correctDirection = kind === 'bottom'
    ? match.patternTargetPrice > neckline
    : match.patternTargetPrice < neckline;
  const relevant =
    correctDirection &&
    measuredMovePct >= minimumMeasuredMovePct &&
    measuredMovePct <= MAX_MEASURED_MOVE_PCT &&
    pendingDistance <= MAX_PENDING_NECKLINE_DISTANCE_PCT &&
    (terminalIndex >= 0 || confirmedOvershoot <= 0.20) &&
    !formationBroken &&
    eventAge <= (terminalIndex >= 0 ? MAX_TERMINAL_EVENT_AGE_BARS : MAX_STRUCTURE_EVENT_AGE_BARS);
  const displayReady = relevant &&
    pendingDistance <= DISPLAY_MAX_PENDING_NECKLINE_DISTANCE_PCT &&
    eventAge <= DISPLAY_MAX_EVENT_AGE_BARS;

  const proximityScore = Math.max(0, 60 * (1 - pendingDistance / MAX_PENDING_NECKLINE_DISTANCE_PCT));
  const recencyLimit = terminalIndex >= 0 ? MAX_TERMINAL_EVENT_AGE_BARS : MAX_STRUCTURE_EVENT_AGE_BARS;
  const recencyScore = Math.max(0, 40 * (1 - eventAge / recencyLimit));
  const geometry = scorePatternGeometry(match);
  return {
    score: geometry.score,
    timingScore: Math.round(proximityScore + recencyScore),
    reasons: geometry.reasons,
    relevant,
    displayReady,
  };
}

const BOTTOM_DETECTORS = [
  detectTripleBottom,
  detectRoundingBottom,
  detectHeadShoulder,
  detectComplexHeadShoulder,
  detectNShape,
  detectDescendingWedge,
  detectFallingDiamond,
  detectDoubleBottom,
] as const;

function getRankedBottomMatches(
  candles: CandleWithIndicators[],
  idx: number,
  requireCurrentRelevance: boolean,
): RankedMatch<PatternMatch>[] {
  const ranked = BOTTOM_DETECTORS
    .flatMap(detector => {
      const match = detector(candles, idx);
      if (!match || !isValidPatternMatch(match)) return [];
      const quality = evaluatePatternQuality(match, candles, idx, 'bottom');
      if (requireCurrentRelevance && !quality.relevant) return [];
      return [{ match, quality }];
    })
    .sort((a, b) =>
      b.quality.score - a.quality.score ||
      b.quality.timingScore - a.quality.timingScore ||
      Math.max(...b.match.pivots.map(pivot => pivot.index)) - Math.max(...a.match.pivots.map(pivot => pivot.index)),
    );
  // 雙重底是多數多腳型態的子集合；已有合格的完整型態時，不用子集合覆蓋分類。
  return ranked.some(candidate => candidate.match.patternType !== 'double-bottom' && candidate.quality.score >= SUBPATTERN_SUPPRESSION_MIN_QUALITY_SCORE)
    ? ranked.filter(candidate => candidate.match.patternType !== 'double-bottom')
    : ranked;
}

function makeResult(
  match: PatternMatch,
  closePrice: number,
  bodyPct: number,
  volumeRatio: number,
  quality: PatternQuality,
): LetterNResult {
  const breakoutThreshold = match.necklinePrice * (1 + TRUE_BREAKOUT_PCT);
  // 結構失效門檻 = 頸線 ×0.97（與真突破對稱，書本對「跌破」也用 ×3% 確認）
  const structureBrokenThreshold = match.structureBrokenPrice * (1 - TRUE_BREAKOUT_PCT);

  // 結構成立但未過真突破 / 已達目標：triggered=false，但仍回傳 pivots+頸線等供走圖視覺化
  const structureOnly = (detail: string): LetterNResult => ({
    triggered: false,
    patternType: match.patternType,
    achievementRate: getLegacyBookAchievementRate(match.patternType),
    necklinePrice: match.necklinePrice,
    breakoutThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    qualityScore: quality.score,
    qualityReasons: quality.reasons,
    displayReady: quality.displayReady,
    detail,
  });

  // 真突破檢查：close ≥ neckline × 1.03
  if (closePrice < breakoutThreshold) {
    return structureOnly('N 型態結構成立但未過 ×3% 真突破');
  }

  // ⚠️ 自創 padding（書本沒明寫量化）— 2026-05-11
  // 防 detector 抓到「舊型態延伸線」誤觸發進場（如 002788.SZ neckline 10.12 / close 14.17 = +40%）
  // 書本本意支持：突破當下進場，不追過頭（《抓飆股》Part 7「突破後追漲不利」原則）
  // 0513 ABCDE D：標自創 — 改動需 JSDoc 註明理由
  if (closePrice > match.necklinePrice * 1.20) {
    return structureOnly('N 型態 close 已遠超頸線（>+20%），突破已發生很久非進場時機');
  }

  // ⚠️ 自創 padding（書本沒明寫量化）— 2026-05-10
  // 防 detector 抓到「已達目標型態」誤觸發進場（如 4722.TW close=236 / target=193）
  // 書本本意支持：型態突破達目標即啟動停利，不會再被視為新進場（《抓飆股》Part 7）
  // 0513 ABCDE D：標自創 — ×0.97 是業界慣例緩衝，可未來改用 ATR-based
  if (closePrice >= match.patternTargetPrice * 0.97) {
    return structureOnly('N 型態已接近/超過目標價，視為已達標非進場時機');
  }

  // 2026-07-05 回測-3 按課程：課程 6-4 只收高勝率型態當進場；雙重底書本明寫達成率 36%
  // → 不再發進場訊號（triggered:false），保留結構顯示供走圖參考。
  const achievementRate = getLegacyBookAchievementRate(match.patternType);
  if (isLegacyBookObservationOnly(match.patternType)) {
    return structureOnly(`N ${getPatternName(match.patternType)} 達成率僅 ${achievementRate}%（課程只收高勝率型態）— 僅顯示不進場`);
  }
  if (isCrossMarketObservationOnly(match.patternType)) {
    return structureOnly(`N ${getPatternName(match.patternType)} 跨市場回測未通過執行門檻—僅顯示不進場`);
  }

  return {
    triggered: true,
    patternType: match.patternType,
    achievementRate,
    necklinePrice: match.necklinePrice,
    breakoutThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    bodyPct,
    volumeRatio,
    qualityScore: quality.score,
    qualityReasons: quality.reasons,
    displayReady: quality.displayReady,
    detail: `N ${getPatternName(match.patternType)}（${achievementRate != null ? `書本達成率 ${achievementRate}%+` : ''}突破頸線 ${match.necklinePrice.toFixed(2)}×3%+紅K${bodyPct.toFixed(2)}%）`,
  };
}

function getPatternName(t: PatternType): string {
  const names: Record<PatternType, string> = {
    'head-shoulder': '頭肩底',
    'triple-bottom': '三重底',
    'rounding-bottom': '圓弧底',
    'complex-head-shoulder': '複式頭肩底',
    'falling-diamond': '跌菱形',
    'descending-wedge': '下降楔形',
    'double-bottom': '雙重底',
    'n-shape': 'N 字底',
  };
  return names[t];
}

function getTopPatternName(t: TopPatternType): string {
  const names: Record<TopPatternType, string> = {
    'head-shoulder-top': '頭肩頂',
    'triple-top': '三重頂',
    'double-top': '雙重頂',
    'complex-head-shoulder-top': '複式頭肩頂',
    'inverted-n-top': '倒N字頂',
    'long-double-top': '長雙頭頂',
    'one-line-top': '一字頂',
  };
  return names[t];
}

// ── 三重底（書本達成率 95%，3 個轉折低點價位相近）─────────────────────────

const TRIPLE_BOTTOM_TOLERANCE_PCT = 0.05; // 3 低點價位差 ≤ 5%

function detectTripleBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 3);
  const allHighs = pivots.filter(p => p.type === 'high');

  if (lows.length < 3 || allHighs.length < 2) return null;

  // 三低點價位相近
  const [low1, low2, low3] = lows; // 由新到舊
  const minLow = Math.min(low1.price, low2.price, low3.price);
  const maxLow = Math.max(low1.price, low2.price, low3.price);
  if ((maxLow - minLow) / minLow > TRIPLE_BOTTOM_TOLERANCE_PCT) return null;

  // 頸線必須由「三個底之間的兩個內部高點」組成
  // 過濾 highs：index 在 [low3.index, low1.index] 範圍內（lows 是新→舊，所以 low3.index < low1.index）
  const olderPeak = allHighs
    .filter(h => h.index > low3.index && h.index < low2.index)
    .sort((a, b) => b.price - a.price)[0];
  const newerPeak = allHighs
    .filter(h => h.index > low2.index && h.index < low1.index)
    .sort((a, b) => b.price - a.price)[0];
  if (!olderPeak || !newerPeak) return null;
  const interiorHighs = [newerPeak, olderPeak];

  // 水平化頸線需站上兩個內部高點，故取較高者；取低點會在只過第一道壓力時提早確認。
  const necklinePrice = getConservativeHorizontalNeckline(interiorHighs.map(high => high.price), 'bottom');
  if (necklinePrice == null) return null;

  // 三重底目標價 = 頸線 + (頸線 - 三底最低點)
  // 書本《抓飆股》Part 7：用最低點測量幅度，不用平均
  const lowestLow = Math.min(low1.price, low2.price, low3.price);
  const patternTargetPrice = necklinePrice + (necklinePrice - lowestLow);

  // 結構失效 = 跌破頸線（書本《抓飆股》Part 7 標準：突破後回測頸線跌破則結構破壞）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：3 lows (新→舊) + 2 interior highs（標籤 L1/L2/L3 + H1/H2）
  return {
    patternType: 'triple-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [low1, low2, low3, interiorHighs[0], interiorHighs[1]],
  };
}

// ── 頭肩底（書本達成率 83%）──────────────────────────────────────────────

function detectHeadShoulder(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 3);
  const allHighs = pivots.filter(p => p.type === 'high');

  if (lows.length < 3 || allHighs.length < 2) return null;

  // 由新到舊：right shoulder, head, left shoulder
  const [rightShoulder, head, leftShoulder] = lows;

  // 頭部低於兩肩（書本「頭低於兩肩」）
  if (head.price >= rightShoulder.price || head.price >= leftShoulder.price) {
    return null;
  }

  // 兩肩價位接近（差 < 10%）
  const shoulderDiff = Math.abs(rightShoulder.price - leftShoulder.price);
  const shoulderAvg = (rightShoulder.price + leftShoulder.price) / 2;
  if (shoulderDiff / shoulderAvg > 0.10) return null;
  if ((shoulderAvg - head.price) / shoulderAvg < 0.03) return null;

  // 頸線必須由「三低點之間的兩內部高點」組成（書本「左頸線 + 右頸線」）
  // lows 新→舊：rightShoulder.index > head.index > leftShoulder.index
  // 內部高點：left-high 在 leftShoulder 與 head 之間；right-high 在 head 與 rightShoulder 之間
  const leftNeck = allHighs
    .filter(h => h.index > leftShoulder.index && h.index < head.index)
    .sort((a, b) => b.price - a.price)[0];
  const rightNeck = allHighs
    .filter(h => h.index > head.index && h.index < rightShoulder.index)
    .sort((a, b) => b.price - a.price)[0];
  if (!leftNeck || !rightNeck) return null;
  const interiorHighs = [rightNeck, leftNeck];

  // 水平化頸線需站上兩個頸線高點，故取較高者。
  const necklinePrice = getConservativeHorizontalNeckline(interiorHighs.map(high => high.price), 'bottom');
  if (necklinePrice == null) return null;

  // 目標價 = 頸線 + (頸線 - 頭部最低)（書本明寫公式）
  const patternTargetPrice = necklinePrice + (necklinePrice - head.price);

  // 結構失效 = 跌破頸線（書本標準：突破後回測頸線跌破則結構破壞）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：RS / Head / LS + 2 interior necks（標籤 RS/H/LS + RN/LN）
  return {
    patternType: 'head-shoulder',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [rightShoulder, head, leftShoulder, interiorHighs[0], interiorHighs[1]],
  };
}

// ── 下降楔形（書本達成率 90%，2026-05-09 補實作）─────────────────────────────
//
// 抓住線圖型態附錄：高點下降切線 + 低點下降切線收斂，突破上切線做多
// 條件：
//   1. ≥ 2 個 confirmed highs 且 highs[0] < highs[1]（高點下降）
//   2. ≥ 2 個 confirmed lows  且 lows[0] < lows[1] （低點下降）
//   3. 高點下降斜率（更陡）> 低點下降斜率（較緩）— 兩線收斂
//   4. 收盤突破今日「兩高點延伸線」

const WEDGE_CONVERGENCE_RATIO = 1.2; // 高點下降速度至少是低點的 1.2x（收斂）

function detectDescendingWedge(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 2);
  if (highs.length < 2 || lows.length < 2) return null;
  if (!hasAlternatingDistinctPivots([...highs, ...lows])) return null;

  // 高點 + 低點都要下降
  if (highs[0].price >= highs[1].price) return null;
  if (lows[0].price >= lows[1].price) return null;

  // 高點下降斜率（單位：價/天，取絕對值）
  // pivots 是 newest-first，highs[0] 較新（index 大）、highs[1] 較舊（index 小）
  // 修正：span = newer - older = 正數（原本寫反了 → highSpan 永遠 ≤ 0 → 永遠 return null）
  const highSpan = highs[0].index - highs[1].index;
  const lowSpan  = lows[0].index  - lows[1].index;
  // 最低 5 天 span — 避免交界日雙重 pivot 產生 1-day 不穩定斜率
  // （楔形結構至少要橫跨 1 週才有意義）
  if (highSpan < 5 || lowSpan < 5) return null;
  // 取絕對值（descending 時 highs[1].price > highs[0].price，差為負，除以正 span 為負，加 abs）
  const highSlope = Math.abs(highs[1].price - highs[0].price) / highSpan;
  const lowSlope  = Math.abs(lows[1].price  - lows[0].price)  / lowSpan;

  // 高點降速 > 低點降速 × 1.2 = 收斂
  if (highSlope <= lowSlope * WEDGE_CONVERGENCE_RATIO) return null;
  const oldWidth = highs[1].price - lows[1].price;
  const newWidth = highs[0].price - lows[0].price;
  if (oldWidth <= 0 || newWidth <= 0 || newWidth >= oldWidth) return null;

  // 兩高點延伸線今日值（hNew + 斜率 × (今日 - hNew.index)）
  // 注意：highs[0] 比較新（index 較大），slope 為正（後高 > 前高的方向，但這裡前高>後高所以 slope 為負）
  // 重新計算：用 highs[1] (older) → highs[0] (newer)
  const upperToday = projectPivotLinePrice(highs[1], highs[0], idx);
  if (upperToday == null) return null;

  // 楔形目標 = 突破點 + 楔形最大寬度（書本未明寫公式，採保守值：頸線+楔形入口寬度）
  const wedgeWidth = highs[1].price - lows[1].price;
  const patternTargetPrice = upperToday + wedgeWidth;

  // pivots 順序：2 highs (新→舊) + 2 lows (新→舊)（標籤 H1/H2 + L1/L2）
  return {
    patternType: 'descending-wedge',
    necklinePrice: upperToday,
    patternTargetPrice,
    structureBrokenPrice: upperToday,  // 跌破上切線 = 結構失效（書本標準：突破點即頸線）
    pivots: [highs[0], highs[1], lows[0], lows[1]],
  };
}

// ── 複式頭肩底（書本達成率 80%，2026-05-09 補實作）──────────────────────────
//
// 多頭肩 + 頭 + 多右肩。簡化實作：≥ 5 個 confirmed lows，最低位於中間（頭），
// 兩側肩價位接近（差 < 15%）。
//
// 跟一般頭肩底差別：兩側肩可以各 ≥ 2 個（不只 1 個）

function detectComplexHeadShoulder(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 5);
  const allHighs = pivots.filter(p => p.type === 'high');
  if (lows.length < 5) return null;

  // 找最低（頭），必須在中間（不能是最新或最舊）
  let headIdx = -1;
  let headPrice = Infinity;
  for (let i = 0; i < lows.length; i++) {
    if (lows[i].price < headPrice) {
      headPrice = lows[i].price;
      headIdx = i;
    }
  }
  if (headIdx === 0 || headIdx === lows.length - 1) return null;  // 頭必須在中間

  const head = lows[headIdx];
  const leftShoulders = lows.slice(headIdx + 1);   // 較舊（lows 由新→舊）
  const rightShoulders = lows.slice(0, headIdx);   // 較新

  // 複式頭肩底必須兩側各至少 2 個肩；不可為提高觸發率放寬成一般頭肩底。
  if (leftShoulders.length < 2 || rightShoulders.length < 2) return null;

  // 除了兩側平均接近，每一個肩也必須落在共同肩帶內。
  // 舊版只比左右平均，極高肩與極低肩可互相抵銷後誤判通過。
  if (!hasCoherentComplexShoulders(
    leftShoulders.map(shoulder => shoulder.price),
    rightShoulders.map(shoulder => shoulder.price),
    head.price,
    'bottom',
  )) return null;

  // 頸線：頭兩側內部高點（在 head 跟兩側肩之間），取較低
  const orderedLows = [...lows].sort((a, b) => a.index - b.index);
  const interiorHighs = orderedLows.slice(0, -1).flatMap((low, position) => {
    const nextLow = orderedLows[position + 1];
    const peak = allHighs
      .filter(high => high.index > low.index && high.index < nextLow.index)
      .sort((a, b) => b.price - a.price)[0];
    return peak ? [peak] : [];
  });
  if (interiorHighs.length < orderedLows.length - 1) return null;
  const necklinePrice = getConservativeHorizontalNeckline(interiorHighs.map(high => high.price), 'bottom');
  if (necklinePrice == null) return null;

  // 目標價 = 頸線 + (頸線 - 頭部最低)
  const patternTargetPrice = necklinePrice + (necklinePrice - head.price);
  // 結構失效 = 跌破頸線（書本標準）
  const structureBrokenPrice = necklinePrice;

  // 走圖必須保留所有肩、頭與頸線高點；necklinePrice 是從全部 interiorHighs
  // 算出，若只回傳前兩點，畫面可能看不到真正決定頸線的那一點。
  return {
    patternType: 'complex-head-shoulder',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [...rightShoulders, head, ...leftShoulders, ...interiorHighs],
  };
}

// ── 跌菱形（書本達成率 80%，2026-05-09 補實作）────────────────────────────
//
// 高點先擴大後收斂的菱形結構：4 個 confirmed highs
//   - 較舊 2 高擴張（後高 > 前高）
//   - 較新 2 高收斂（後高 < 前高）
// 突破上頸線做多

function detectFallingDiamond(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 4);
  const lows  = pivots.filter(p => p.type === 'low').slice(0, 4);
  if (highs.length < 4 || lows.length < 4) return null;
  const diamondPivots = [...highs, ...lows];
  if (!hasAlternatingDistinctPivots(diamondPivots)) return null;

  // highs 由新→舊：[h0, h1, h2, h3]
  // 較舊 2 高擴張：h3 < h2（後高 > 前高）
  // 較新 2 高收斂：h0 < h1（後高 < 前高）
  const [h0, h1, h2, h3] = highs;
  if (h3.price >= h2.price) return null;  // 較舊段必須擴張
  if (h0.price >= h1.price) return null;  // 較新段必須收斂

  // 菱形不能只看上緣：下緣也必須先向下擴張、再向上收斂。
  // lows 同樣由新→舊：[l0, l1, l2, l3]。
  const [l0, l1, l2, l3] = lows;
  if (l3.price <= l2.price) return null;  // 較舊段低點往下擴張
  if (l0.price <= l1.price) return null;  // 較新段低點往上收斂

  // 菱形最高 = h1 或 h2 中較高（菱形頂點附近）
  const peakHigh = Math.max(h1.price, h2.price);

  // 突破線應是右半邊「下降上緣」的今日延伸值，不是整顆菱形的歷史最高點。
  // 舊版直接拿 peakHigh 當水平頸線，會把確認門檻與目標整體抬高，造成長期不可能確認。
  const upperSpan = h0.index - h1.index;
  if (upperSpan < 3) return null;
  const necklinePrice = projectPivotLinePrice(h1, h0, idx);
  if (necklinePrice == null) return null;

  // 目標價 = 突破點 + 菱形高度（最高 - 最低）
  const peakLow = Math.min(l0.price, l1.price, l2.price, l3.price);
  const diamondHeight = peakHigh - peakLow;
  const patternTargetPrice = necklinePrice + diamondHeight;

  // pivots 順序：4 highs (新→舊) + 4 lows (新→舊)（標籤 H1-H4 + L1-L4）
  return {
    patternType: 'falling-diamond',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,
    pivots: diamondPivots,
  };
}

// ── 雙重底（書本達成率 36%，2026-05-09 補實作；低達成率加警示）────────────
//
// 2 個價位接近的 confirmed lows + 中間 1 個 confirmed high 當頸線
// 收盤突破頸線做多

const DOUBLE_BOTTOM_TOLERANCE_PCT = 0.05; // 兩底價位差 ≤ 5%

function detectDoubleBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const lows = pivots.filter(p => p.type === 'low').slice(0, 2);
  const allHighs = pivots.filter(p => p.type === 'high');
  if (lows.length < 2) return null;

  // 兩底價位接近
  const [low1, low2] = lows;  // 由新到舊
  const minLow = Math.min(low1.price, low2.price);
  const maxLow = Math.max(low1.price, low2.price);
  if ((maxLow - minLow) / minLow > DOUBLE_BOTTOM_TOLERANCE_PCT) return null;

  // 中間至少 1 個 confirmed high（頸線）
  const interiorHighs = allHighs.filter(h => h.index > low2.index && h.index < low1.index);
  if (interiorHighs.length < 1) return null;

  // 頸線 = 中間最高點（雙底突破頸線後做多）
  const necklinePrice = Math.max(...interiorHighs.map(h => h.price));

  // 目標價 = 頸線 + (頸線 - 兩底最低)
  // 書本《抓飆股》Part 7：用最低點測量幅度，不用平均
  const lowestLow = Math.min(low1.price, low2.price);
  const patternTargetPrice = necklinePrice + (necklinePrice - lowestLow);

  // pivots 順序：2 lows (新→舊) + 中間最高高點（標籤 L1/L2 + H）
  const peakHigh = interiorHighs.find(h => h.price === necklinePrice) ?? interiorHighs[0];
  return {
    patternType: 'double-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,  // 跌破頸線（書本標準）
    pivots: [low1, low2, peakHigh],
  };
}

// ── 圓弧底（書本達成率 85%）──────────────────────────────────────────────

function detectRoundingBottom(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  // 圓弧底：碗狀，底部漸進形成，需要至少 20 根 K 線觀察
  const lookback = 30;
  const start = Math.max(0, idx - lookback);
  if (idx - start < 20) return null;

  let arcLow = Infinity;
  let arcLowIdx = -1;
  for (let i = start; i <= idx; i++) {
    if (candles[i].low < arcLow) {
      arcLow = candles[i].low;
      arcLowIdx = i;
    }
  }

  // 弧底大致在中間（前後比例不超過 1:3 / 3:1）
  const beforeLen = arcLowIdx - start;
  const afterLen = idx - arcLowIdx;
  if (beforeLen < 5 || afterLen < 5) return null;
  if (beforeLen > afterLen * 3 || afterLen > beforeLen * 3) return null;

  // 弧底前最高 + 弧底後最高（取較低者作頸線）
  let beforeHigh = -Infinity;
  let beforeHighIdx = start;
  let afterHigh = -Infinity;
  let afterHighIdx = arcLowIdx;
  for (let i = start; i <= arcLowIdx; i++) {
    if (candles[i].high > beforeHigh) { beforeHigh = candles[i].high; beforeHighIdx = i; }
  }
  for (let i = arcLowIdx; i <= idx; i++) {
    if (candles[i].high > afterHigh) { afterHigh = candles[i].high; afterHighIdx = i; }
  }
  const necklinePrice = Math.min(beforeHigh, afterHigh);

  // 弧底深度
  const arcDepth = necklinePrice - arcLow;
  if (arcDepth <= 0) return null;

  // ⚠️ 自創防誤判條件：舊版只要「30 根內中央有最低點、前後各有高點」就成立，
  // 幾乎每次急跌 V 轉都會被標成圓弧底。圓弧底至少還要具備左右杯緣接近、
  // 底部有停留時間，且右側回升後沒有再次明顯跌離頸線。
  const rimDiffRatio = Math.abs(beforeHigh - afterHigh) / necklinePrice;
  if (rimDiffRatio > 0.15) return null;

  // 曲率 V2：兩翼不能由單根急殺／急拉主導，且底部中段的平均波動要小於兩翼。
  // 2023-2026 TW 歷史研究：通過組 D20 去大盤超額 +1.12%，被砍組 -1.20%，
  // train/test 方向一致；用來排除外觀像碗、實際仍是 V 轉或劇烈震盪的案例。
  const leftDrop = beforeHigh - arcLow;
  const rightRise = candles[idx].close - arcLow;
  if (leftDrop <= 0 || rightRise <= 0) return null;
  let maxBarDrop = 0;
  let maxBarRise = 0;
  for (let i = start + 1; i <= arcLowIdx; i++) {
    maxBarDrop = Math.max(maxBarDrop, candles[i - 1].close - candles[i].close);
  }
  for (let i = arcLowIdx + 1; i <= idx; i++) {
    maxBarRise = Math.max(maxBarRise, candles[i].close - candles[i - 1].close);
  }
  if (maxBarDrop / leftDrop > 0.50 || maxBarRise / rightRise > 0.50) return null;

  const arcLength = idx - start;
  const middleHalfWidth = Math.max(2, Math.round(arcLength / 6));
  const middleStart = Math.max(start + 1, arcLowIdx - middleHalfWidth);
  const middleEnd = Math.min(idx, arcLowIdx + middleHalfWidth);
  const middleMoves: number[] = [];
  const wingMoves: number[] = [];
  for (let i = start + 1; i <= idx; i++) {
    if (candles[i - 1].close <= 0) continue;
    const move = Math.abs(candles[i].close / candles[i - 1].close - 1);
    if (i >= middleStart && i <= middleEnd) middleMoves.push(move);
    else wingMoves.push(move);
  }
  if (middleMoves.length === 0 || wingMoves.length === 0) return null;
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (average(middleMoves) > average(wingMoves)) return null;

  // 底部帶取弧深下方 25%；至少連續橫跨 5 根且有 5 根收盤落在帶內，
  // 排除只有 1～3 根低點的尖銳 V 形反轉。
  const bottomBand = arcLow + arcDepth * 0.25;
  const bottomIndices: number[] = [];
  for (let i = start; i <= idx; i++) {
    if (candles[i].close <= bottomBand) bottomIndices.push(i);
  }
  if (bottomIndices.length < 5) return null;
  let longestBottomRun = 1;
  let currentBottomRun = 1;
  for (let i = 1; i < bottomIndices.length; i++) {
    currentBottomRun = bottomIndices[i] === bottomIndices[i - 1] + 1 ? currentBottomRun + 1 : 1;
    longestBottomRun = Math.max(longestBottomRun, currentBottomRun);
  }
  if (longestBottomRun < 5) return null;

  // 右側曾回到杯緣後又跌離頸線超過 10%，視為這一組腳位已陳舊，不繼續顯示
  // 尚未確認的遠端目標與「回測防守」。
  if (candles[idx].close < necklinePrice * 0.90) return null;

  // 目標價 = 頸線 + 弧底深度
  // 書本《抓飆股》Part 7：圓弧底測量幅度為「頸線 + 弧底到頸線的高度」（不額外乘 1.5）
  const patternTargetPrice = necklinePrice + arcDepth;

  // pivots 順序：弧後高 (新) + 最低點 + 弧前高 (舊)（標籤 H1/Lowest/H2）
  return {
    patternType: 'rounding-bottom',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,  // 跌破頸線（書本標準；之前誤標為弧底）
    pivots: [
      { index: afterHighIdx,  price: afterHigh,  type: 'high' },
      { index: arcLowIdx,     price: arcLow,     type: 'low'  },
      { index: beforeHighIdx, price: beforeHigh, type: 'high' },
    ],
  };
}

// ── N 字底（2026-05-10 補實作）──────────────────────────────────────────────
//
// 書本《抓飆股》Part 7：上漲中的回測再攻
//   結構：A（高）→ B（低，不破前低）→ C（紅K收盤過 A 高）
//   目標 = C 突破點 + (A 高 − B 低)
  //   原始型態失效 = 確認前跌破 B 低；突破後回測失敗則看 A 頸線 ×0.97。
//
// 與其他底部型態不同：N 字底前提是「已在上漲」，B 不創新低，
// 是回檔後再攻創新高的延續型態（接近 P 高檔拉回但有頭部突破要件）

function detectNShape(
  candles: CandleWithIndicators[],
  idx: number,
): PatternMatch | null {
  const pivots = findPivots(candles, idx, 8, false, 0.005);
  // 需要近期 1 個 high (A) → 1 個 low (B)
  // pivots 由新到舊，最新是 high (A 已被超越的舊高)，再來是 low (B)
  const highs = pivots.filter(p => p.type === 'high');
  const lows  = pivots.filter(p => p.type === 'low');
  if (highs.length < 1 || lows.length < 1) return null;

  const a = highs[0];  // A：最近的高
  const b = lows[0];   // B：最近的低

  // B 必須晚於 A（A→B 順序）— 回檔型態才合理
  if (b.index <= a.index) return null;

  // 收盤要過 A 高（×3% 真突破由 makeResult 統一檢查；這裡先確保結構）
  if (candles[idx].close <= a.price) return null;

  // B 不破前低：必須有更早的低點作為比較基準，且 B 嚴格高於它
  // 若無更早 pivot，無從判斷「不破底」結構是否成立 → reject（避免 vacuous pass）
  const prevLow = lows[1];
  if (!prevLow || b.price <= prevLow.price) return null;

  // 目標價 = 正波段算法（課程 6-4：N 字底是 6 型態裡唯一例外，「只有它不一樣」）
  // 2026-07-12 修：課程 6-4 明訂 N 字底不用「突破點+型態高度」一般算法，改用正波段——
  //   型態距離＝前高 A（壓力）− 型態低點（支撐，取較深的第一隻腳 prevLow）；
  //   目標價＝從「突破點往前找的轉折低」（右腳 B）往上算一個型態距離＝ B + (A − prevLow)。
  //   （量初升腿 prevLow→A 的長度，從右腳 B 投射，= 教科書量測移動；非退化成 A）
  const patternHeight = a.price - prevLow.price;
  if (patternHeight <= 0) return null;
  // B 必須是可辨識的回檔，不可高於 A，也不可幾乎跌回前低；否則只是雜訊或已破壞初升段。
  const retracement = (a.price - b.price) / patternHeight;
  if (retracement < 0.10 || retracement > 0.90) return null;
  const patternTargetPrice = b.price + patternHeight;

  // pivots 順序：A 高（突破點）+ B 低（右腳）+ 前低（初升腿起點）。
  // 目標公式實際使用前低，圖上也必須畫出，否則使用者無法核對投射距離。
  return {
    patternType: 'n-shape',
    necklinePrice: a.price,           // A 高 = 突破點
    patternTargetPrice,
    structureBrokenPrice: a.price,    // 跌破頸線（A 高 = 突破點 = 頸線）；書本標準
    pivots: [a, b, prevLow],
  };
}

// ── 頂部型態（2026-05-10 補實作）── 出場用，獨立於 detectLetterN 流程 ────────────
//
// 觸發條件：紅 K 反向（黑 K）+ 跌破頸線
// 目標價：頸線 - (頂高 - 頸線)
// 結構失效（停損點）：再過頸線

interface TopPatternMatch {
  patternType: TopPatternType;
  necklinePrice: number;
  patternTargetPrice: number;
  structureBrokenPrice: number;
  /** 構成形態的關鍵點，順序由各 detector 決定（CandleChart 依 patternType 推標籤）*/
  pivots: Pivot[];
}

function isValidTopPatternMatch(match: TopPatternMatch): boolean {
  return hasValidPatternGeometry(match) && match.patternTargetPrice < match.necklinePrice;
}

export interface TopPatternResult {
  triggered: boolean;
  patternType?: TopPatternType;
  achievementRate?: number;
  necklinePrice?: number;
  /** ×3% 真跌破門檻 */
  breakdownThreshold?: number;
  patternTargetPrice?: number;
  structureBrokenPrice?: number;
  /** 構成形態的關鍵 pivot 點（走圖視覺化用）*/
  pivots?: Pivot[];
  /** 腳位形狀吻合度（0-100；不含現價距頸線，不是勝率）。 */
  qualityScore?: number;
  qualityReasons?: string[];
  displayReady?: boolean;
  detail: string;
}

const TRUE_BREAKDOWN_PCT = 0.03;

/**
 * 頂部型態偵測（黑K + 跌破頸線×3%）
 *
 * 內部依序檢查：三重頂 → 頭肩頂 → 雙重頂，回傳第一個命中的。
 */
export function detectTopPatterns(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternResult {
  const empty: TopPatternResult = { triggered: false, detail: '頂部型態未觸發' };
  if (idx < N_MIN_HISTORY || candles.length === 0) return empty;

  const c = candles[idx];
  const prev = candles[idx - 1];
  if (!c || !prev || prev.volume <= 0 || c.open <= 0) return empty;

  // 共同前置：黑 K（close < open）+ 實體 ≥ 2% + 量 ≥ 1.3
  // 與 detectLetterN 對稱（書本《抓飆股》Part 7 要求頂部跌破也需爆量確認）
  if (c.close >= c.open) return empty;
  const bodyPct = ((c.open - c.close) / c.open) * 100;
  if (bodyPct < BOOK_BODY_PCT_MIN) return empty;
  const volumeRatio = c.volume / prev.volume;
  if (volumeRatio < BOOK_VOL_RATIO_MIN) return empty;

  const candidates = getRankedTopMatches(candles, idx, true)
    .filter(candidate => candidate.quality.score >= TOP_PATTERN_TRIGGER_MIN_QUALITY_SCORE);
  if (candidates.length === 0) return empty;
  const evaluated = candidates.map(candidate => makeTopResult(candidate.match, c.close, candidate.quality));
  return evaluated.find(result => result.triggered) ?? evaluated[0];
}

/**
 * 頂部結構偵測（走圖視覺化用）：跳過黑K / 量比 / 真跌破 gate。
 */
export function detectTopPatternsStructure(
  candles: CandleWithIndicators[],
  idx: number,
  minimumQualityScore = 0,
): TopPatternResult {
  if (idx < N_MIN_HISTORY || candles.length === 0) return { triggered: false, detail: '' };

  const candidate = getRankedTopMatches(candles, idx, true)
    .find(item => item.quality.score >= minimumQualityScore);
  if (candidate) {
    const { match: m, quality } = candidate;
    return {
      triggered: false,
      patternType: m.patternType,
      achievementRate: undefined,
      necklinePrice: m.necklinePrice,
      breakdownThreshold: m.necklinePrice * (1 - TRUE_BREAKDOWN_PCT),
      patternTargetPrice: m.patternTargetPrice,
      // 結構失效門檻 = 頸線 ×1.03（與真跌破對稱：跌破後又反彈過頸線×3% = 假跌破）
      structureBrokenPrice: m.structureBrokenPrice * (1 + TRUE_BREAKDOWN_PCT),
      pivots: m.pivots,
      qualityScore: quality.score,
      qualityReasons: quality.reasons,
      displayReady: quality.displayReady,
      detail: `結構偵測：${getTopPatternName(m.patternType)}（形狀吻合 ${quality.score}/100，非勝率）`,
    };
  }
  return { triggered: false, detail: '無頂部型態結構' };
}

const TOP_DETECTORS = [
  detectTripleTop,
  detectComplexHeadShoulderTop,
  detectHeadShoulderTop,
  detectInvertedNTop,
  detectLongDoubleTop,
  detectOneLineTop,
  detectDoubleTop,
] as const;

function getRankedTopMatches(
  candles: CandleWithIndicators[],
  idx: number,
  requireCurrentRelevance: boolean,
): RankedMatch<TopPatternMatch>[] {
  const ranked = TOP_DETECTORS
    .flatMap(detector => {
      const match = detector(candles, idx);
      if (!match || !isValidTopPatternMatch(match)) return [];
      const quality = evaluatePatternQuality(match, candles, idx, 'top');
      if (requireCurrentRelevance && !quality.relevant) return [];
      return [{ match, quality }];
    })
    .sort((a, b) =>
      b.quality.score - a.quality.score ||
      b.quality.timingScore - a.quality.timingScore ||
      Math.max(...b.match.pivots.map(pivot => pivot.index)) - Math.max(...a.match.pivots.map(pivot => pivot.index)),
    );
  // 一般雙頂是其他多腳頂部型態的子集合；完整型態合格時只留完整分類。
  return ranked.some(candidate => candidate.match.patternType !== 'double-top' && candidate.quality.score >= SUBPATTERN_SUPPRESSION_MIN_QUALITY_SCORE)
    ? ranked.filter(candidate => candidate.match.patternType !== 'double-top')
    : ranked;
}

function makeTopResult(match: TopPatternMatch, closePrice: number, quality: PatternQuality): TopPatternResult {
  const breakdownThreshold = match.necklinePrice * (1 - TRUE_BREAKDOWN_PCT);
  // 結構失效門檻 = 頸線 ×1.03（與真跌破對稱）
  const structureBrokenThreshold = match.structureBrokenPrice * (1 + TRUE_BREAKDOWN_PCT);

  // 結構成立但未過真跌破 / 已達目標：triggered=false，但仍回傳 pivots+頸線等供走圖視覺化
  const structureOnly = (detail: string): TopPatternResult => ({
    triggered: false,
    patternType: match.patternType,
    achievementRate: undefined,
    necklinePrice: match.necklinePrice,
    breakdownThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    qualityScore: quality.score,
    qualityReasons: quality.reasons,
    displayReady: quality.displayReady,
    detail,
  });

  // 真跌破檢查：close ≤ neckline × 0.97
  if (closePrice > breakdownThreshold) {
    return structureOnly('頂部型態結構成立但未過 ×3% 真跌破');
  }

  // 與底部型態對稱：跌破已超過頸線 20% 不再當成新的放空／出場觸發。
  if (closePrice < match.necklinePrice * 0.80) {
    return structureOnly('頂部型態 close 已遠低於頸線（>-20%），跌破已發生很久非新警示');
  }

  // ⚠️ 自創 padding（書本沒明寫量化）— 2026-05-10
  // 對稱底部邏輯：close 已下到 target × 1.03 視為「型態已達目標」，避免重複警示
  // 案例：1301.TW close=48.55 / target=48.6 已達標仍警示
  // 0513 ABCDE D：標自創 — ×1.03 對稱 v12LetterN.ts:230 的 ×0.97
  if (closePrice <= match.patternTargetPrice * 1.03) {
    return structureOnly('頂部型態已接近/超過目標價，視為已達標非新警示');
  }

  if (isCrossMarketObservationOnly(match.patternType)) {
    return structureOnly(`${getTopPatternName(match.patternType)}跨市場回測未通過執行門檻—僅顯示不觸發`);
  }

  return {
    triggered: true,
    patternType: match.patternType,
    achievementRate: undefined,
    necklinePrice: match.necklinePrice,
    breakdownThreshold,
    patternTargetPrice: match.patternTargetPrice,
    structureBrokenPrice: structureBrokenThreshold,
    pivots: match.pivots,
    qualityScore: quality.score,
    qualityReasons: quality.reasons,
    displayReady: quality.displayReady,
    detail: `${getTopPatternName(match.patternType)}（跌破頸線 ${match.necklinePrice.toFixed(2)}×3%；教材未提供本型態精確達成率）`,
  };
}

// ── 三重頂 ────────────────────────────────────────────────────────────────

const TRIPLE_TOP_TOLERANCE_PCT = 0.05;

function detectTripleTop(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 3);
  const allLows = pivots.filter(p => p.type === 'low');

  if (highs.length < 3 || allLows.length < 2) return null;

  const [high1, high2, high3] = highs;
  const minHigh = Math.min(high1.price, high2.price, high3.price);
  const maxHigh = Math.max(high1.price, high2.price, high3.price);
  if ((maxHigh - minHigh) / minHigh > TRIPLE_TOP_TOLERANCE_PCT) return null;

  const olderValley = allLows
    .filter(low => low.index > high3.index && low.index < high2.index)
    .sort((a, b) => a.price - b.price)[0];
  const newerValley = allLows
    .filter(low => low.index > high2.index && low.index < high1.index)
    .sort((a, b) => a.price - b.price)[0];
  if (!olderValley || !newerValley) return null;
  const interiorLows = [newerValley, olderValley];

  // 水平化頸線需跌破兩個內部低點，故取較低者；取高點會在只破第一道支撐時提早確認。
  const necklinePrice = getConservativeHorizontalNeckline(interiorLows.map(low => low.price), 'top');
  if (necklinePrice == null) return null;

  // 目標價 = 頸線 - (最高點 - 頸線)
  const highestHigh = Math.max(high1.price, high2.price, high3.price);
  const patternTargetPrice = necklinePrice - (highestHigh - necklinePrice);

  // 結構失效 = 再過頸線（書本標準：跌破後反彈過頸線則結構破壞，假跌破）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：3 highs (新→舊) + 2 interior lows（標籤 H1/H2/H3 + L1/L2）
  return {
    patternType: 'triple-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [high1, high2, high3, interiorLows[0], interiorLows[1]],
  };
}

// ── 頭肩頂 ────────────────────────────────────────────────────────────────

function detectHeadShoulderTop(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 3);
  const allLows = pivots.filter(p => p.type === 'low');

  if (highs.length < 3 || allLows.length < 2) return null;

  // 由新到舊：right shoulder, head, left shoulder
  const [rightShoulder, head, leftShoulder] = highs;

  // 頭部高於兩肩
  if (head.price <= rightShoulder.price || head.price <= leftShoulder.price) return null;

  // 兩肩價位接近（差 < 10%）
  const shoulderDiff = Math.abs(rightShoulder.price - leftShoulder.price);
  const shoulderAvg = (rightShoulder.price + leftShoulder.price) / 2;
  if (shoulderDiff / shoulderAvg > 0.10) return null;
  if ((head.price - shoulderAvg) / shoulderAvg < 0.03) return null;

  // 頸線：三高點之間的兩內部低點
  const leftNeck = allLows
    .filter(low => low.index > leftShoulder.index && low.index < head.index)
    .sort((a, b) => a.price - b.price)[0];
  const rightNeck = allLows
    .filter(low => low.index > head.index && low.index < rightShoulder.index)
    .sort((a, b) => a.price - b.price)[0];
  if (!leftNeck || !rightNeck) return null;
  const interiorLows = [rightNeck, leftNeck];

  // 水平化頸線需跌破兩個頸線低點，故取較低者。
  const necklinePrice = getConservativeHorizontalNeckline(interiorLows.map(low => low.price), 'top');
  if (necklinePrice == null) return null;

  // 目標價 = 頸線 - (頭部最高 - 頸線)
  const patternTargetPrice = necklinePrice - (head.price - necklinePrice);

  // 結構失效 = 再過頸線（書本標準）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：RS / Head / LS + 2 interior necks（標籤 RS/H/LS + RN/LN）
  return {
    patternType: 'head-shoulder-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [rightShoulder, head, leftShoulder, interiorLows[0], interiorLows[1]],
  };
}

// ── 雙重頂 ────────────────────────────────────────────────────────────────

const DOUBLE_TOP_TOLERANCE_PCT = 0.05;

function detectDoubleTop(
  candles: CandleWithIndicators[],
  idx: number,
): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const allLows = pivots.filter(p => p.type === 'low');

  if (highs.length < 2) return null;

  const [high1, high2] = highs;
  const minHigh = Math.min(high1.price, high2.price);
  const maxHigh = Math.max(high1.price, high2.price);
  if ((maxHigh - minHigh) / minHigh > DOUBLE_TOP_TOLERANCE_PCT) return null;

  const interiorLows = allLows.filter((l) => l.index > high2.index && l.index < high1.index);
  if (interiorLows.length < 1) return null;

  // 頸線 = 中間最低點（雙頂跌破頸線後做空）
  const necklinePrice = Math.min(...interiorLows.map((l) => l.price));

  // 目標價 = 頸線 - (兩頂最高 - 頸線)
  const highestHigh = Math.max(high1.price, high2.price);
  const patternTargetPrice = necklinePrice - (highestHigh - necklinePrice);

  // 結構失效 = 再過頸線（書本標準）
  const structureBrokenPrice = necklinePrice;

  // pivots 順序：2 highs (新→舊) + 中間最低低點（標籤 H1/H2 + L）
  const valleyLow = interiorLows.find(l => l.price === necklinePrice) ?? interiorLows[0];
  return {
    patternType: 'double-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice,
    pivots: [high1, high2, valleyLow],
  };
}

// ── S4 v2（2026-07-07 補齊 4 型，皆顯示層；先於對應基本型偵測以取更精確分類）──────

// 長雙頭頂（課程 6-11）：兩頂價位相近但「間隔久」（≥ LONG_DOUBLE_MIN_GAP 根），比一般雙重頂可靠。
const LONG_DOUBLE_MIN_GAP = 20;
function detectLongDoubleTop(candles: CandleWithIndicators[], idx: number): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 12, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const allLows = pivots.filter(p => p.type === 'low');
  if (highs.length < 2) return null;
  const [high1, high2] = highs; // high1 較新、high2 較舊
  if (high1.index - high2.index < LONG_DOUBLE_MIN_GAP) return null;   // 必須間隔久才算「長」雙頭
  const minH = Math.min(high1.price, high2.price), maxH = Math.max(high1.price, high2.price);
  if ((maxH - minH) / minH > DOUBLE_TOP_TOLERANCE_PCT) return null;
  const interiorLows = allLows.filter(l => l.index > high2.index && l.index < high1.index);
  if (interiorLows.length < 1) return null;
  const necklinePrice = Math.min(...interiorLows.map(l => l.price));
  const patternTargetPrice = necklinePrice - (maxH - necklinePrice);
  const valleyLow = interiorLows.find(l => l.price === necklinePrice) ?? interiorLows[0];
  return { patternType: 'long-double-top', necklinePrice, patternTargetPrice, structureBrokenPrice: necklinePrice, pivots: [high1, high2, valleyLow] };
}

// 複式頭肩頂（課程 6-11）：頭部最高、兩側各 ≥2 個相近價位的肩。
function detectComplexHeadShoulderTop(candles: CandleWithIndicators[], idx: number): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 5);
  const allLows = pivots.filter(p => p.type === 'low');
  if (highs.length < 5 || allLows.length < 2) return null;
  // 頭 = 5 高點中最高者，且必須是「內部」（兩側都有肩）
  let headArrIdx = 0;
  for (let i = 1; i < highs.length; i++) if (highs[i].price > highs[headArrIdx].price) headArrIdx = i;
  if (headArrIdx === 0 || headArrIdx === highs.length - 1) return null;
  const head = highs[headArrIdx];
  const rightShoulders = highs.slice(0, headArrIdx);        // 較新側
  const leftShoulders = highs.slice(headArrIdx + 1);        // 較舊側
  if (rightShoulders.length < 2 || leftShoulders.length < 2) return null;  // 複式 = 每側 ≥2 肩
  const shoulders = [...rightShoulders, ...leftShoulders];
  if (shoulders.some(s => s.price >= head.price)) return null;            // 肩皆低於頭
  if (!hasCoherentComplexShoulders(
    leftShoulders.map(shoulder => shoulder.price),
    rightShoulders.map(shoulder => shoulder.price),
    head.price,
    'top',
  )) return null;
  const orderedHighs = [...highs].sort((a, b) => a.index - b.index);
  const interiorLows = orderedHighs.slice(0, -1).flatMap((high, position) => {
    const nextHigh = orderedHighs[position + 1];
    const valley = allLows
      .filter(low => low.index > high.index && low.index < nextHigh.index)
      .sort((a, b) => a.price - b.price)[0];
    return valley ? [valley] : [];
  });
  if (interiorLows.length < orderedHighs.length - 1) return null;
  const necklinePrice = getConservativeHorizontalNeckline(interiorLows.map(low => low.price), 'top');
  if (necklinePrice == null) return null;
  const patternTargetPrice = necklinePrice - (head.price - necklinePrice);
  // 同底部複式型態，保留所有頸線低點，否則圖上只有肩與頭、沒有實際頸線腳位。
  return {
    patternType: 'complex-head-shoulder-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,
    pivots: [head, ...shoulders, ...interiorLows],
  };
}

// 倒N字頂（課程 6-11，n-shape 底之鏡像）：高A → 低B → 反彈高C（不過A＝頭頭低）→ 跌破B。
function detectInvertedNTop(candles: CandleWithIndicators[], idx: number): TopPatternMatch | null {
  const pivots = findPivots(candles, idx, 10, false, 0.005);
  const highs = pivots.filter(p => p.type === 'high').slice(0, 2);
  const lows = pivots.filter(p => p.type === 'low');
  if (highs.length < 2 || lows.length < 1) return null;
  const [highC, highA] = highs;                    // C 較新、A 較舊
  if (highC.price >= highA.price) return null;      // 頭頭低（反彈不過前高）
  if ((highA.price - highC.price) / highA.price < 0.03) return null;  // C 明顯低於 A，避免雙頂誤判
  // findPivots 是新→舊；highC 較新（index 大）、highA 較舊（index 小）。
  // B 必須在 A 與 C 之間：highA.index < B.index < highC.index。
  // 舊條件方向顛倒，形成不可能區間，導致倒 N 字頂永遠偵測不到。
  const lowB = lows.find(l => l.index > highA.index && l.index < highC.index);
  if (!lowB) return null;
  const downLeg = highA.price - lowB.price;
  if (downLeg <= 0) return null;
  const retracement = (highC.price - lowB.price) / downLeg;
  if (retracement < 0.10 || retracement > 0.90) return null;
  const necklinePrice = lowB.price;                 // 跌破 B = 倒N確認（makeTopResult 判 close ≤ B×0.97）
  // 目標價 = 正波段算法（課程 6-11：倒 N 與 N 字底一樣，是 6 頭部型態裡唯一例外）
  // 2026-07-12 修：課程明訂倒 N「不是從跌破點往下減，而是從轉折高往下算」。鏡像 N 字底
  //   （target = 右腳 + (前高 − 深腳)）：型態距離 = 高峰 highA − 頸線 lowB；
  //   從「跌破點往前找的轉折高」（右肩 highC）往下算 = highC − (highA − lowB)。
  const patternHeight = downLeg;
  const patternTargetPrice = highC.price - patternHeight;
  return { patternType: 'inverted-n-top', necklinePrice, patternTargetPrice, structureBrokenPrice: necklinePrice, pivots: [highC, highA, lowB] };
}

// 一字頂（課程 6-11）：高檔「高點不過高、低點不破低」窄幅橫盤盤頭 + 均線靠攏
//（尤其 MA20/MA60 靠在一起）；隨後大量長黑 K 收盤跌破橫盤支撐＝空點。
// 2026-07-12 重寫：原實作要求兩個跳空缺口＝島狀反轉，是「另一個型態」（課程一字頂無缺口要件）；
// 改為鏡像一字底（highWinRateEntry.detectStrategyE 的均線糾結窄幅盤）。
// 大量長黑 + 收盤真跌破支撐（頸線×0.97）由呼叫端 detectTopPatterns / makeTopResult 統一把關。
function detectOneLineTop(candles: CandleWithIndicators[], idx: number): TopPatternMatch | null {
  const MIN_DAYS = 3;          // 課程：一字頂「盤頭時間不會很久」
  const MAX_DAYS = 20;
  const MAX_RANGE_PCT = 0.10;  // 高檔窄幅（區間 ≤10%，鏡像一字底課程 6-4「區間範圍 10%」）
  // ⚠️ 系統防誤判門檻（非教材統計）：一字「頂」前必須已有可辨識漲幅。
  // 若只判箱頂略高於 MA20，任何均線附近的普通橫盤都會被叫成頭部。
  const MIN_PRIOR_RUNUP_PCT = 0.15;
  if (idx < MAX_DAYS + 2) return null;

  // 橫盤窗＝往前擴到最長的窄幅收盤區間（含納 idx-1，不含今日突破 K）
  let start = idx - 1;
  for (let i = idx - 1; i >= Math.max(1, idx - MAX_DAYS); i--) {
    const win = candles.slice(i, idx);            // i .. idx-1
    const closes = win.map(x => x.close);
    const maxC = Math.max(...closes);
    const minC = Math.min(...closes);
    if (minC <= 0) break;
    if ((maxC - minC) / minC > MAX_RANGE_PCT) break;
    start = i;
  }
  const boxDays = (idx - 1) - start + 1;
  if (boxDays < MIN_DAYS) return null;

  const box = candles.slice(start, idx);          // start .. idx-1
  let boxHigh = -Infinity, boxHighIdx = start;
  let supportLow = Infinity, supportIdx = start;
  for (let i = start; i < idx; i++) {
    if (candles[i].high > boxHigh) { boxHigh = candles[i].high; boxHighIdx = i; }
    if (candles[i].close < supportLow) { supportLow = candles[i].close; supportIdx = i; } // 支撐＝橫盤收盤低（跌破用收盤判）
  }
  void box;

  // 均線靠攏：MA5/10/20 糾結 且 MA20 與 MA60 靠攏（課程強調 20/60 靠在一起）
  const ref = candles[idx - 1];
  const { ma5, ma10, ma20, ma60 } = ref;
  if (ma5 == null || ma10 == null || ma20 == null || ma60 == null) return null;
  if (ma60 <= 0) return null;
  const cluster3 = (Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20)) / Math.min(ma5, ma10, ma20);
  if (cluster3 >= 0.03) return null;                       // 三線糾結 <3%
  if (Math.abs(ma20 - ma60) / ma60 >= 0.05) return null;   // MA20 與 MA60 靠攏 <5%

  // 高檔盤頭（排除低檔一字＝一字底）：橫盤高點在均線帶之上
  if (boxHigh <= ma20) return null;
  const priorStart = Math.max(0, start - 60);
  const priorBars = candles.slice(priorStart, start);
  if (priorBars.length < 20) return null;
  const priorLow = Math.min(...priorBars.map(candle => candle.low));
  if (!Number.isFinite(priorLow) || priorLow <= 0 || (boxHigh - priorLow) / priorLow < MIN_PRIOR_RUNUP_PCT) return null;

  const necklinePrice = supportLow;                        // 跌破此支撐＝一字頂確認
  const patternTargetPrice = necklinePrice - (boxHigh - necklinePrice);
  const pv = (index: number, price: number, type: 'high' | 'low'): Pivot => ({ index, price, type });
  return {
    patternType: 'one-line-top',
    necklinePrice,
    patternTargetPrice,
    structureBrokenPrice: necklinePrice,
    pivots: [pv(boxHighIdx, boxHigh, 'high'), pv(supportIdx, necklinePrice, 'low')],
  };
}
