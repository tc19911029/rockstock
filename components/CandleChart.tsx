'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  Time,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  ISeriesMarkersPluginApi,
  SeriesMarker,
} from 'lightweight-charts';
import { CandleWithIndicators, RuleSignal, ChartSignalMarker } from '@/types';

import { getBullBearColors } from '@/lib/chart/colors';
import {
  getCompactSignalMarkerLabel,
  isAggregateSignalMarker,
  shouldHideAggregateSignalLabels,
} from '@/lib/chart/markerDisplay';
import {
  getPatternDisplayName,
  getPivotMarkerLabel,
  getPivotLabels,
  resolvePatternPivotSnapshots,
} from '@/lib/chart/patternDisplay';
import {
  getPatternConfirmationPrice,
  getPatternLifecycleStatus,
  type PatternLifecycleStatus,
} from '@/lib/chart/patternLifecycle';
import { choosePatternCandidate } from '@/lib/chart/patternSelection';
import type { PatternPivotSnapshot } from '@/lib/analysis/patternCatalog';
import {
  isCrossMarketObservationOnly,
  isLegacyBookObservationOnly,
} from '@/lib/analysis/patternCatalog';
import { findPivots, type Pivot } from '@/lib/analysis/trendAnalysis';
import {
  detectLetterN,
  detectLetterNStructure,
  detectTopPatternsStructure,
  getPatternFormationBoundaryPrice,
  BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE,
  TOP_PATTERN_DISPLAY_MIN_QUALITY_SCORE,
} from '@/lib/analysis/v12LetterN';
import { N_MIN_HISTORY } from '@/lib/analysis/historyMinimums';
import { assessLockedPatternReplay } from '@/lib/scanner/lockedPatternSelection';
import type { MarketId } from '@/lib/scanner/types';
import { candleSRLevels, isLongRedCandle, isLongBlackCandle } from '@/lib/rules/ruleUtils';
import {
  getCandleRangeLabels,
  getPatternDirectionLabels,
  getPatternLevelVisibility,
  getTargetDistanceText,
  selectActionableSupportResistanceLevels,
  shouldShowPatternGeometry,
} from '@/lib/chart/overlayPresentation';

const MA_COLORS = {
  ma5:   '#facc15', // 黃
  ma10:  '#3b82f6', // 藍
  ma20:  '#a855f7', // 紫
  ma60:  '#e2e8f0', // 白
  ma120: '#22d3ee', // 青（半年線）
  ma240: '#f97316', // 橘（年線）
};

/** Convert date string to lightweight-charts Time.
 *  Daily: 'YYYY-MM-DD' → string Time (business day)
 *  Intraday: 'YYYY-MM-DD HH:mm' → UTCTimestamp (seconds)
 *  注意：用 'Z' 假裝 CST 時間是 UTC，讓 TradingView X軸直接顯示正確的亞洲時間 */
function toTime(date: string): Time {
  if (date.includes(' ')) {
    const d = new Date(date.replace(' ', 'T') + ':00Z');
    return Math.floor(d.getTime() / 1000) as unknown as Time;
  }
  // 清除 TWSE 除權息日標記（如 "2025-11-17*" → "2025-11-17"）
  return date.replace(/\*$/, '') as Time;
}

/** 指數移動平均（seeded：out[0]=vals[0]），供楊氏EMA濾網疊圖用 */
function computeEMA(vals: number[], n: number): number[] {
  const k = 2 / (n + 1); const out: number[] = []; let prev = NaN;
  for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// 楊氏濾網移動停利參數（可調）：獲利到 +10% 才啟動，之後從「最高獲利」回落 15 個百分點就出。
// 15 檔持股 30分K 回測（2026-07）：15pp 最鬆版整體最賺（+36.2%），5pp 太緊最差（+27.6%）→ 改鬆。
const YANG_TRAIL_ARM = 0.10;      // 啟動門檻：最高賺過 10%
const YANG_TRAIL_GIVEBACK = 0.15; // 回落幅度：從最高獲利掉 15 個百分點（減法，非最大漲幅的百分比）

/**
 * 楊雲翔特殊EMA濾網買賣訊號（收盤確認，標在觸發那根 K 棒）：
 *   進場▲＝站上 EMA60（大方向偏多）＋（單根收盤 ≥ EMA23×1.03 或 連兩根 ≥ EMA23×1.01）
 *   出場▼＝三層擇一先到：移動停利(獲利鎖利) / 收破 EMA60(大方向轉壞) / 跌破 EMA23 濾網(時機轉壞)
 * 純視覺標記，非回測 fill；進出以「收盤」為準。
 */
function computeYangMarkers(candles: CandleWithIndicators[]): SeriesMarker<Time>[] {
  if (candles.length < 24) return [];
  const closes = candles.map(c => c.close);
  const e23 = computeEMA(closes, 23);
  const e60 = computeEMA(closes, 60);
  const out: SeriesMarker<Time>[] = [];
  let inPos = false, entry = 0, peakGain = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i - 1];
    if (!inPos) {
      const above60 = c.close >= e60[i];
      const f3 = c.close >= e23[i] * 1.03;
      const f1x2 = c.close >= e23[i] * 1.01 && pc.close >= e23[i - 1] * 1.01;
      if (above60 && (f3 || f1x2)) {
        inPos = true; entry = c.close; peakGain = 0;
        out.push({ time: toTime(c.date), position: 'belowBar', shape: 'arrowUp', color: '#22c55e', text: '楊買', size: 2 });
      }
    } else {
      peakGain = Math.max(peakGain, (c.high - entry) / entry);
      const gain = (c.close - entry) / entry;
      const trail = peakGain >= YANG_TRAIL_ARM && gain <= peakGain - YANG_TRAIL_GIVEBACK;
      const brk60 = c.close < e60[i];
      const brk3 = c.close <= e23[i] * 0.97;
      const brk1x2 = c.close <= e23[i] * 0.99 && pc.close <= e23[i - 1] * 0.99;
      let reason = '';
      if (trail) reason = '移利';           // 移動停利（鎖利出）
      else if (brk60) reason = '破60';       // 大方向轉壞
      else if (brk3 || brk1x2) reason = '停損'; // 時機轉壞
      if (reason) {
        inPos = false;
        out.push({ time: toTime(c.date), position: 'aboveBar', shape: 'arrowDown', color: reason === '移利' ? '#3b82f6' : '#ef4444', text: '楊' + reason, size: 2 });
      }
    }
  }
  return out;
}

// ── Chart sync — imported from store, re-exported for backwards compatibility ─
import {
  broadcastRange,
  broadcastCrosshairTime,
  subscribeRangeSync,
  subscribeCrosshairSync,
  getLastRange,
} from '@/store/chartSyncStore';
import type { LogicalRange, RangeSyncCallback } from '@/store/chartSyncStore';

export {
  broadcastRange,
  broadcastCrosshairTime,
  subscribeRangeSync,
  subscribeCrosshairSync,
  getLastRange,
};
export type { LogicalRange, RangeSyncCallback };

// ── Signal marker config ───────────────────────────────────────────────────────
function getMarkerConfig(): Record<ChartSignalMarker['type'], {
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown';
  color: string;
}> {
  const { bull, bear } = getBullBearColors();
  return {
    BUY:    { position: 'belowBar', shape: 'arrowUp',   color: bull },
    ADD:    { position: 'belowBar', shape: 'arrowUp',   color: '#f97316' },
    REDUCE: { position: 'aboveBar', shape: 'arrowDown', color: '#14b8a6' },
    SELL:   { position: 'aboveBar', shape: 'arrowDown', color: bear },
    WATCH:  { position: 'aboveBar', shape: 'arrowDown', color: '#eab308' },
  };
}

interface CandleChartProps {
  candles: CandleWithIndicators[];
  signals: RuleSignal[];
  chartMarkers?: ChartSignalMarker[];
  avgCost?: number;
  stopLossPrice?: number;
  onCrosshairMove?: (candle: CandleWithIndicators | null) => void;
  onDoubleClick?: (candle: CandleWithIndicators) => void;
  height?: number;
  fillContainer?: boolean;
  maToggles?: { ma5: boolean; ma10: boolean; ma20: boolean; ma60: boolean; ma120: boolean; ma240: boolean };
  showBollinger?: boolean;
  /** 楊雲翔特殊EMA濾網疊圖：EMA23 ＋ ±1%/±3% 濾網帶 ＋ EMA60 大方向線（純視覺，不發訊號） */
  showYangEma?: boolean;
  /** 顯示書本 p.37/p.38 切線（下降切線+上升切線），預設開 */
  showTrendlines?: boolean;
  /** 顯示上升切線（底底高），獨立 toggle；若 undefined 則跟 showTrendlines */
  showAscendingTrendline?: boolean;
  /** 顯示下降切線（頭頭低），獨立 toggle；若 undefined 則跟 showTrendlines */
  showDescendingTrendline?: boolean;
  /** 顯示上升軌道線（與上升切線平行，穿過兩底之間的最高點），預設關 */
  showAscendingChannel?: boolean;
  /** 顯示下跌軌道線（與下降切線平行，穿過兩頭之間的最低點），預設關 */
  showDescendingChannel?: boolean;
  /** 顯示盤整切線（上頸線+下頸線同時畫，《抓住飆股》p.205-208），預設關 */
  showConsolidationLines?: boolean;
  /** 顯示 MA5 分段頭底標記（寶典 p.21-22），預設關 */
  showPivots?: boolean;
  /** 顯示現價上下最近有效壓撐與大量價，預設關 */
  showSupportResistance?: boolean;
  /**
   * 顯示最近一根長紅/長黑 K 的高、1/2、低三價位，使用中性名稱，純顯示、不接 gate。
   */
  showCandleSR?: boolean;
  /** 顯示型態生命週期當下有用的頸線、確認、目標或失效價，預設關 */
  showNeckline?: boolean;
  /** 顯示形態關鍵點（ABCDE / L1L2L3 + H1H2 等）與連線，預設關 */
  showPattern?: boolean;
  /** 高亮指定日期的 K 棒（黃色菱形標記） */
  highlightDate?: string;
  /** 將指定日期的 K 棒捲動至畫面中央 */
  centerOnDate?: string;
  /**
   * 鎖股觀察記錄（若有）— chart 偵測 vs 鎖股紀錄不一致時優先用鎖股
   * 解 0512 bug：5/5 鎖圓弧底 5/6 chart 卻偵測成頭肩底（pivot 重組）→ 用戶覺得型態跳動怪怪
   */
  lockedPattern?: {
    symbol?: string;
    market?: MarketId;
    patternType: string;
    necklinePrice: number;
    targetPrice: number;
    stopPrice?: number;
    achievementRate?: number;
    kind: 'bottom' | 'top';
    pivots?: PatternPivotSnapshot[];
    triggeredDate?: string;
  } | null;
  /**
   * 雙B戰法主圖疊加（三色資金，陸股自創）— 像 MA/BB 一樣疊在 K 線主圖上。
   * 傳 null（或 undefined）= 不畫；4 條價格線 + 黃紅雙線金叉死叉/突破跌破買賣點。
   */
  shuangB?: {
    zhineng: { time: string; value: number }[];
    zb4: { time: string; value: number }[];
    zb5: { time: string; value: number }[];
    duokong: { time: string; value: number }[];
    markers: { time: string; position: 'aboveBar' | 'belowBar'; shape: 'arrowUp' | 'arrowDown' | 'circle'; color: string; text: string; size?: number }[];
  } | null;
  /**
   * ABC 突破偵測器選用的腳位疊加（除錯/驗證用，2026-05-30）— 把 detectABCBreakout 實際選的
   * A峰/A底/B峰/C底 marker + 它自己的下降切線畫到走圖。與通用綠色下降切線是兩回事：這條是
   * 「偵測器判斷依據」本身，腳位若抓錯會明顯畫錯位置 → 肉眼即可驗證。傳 null = 不畫。
   */
  abcOverlay?: {
    markers: { time: string; label: string; position: 'aboveBar' | 'belowBar' }[];
    trendline: { time: string; value: number }[];
    broke: boolean;   // 今日收盤是否突破切線（決定切線顏色）
  } | null;
  /**
   * 大戶持股趨勢線（TDCC 千張大戶持股%）— 淡淡一條疊在主圖上，用自己的隱形價格軸（holderPct），
   * 不壓壞 K 線價格刻度。純「格局強弱」參考、不發訊號（回測證實沒有預測力，2026-06-14）。
   * 傳 null = 不畫。值已 forward-fill 對齊到 K 棒日期。
   */
  holderLine?: { time: string; value: number }[] | null;
  /** 大戶持股線的級距標籤（依股價自動挑：千張/400張/百張大戶），預設「千張大戶」 */
  holderLineLabel?: string;
  /**
   * 顯示均線「移動扣抵」三角標 — 在每條均線「下一根要丟掉」的那根 K 棒下方畫一個同色 ▲
   * （MA5＝往左數第 5 根、MA10＝第 10 根、MA20＝第 20 根…扣抵棒索引 = 最新一根 − N + 1）。
   * 今收高於該三角指的那根收盤 → 均線下一步往上。算法同 lib/analysis/maDeduction。
   * 三角跟著各 MA 的顯示/隱藏連動（關掉 MA10 → 它的三角也消失）。預設開。
   */
  showMaDeduction?: boolean;
}

export default function CandleChart({
  candles, signals, chartMarkers = [], avgCost, stopLossPrice, onCrosshairMove, onDoubleClick, height = 400, fillContainer = false,
  maToggles = { ma5: true, ma10: true, ma20: true, ma60: true, ma120: false, ma240: false },
  showBollinger = false,
  showYangEma = false,
  showTrendlines = true,
  showAscendingTrendline,
  showDescendingTrendline,
  showAscendingChannel = false,
  showDescendingChannel = false,
  showConsolidationLines = false,
  showPivots = false,
  showSupportResistance = false,
  showCandleSR = false,
  showNeckline = false,
  showPattern = false,
  highlightDate,
  centerOnDate,
  lockedPattern,
  shuangB = null,
  abcOverlay = null,
  holderLine = null,
  holderLineLabel = '千張大戶',
  showMaDeduction = true,
}: CandleChartProps) {
  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const candleRef      = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const maRefs         = useRef<Record<string, ISeriesApi<'Line'>>>({});
  const bbRefs         = useRef<{ upper?: ISeriesApi<'Line'>; lower?: ISeriesApi<'Line'> }>({});
  const trendlineRefs  = useRef<{ descending?: ISeriesApi<'Line'>; ascending?: ISeriesApi<'Line'> }>({});
  const channelRefs    = useRef<{ descending?: ISeriesApi<'Line'>; ascending?: ISeriesApi<'Line'> }>({});
  const consolidationRefs = useRef<{ upper?: ISeriesApi<'Line'>; lower?: ISeriesApi<'Line'> }>({});
  const markersPlugRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const avgCostLineRef   = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const stopLossLineRef  = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']> | null>(null);
  const srLineRefs       = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([]);
  // K 棒三層支撐/壓力標線（最近一根長紅/長黑的最高/1半/最低）
  const candleSRLineRefs = useRef<ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]>([]);
  // 形態 toggle 用 LineSeries（支援水平+斜線；descending-wedge 頸線是斜的）
  const necklineRef       = useRef<ISeriesApi<'Line'> | null>(null);
  const confirmationRef   = useRef<ISeriesApi<'Line'> | null>(null);
  const targetRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const stopRef           = useRef<ISeriesApi<'Line'> | null>(null);
  const patternConnectorRef = useRef<ISeriesApi<'Line'> | null>(null);
  // 雙B戰法主圖疊加（三色資金）：智能交易線/ZB4/ZB5/多空線
  const shuangBRefs       = useRef<{ zhineng?: ISeriesApi<'Line'>; zb4?: ISeriesApi<'Line'>; zb5?: ISeriesApi<'Line'>; duokong?: ISeriesApi<'Line'> }>({});
  // 楊氏EMA濾網疊圖：EMA23 + ±1%/±3% 帶 + EMA60
  const yangEmaRefs       = useRef<{ ema23?: ISeriesApi<'Line'>; up1?: ISeriesApi<'Line'>; up3?: ISeriesApi<'Line'>; dn1?: ISeriesApi<'Line'>; dn3?: ISeriesApi<'Line'>; ema60?: ISeriesApi<'Line'> }>({});
  // ABC 偵測器腳位切線（除錯/驗證疊加）
  const abcTrendlineRef   = useRef<ISeriesApi<'Line'> | null>(null);
  // 大戶持股趨勢線（千張大戶%，自己的隱形價格軸）
  const holderLineRef     = useRef<ISeriesApi<'Line'> | null>(null);
  // Keep latest candles accessible inside event closures without re-subscribing
  const candlesRef     = useRef<CandleWithIndicators[]>(candles);
  const previousCandleRangeRef = useRef<{ first: string; last: string; length: number } | null>(null);
  const timeMapRef     = useRef<Map<string | number, CandleWithIndicators>>(new Map());
  // 記住上次「自動套用可視範圍」的視窗身分 — 只有換股/換週期/換中心日才重置，
  // 盤中輪詢換新 candles reference 不重置（否則使用者拖動的視窗每 ~30s 被打回原樣）
  const lastFitKeyRef  = useRef<string | null>(null);
  const onCrosshairRef = useRef(onCrosshairMove);
  const onDoubleClickRef = useRef(onDoubleClick);
  const [hoverCandle, setHoverCandle] = useState<CandleWithIndicators | null>(null);
  // 分鐘K 首次渲染 pane 常卡住不 composite（資料其實都在 series）；任何一次「重跑資料
  // effect（重設 series + 重新 fit 視窗）」就會畫出來（等同手動切指標/盤中輪詢那一拍）。
  // → 分鐘K 載入後主動 bump 一次 paintNonce（進 data effect deps + fitKey），逼它重畫。
  const [paintNonce, setPaintNonce] = useState(0);
  useEffect(() => {
    if (candles.length === 0 || !candles[0]?.date?.includes(' ')) return;
    const t = setTimeout(() => setPaintNonce(n => n + 1), 200);
    return () => clearTimeout(t);
  }, [candles]);
  // 均線移動扣抵三角標（貼在圖最底下一排，x 對齊各 MA「下一根要丟掉」的那根 K 棒）
  const [deductMarks, setDeductMarks] = useState<Array<{ key: keyof typeof MA_COLORS; n: number; color: string; x: number }>>([]);
  const [trendlineStatus, setTrendlineStatus] = useState<{
    ascending: { anchorIndex: number; anchorPrice: number; slope: number } | null;
    descending: { anchorIndex: number; anchorPrice: number; slope: number } | null;
  }>({ ascending: null, descending: null });
  const [channelStatus, setChannelStatus] = useState<{
    ascending: { anchorIndex: number; anchorPrice: number; slope: number } | null;
    descending: { anchorIndex: number; anchorPrice: number; slope: number } | null;
  }>({ ascending: null, descending: null });
  const [consolidationStatus, setConsolidationStatus] = useState<{
    upper: { anchorIndex: number; anchorPrice: number; slope: number } | null;
    lower: { anchorIndex: number; anchorPrice: number; slope: number } | null;
  }>({ upper: null, lower: null });

  useEffect(() => {
    candlesRef.current = candles;
    const map = new Map<string | number, CandleWithIndicators>();
    for (const c of candles) map.set(toTime(c.date) as string | number, c);
    timeMapRef.current = map;
  }, [candles]);
  useEffect(() => { onCrosshairRef.current = onCrosshairMove; }, [onCrosshairMove]);
  useEffect(() => { onDoubleClickRef.current = onDoubleClick; }, [onDoubleClick]);

  // ── 形態結構偵測（最新 K 棒，跳過紅K/量比 gate；toggle 開啟時用） ──
  // 優先順序：通過新版觸發日回放的 lockedPattern > fresh detection。
  //   解 0512 bug：5/5 鎖圓弧底（目標 320）5/6 chart detector 卻偵測成頭肩底（目標 261）
  //   → 兩個資料源不一致，用戶看到型態跳動 + 目標縮水
  // 修正前 detector 留下的舊鎖定不能永遠壓過新版結果；歷史紀錄仍保留，但顯示前要重驗。
  const lockedPatternReplay = useMemo(() => {
    if (!lockedPattern) return null;
    if (!lockedPattern.triggeredDate || lockedPattern.kind !== 'bottom') {
      return { status: 'unavailable', reason: 'missing-replay-data' } as const;
    }
    const triggerIndex = candles.findIndex(
      candle => candle.date.replace(/\*$/, '') === lockedPattern.triggeredDate,
    );
    // 圖表資料若沒有涵蓋原觸發日，或觸發日前歷史不足，不能把「無法重驗」誤判成失效。
    if (triggerIndex < N_MIN_HISTORY) {
      return { status: 'unavailable', reason: 'missing-replay-data' } as const;
    }
    const replayCandles = candles.slice(0, triggerIndex + 1);
    const replay = detectLetterN(
      replayCandles,
      triggerIndex,
      lockedPattern.market ?? 'TW',
      lockedPattern.symbol ?? '',
    );
    return assessLockedPatternReplay({
      patternType: lockedPattern.patternType,
      triggerPrice: lockedPattern.necklinePrice,
      patternTargetPrice: lockedPattern.targetPrice,
    }, replay);
  }, [candles, lockedPattern]);

  const activePattern = useMemo<{
    kind: 'bottom' | 'top';
    pivots: Pivot[];
    necklinePrice: number;
    targetPrice: number;
    stopPrice: number;
    patternType: string;
    achievementRate?: number;
    qualityScore?: number;
    qualityReasons?: string[];
    triggeredDate?: string;
    isLocked?: boolean;  // 來自鎖股觀察的旗標
    /** 鎖定型態與即時 detector 型態一致時才允許畫腳位，避免用另一種型態的 pivots 冒充。 */
    pivotsVerified: boolean;
  } | null>(() => {
    if (!showNeckline && !showPattern) return null;
    if (candles.length < 30) return null;
    const lastIdx = candles.length - 1;
    const bottom = detectLetterNStructure(candles, lastIdx, BOTTOM_PATTERN_DISPLAY_MIN_QUALITY_SCORE);
    const top = detectTopPatternsStructure(candles, lastIdx, TOP_PATTERN_DISPLAY_MIN_QUALITY_SCORE);

    const bottomCandidate = bottom.displayReady && bottom.pivots && bottom.necklinePrice != null && bottom.patternTargetPrice != null && bottom.structureBrokenPrice != null
      ? {
        kind: 'bottom',
        pivots: bottom.pivots,
        necklinePrice: bottom.necklinePrice,
        targetPrice: bottom.patternTargetPrice,
        stopPrice: bottom.structureBrokenPrice,
        patternType: bottom.patternType ?? '',
        achievementRate: bottom.achievementRate,
        qualityScore: bottom.qualityScore,
        qualityReasons: bottom.qualityReasons,
        pivotsVerified: true,
      } as const
      : null;
    const topCandidate = top.displayReady && top.pivots && top.necklinePrice != null && top.patternTargetPrice != null && top.structureBrokenPrice != null
      ? {
        kind: 'top',
        pivots: top.pivots,
        necklinePrice: top.necklinePrice,
        targetPrice: top.patternTargetPrice,
        stopPrice: top.structureBrokenPrice,
        patternType: top.patternType ?? '',
        achievementRate: top.achievementRate,
        qualityScore: top.qualityScore,
        qualityReasons: top.qualityReasons,
        pivotsVerified: true,
      } as const
      : null;

    // 可回放的紀錄必須通過新版 detector；無法回放的舊資料暫時保留相容性。
    if (
      lockedPattern &&
      lockedPatternReplay?.status !== 'rejected' &&
      Number.isFinite(lockedPattern.necklinePrice) && lockedPattern.necklinePrice > 0 &&
      Number.isFinite(lockedPattern.targetPrice) && lockedPattern.targetPrice > 0
    ) {
      const freshSource = lockedPattern.kind === 'bottom' ? bottom : top;
      const frozenPivots = resolvePatternPivotSnapshots(
        lockedPattern.pivots,
        candles.map(candle => candle.date),
      );
      const frozenPivotsComplete =
        lockedPattern.pivots != null &&
        lockedPattern.pivots.length > 0 &&
        frozenPivots.length === lockedPattern.pivots.length;
      const freshNecklineAligned =
        freshSource.necklinePrice != null &&
        Math.abs(freshSource.necklinePrice - lockedPattern.necklinePrice) /
          Math.max(Math.abs(lockedPattern.necklinePrice), Number.EPSILON) <= 0.03;
      // 新紀錄優先用觸發日凍結腳位。舊紀錄沒有快照時，必須同型且頸線落在 3% 內才可借用；
      // 只比 patternType 仍可能把另一個同名型態的頭底冒充成原鎖定腳位。
      const freshPivotsVerified =
        freshSource.patternType === lockedPattern.patternType && freshNecklineAligned;
      const pivotsVerified = frozenPivotsComplete || freshPivotsVerified;
      return {
        kind: lockedPattern.kind,
        // 型態不同時寧可不畫腳位，也不能把頭肩底的腳標成圓弧底等錯誤型態。
        pivots: frozenPivotsComplete
          ? frozenPivots
          : freshPivotsVerified
            ? (freshSource.pivots ?? [])
            : [],
        necklinePrice: lockedPattern.necklinePrice,
        targetPrice: lockedPattern.targetPrice,
        stopPrice: lockedPattern.stopPrice ?? lockedPattern.necklinePrice * (lockedPattern.kind === 'bottom' ? 0.97 : 1.03),
        patternType: lockedPattern.patternType,
        achievementRate: lockedPattern.achievementRate ?? (freshPivotsVerified ? freshSource.achievementRate : undefined),
        // 凍結腳位只證明鎖定型態可畫，不代表目前 top-ranked detector 是同一型態；
        // 分數與理由只有同型、頸線也對齊時才能借用，避免圓弧底旁顯示 N 字「回檔比例」。
        qualityScore: freshPivotsVerified ? freshSource.qualityScore : undefined,
        qualityReasons: freshPivotsVerified ? freshSource.qualityReasons : undefined,
        triggeredDate: lockedPattern.triggeredDate,
        isLocked: true,
        pivotsVerified,
      };
    }

    return choosePatternCandidate(bottomCandidate, topCandidate);
  }, [candles, showNeckline, showPattern, lockedPattern, lockedPatternReplay]);

  /**
   * 型態狀態必須遵守生命週期：形成 → 真突破／跌破 → 回測／失效。
   * 尚未曾通過 3% 確認門檻時，不得啟用目標價與突破後防守價。
   */
  const patternStatus = useMemo<PatternLifecycleStatus | null>(() => {
    if (!activePattern || candles.length === 0) return null;
    const last = candles[candles.length - 1];
    const formationIndex = activePattern.pivots.length > 0
      ? Math.max(...activePattern.pivots.map(pivot => pivot.index))
      : 0;
    const triggeredIndex = activePattern.isLocked && activePattern.triggeredDate
      ? candles.findIndex(candle => candle.date.replace(/\*$/, '') >= activePattern.triggeredDate!)
      : -1;
    const lifecycleStartIndex = triggeredIndex >= 0 ? triggeredIndex : formationIndex;
    const formationBoundaryPrice = getPatternFormationBoundaryPrice(
      activePattern.patternType,
      activePattern.pivots,
      activePattern.kind,
    );
    return getPatternLifecycleStatus({
      kind: activePattern.kind,
      currentClose: last.close,
      necklinePrice: activePattern.necklinePrice,
      targetPrice: activePattern.targetPrice,
      stopPrice: activePattern.stopPrice,
      candlesSinceFormation: candles.slice(lifecycleStartIndex).map(candle => ({
        close: candle.close,
        high: candle.high,
        low: candle.low,
      })),
      formationBoundaryPrice,
      assumeConfirmed: activePattern.isLocked,
    });
  }, [activePattern, candles]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const chartHeight = (fillContainer
      ? node.clientHeight
      : height) || 400;

    const chart = createChart(node, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#94a3b8',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: { mode: 1, vertLine: { labelVisible: false } },
      rightPriceScale: { borderColor: '#334155', minimumWidth: 80 },
      timeScale: { borderColor: '#334155', timeVisible: true, rightOffset: 15 },
      width: node.clientWidth,
      height: chartHeight,
    });

    const { bull, bear } = getBullBearColors();
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: bull, downColor: bear,
      borderUpColor: bull, borderDownColor: bear,
      wickUpColor: bull, wickDownColor: bear,
    });

    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60', 'ma120', 'ma240'] as const;
    const newMARef: Record<string, ISeriesApi<'Line'>> = {};
    for (const key of maKeys) {
      newMARef[key] = chart.addSeries(LineSeries, {
        color: MA_COLORS[key], lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerRadius: 2,
      });
    }

    // ── Bollinger Bands ──
    bbRefs.current.upper = chart.addSeries(LineSeries, {
      color: 'rgba(34, 197, 94, 0.5)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,
    });
    bbRefs.current.lower = chart.addSeries(LineSeries, {
      color: 'rgba(34, 197, 94, 0.5)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,
    });

    // ── 切線（書本 p.37/p.38 警示用，不做進出場） ──
    // 單一實線從 fromIndex 延伸到今日+未來 15 個營業日
    trendlineRefs.current.descending = chart.addSeries(LineSeries, {
      color: '#10b981',  // 綠：下降切線（連頭頭低）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 0,
    });
    trendlineRefs.current.ascending = chart.addSeries(LineSeries, {
      color: '#ef4444',   // 紅：上升切線（連底底高）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 0,
    });

    // ── 軌道線（書本《抓住飆股》p.205-208，與切線平行）──
    channelRefs.current.descending = chart.addSeries(LineSeries, {
      color: '#10b981',  // 綠：下跌軌道線（與下降切線平行，在股價下方）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,  // 虛線：與切線區分
    });
    channelRefs.current.ascending = chart.addSeries(LineSeries, {
      color: '#ef4444',  // 紅：上升軌道線（與上升切線平行，在股價上方）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,
    });

    // ── 盤整切線（書本《抓住飆股》p.205-208；寶典 Part 5 切線篇 p.352-369）──
    // 上頸線 + 下頸線同時畫，用 amber 點線區分既有切線/軌道線/形態頸線
    consolidationRefs.current.upper = chart.addSeries(LineSeries, {
      color: '#f59e0b',  // amber：盤整上頸線
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 1,  // 點線
    });
    consolidationRefs.current.lower = chart.addSeries(LineSeries, {
      color: '#f59e0b',  // amber：盤整下頸線
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 1,
    });

    // ── 型態頸線 / 真突破 / 突破後目標 / 回測防守 / 型態連線（toggle 控制） ──
    necklineRef.current = chart.addSeries(LineSeries, {
      color: '#22d3ee',   // 青：頸線（實線）
      lineWidth: 2, priceLineVisible: false, lastValueVisible: true, lineStyle: 0,
      title: '結構頸線',
    });
    confirmationRef.current = chart.addSeries(LineSeries, {
      color: '#67e8f9',   // 淺青：頸線 ±3% 真突破門檻（點線）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: true, lineStyle: 1,
      title: '確認價',
    });
    targetRef.current = chart.addSeries(LineSeries, {
      color: '#86efac',   // 淡綠：目標價（虛線）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: true, lineStyle: 2,
      title: '測量目標',
    });
    stopRef.current = chart.addSeries(LineSeries, {
      color: '#fdba74',   // 淡橘：突破後回測防守（虛線）
      lineWidth: 1, priceLineVisible: false, lastValueVisible: true, lineStyle: 2,
      title: '型態失效',
    });
    patternConnectorRef.current = chart.addSeries(LineSeries, {
      color: '#e879f9',   // 紫桃：形態連線
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 0,
    });

    // ── 雙B戰法主圖疊加（三色資金）：智能交易線(青粗)/ZB4(黃)/ZB5(紅)/多空線(黃點線) ──
    shuangBRefs.current.zhineng = chart.addSeries(LineSeries, {
      color: '#22D3EE', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    shuangBRefs.current.zb4 = chart.addSeries(LineSeries, {
      color: '#FFD000', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    shuangBRefs.current.zb5 = chart.addSeries(LineSeries, {
      color: '#FF433D', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    shuangBRefs.current.duokong = chart.addSeries(LineSeries, {
      color: '#FFD000', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, lineStyle: 2,
    });

    // ── 楊雲翔特殊EMA濾網疊主圖：EMA60 大方向(藍虛線) + ±3%/±1% 濾網帶(紅上/綠下) + EMA23(琥珀) ──
    // 加入順序 = 由下往上疊，EMA23 最後加 → 畫在最上層。全部預設隱藏，由 showYangEma effect 控制。
    // crosshairMarkerVisible:false → hover 時不畫圓點（6 條擠一起會擋 K 棒；數值已在左上圖例）
    yangEmaRefs.current.ema60 = chart.addSeries(LineSeries, { color: '#3B82F6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false, crosshairMarkerVisible: false });
    yangEmaRefs.current.up3 = chart.addSeries(LineSeries, { color: 'rgba(239,68,68,0.85)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false, crosshairMarkerVisible: false });
    yangEmaRefs.current.up1 = chart.addSeries(LineSeries, { color: 'rgba(239,68,68,0.6)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, visible: false, crosshairMarkerVisible: false });
    yangEmaRefs.current.dn1 = chart.addSeries(LineSeries, { color: 'rgba(34,197,94,0.6)', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, visible: false, crosshairMarkerVisible: false });
    yangEmaRefs.current.dn3 = chart.addSeries(LineSeries, { color: 'rgba(34,197,94,0.85)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false, crosshairMarkerVisible: false });
    yangEmaRefs.current.ema23 = chart.addSeries(LineSeries, { color: '#F59E0B', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false, crosshairMarkerVisible: false });

    // ── ABC 偵測器腳位切線（除錯/驗證）：amber 粗線，與通用綠色下降切線區分 ──
    abcTrendlineRef.current = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, lineStyle: 0,
      title: 'ABC切線',
    });

    // ── 大戶持股趨勢線（千張大戶%）：淡粉細線，掛自己的隱形軸 holderPct，不動 K 線價格刻度 ──
    holderLineRef.current = chart.addSeries(LineSeries, {
      color: 'rgba(236, 72, 153, 0.5)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      priceScaleId: 'holderPct',
    });
    chart.priceScale('holderPct').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });

    chartRef.current  = chart;
    candleRef.current = candleSeries;
    maRefs.current    = newMARef;
    markersPlugRef.current = createSeriesMarkers(candleSeries, []);

    // 暴露 chart instance 給「問朱老師」截圖用（朱老師 session 是多模態，可以讀圖）
    (window as unknown as { __rockstockChart?: IChartApi }).__rockstockChart = chart;

    // ── 主圖廣播 logical range 給指標圖（bar-index 同步，對齊更精確） ──
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      broadcastRange(range as { from: number; to: number } | null);
    });

    // ── Crosshair → OHLCV display + broadcast to sub-charts ─────────────
    chart.subscribeCrosshairMove(param => {
      if (!param.time) {
        setHoverCandle(null);
        onCrosshairRef.current?.(null);
        broadcastCrosshairTime(null);
        return;
      }
      const found = timeMapRef.current.get(param.time as string | number) ?? null;
      broadcastCrosshairTime(found?.date ?? null);
      setHoverCandle(found);
      onCrosshairRef.current?.(found);
    });

    // ── Double-click → jump to candle ─────────────────────────────────
    let _lastHoverCandle: CandleWithIndicators | null = null;
    // Track hover candle for dblclick (crosshair already subscribed above,
    // so we piggyback via a second subscription using a local var)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dblClickCrosshairHandler = (param: any) => {
      if (param.time) {
        _lastHoverCandle = candlesRef.current.find(c => c.date === (param.time as string)) ?? null;
      } else {
        _lastHoverCandle = null;
      }
    };
    chart.subscribeCrosshairMove(dblClickCrosshairHandler);
    const handleDblClick = () => {
      if (onDoubleClickRef.current && _lastHoverCandle) {
        onDoubleClickRef.current(_lastHoverCandle);
      }
    };
    node.addEventListener('dblclick', handleDblClick);

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: node.clientWidth });
      if (fillContainer) chart.applyOptions({ height: node.clientHeight });
    });
    ro.observe(node);

    return () => {
      node.removeEventListener('dblclick', handleDblClick);
      chart.unsubscribeCrosshairMove(dblClickCrosshairHandler);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      delete (window as unknown as { __rockstockChart?: IChartApi }).__rockstockChart;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load candle / MA data ────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || candles.length === 0) return;

    const nextRange = {
      first: candles[0].date,
      last: candles[candles.length - 1].date,
      length: candles.length,
    };
    const previousRange = previousCandleRangeRef.current;
    const compactsTimeScale = previousRange != null && (
      nextRange.length < previousRange.length ||
      nextRange.first !== previousRange.first ||
      nextRange.last < previousRange.last
    );
    if (compactsTimeScale) {
      // lightweight-charts <= 5.2.0：縮短多序列資料時若仍 hover 舊 index，會拋 `Value is null`。
      chartRef.current?.clearCrosshairPosition();
      broadcastCrosshairTime(null);
      setHoverCandle(null);
      onCrosshairRef.current?.(null);
    }
    previousCandleRangeRef.current = nextRange;

    // 進場/訊號日那根 K 棒維持原本紅綠顏色；改在 K 棒下方加黃圓點標記（見下方 markers effect）
    candleRef.current.setData(candles.map(c => ({
      time: toTime(c.date), open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    /** 過濾 null/undefined/NaN（分鐘K MA 數據不足時會產生 NaN） */
    const validNum = (v: number | undefined | null): v is number =>
      v != null && Number.isFinite(v);
    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60', 'ma120', 'ma240'] as const;
    for (const key of maKeys) {
      maRefs.current[key]?.setData(
        candles.filter(c => validNum(c[key])).map(c => ({ time: toTime(c.date), value: c[key]! }))
      );
    }
    // Bollinger Bands
    bbRefs.current.upper?.setData(
      candles.filter(c => validNum(c.bbUpper)).map(c => ({ time: toTime(c.date), value: c.bbUpper! }))
    );
    bbRefs.current.lower?.setData(
      candles.filter(c => validNum(c.bbLower)).map(c => ({ time: toTime(c.date), value: c.bbLower! }))
    );

    // ── 切線（書本 p.37/p.38）+ 軌道線（《抓住飆股》p.205-208）+ 盤整切線（同 p.205）──
    // 實線從 fromIndex 延伸：往前 20 + 往後 20 交易日
    // 上升/下降線可獨立 toggle；fallback 用 showTrendlines 總開關相容舊用法
    // 軌道線：與對應切線平行，穿過兩 pivot 之間的最高點/最低點
    // 盤整切線：上頸線（連最近 2 個 high pivot）+ 下頸線（連最近 2 個 low pivot），同時畫
    const showAsc = showAscendingTrendline ?? showTrendlines;
    const showDesc = showDescendingTrendline ?? showTrendlines;
    const showAscCh = showAscendingChannel;
    const showDescCh = showDescendingChannel;
    const showCons = showConsolidationLines;
    let descInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    let ascInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    let descChInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    let ascChInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    let consUpperInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    let consLowerInfo: { anchorIndex: number; anchorPrice: number; slope: number } | null = null;
    if ((showAsc || showDesc || showAscCh || showDescCh || showCons) && candles.length >= 3) {
      const lastIdx = candles.length - 1;
      // UI 規則（非書本嚴格規則）：最近兩個頭連成下降線、最近兩個底連成上升線，不管高低大小
      // 切線只用已確認 pivot，進行中段的 provisional 不拿來畫線
      // 書本嚴格規則（頭頭低/底底高）仍用於 detectTrendlineBreakout 的警示訊號
      const pivots = findPivots(candles, lastIdx, 8);
      const recentHighs = pivots.filter(p => p.type === 'high').slice(0, 2);
      const recentLows = pivots.filter(p => p.type === 'low').slice(0, 2);
      // 線的延伸：第二近 pivot 往前 20 天 + 最近 pivot 往後 20 天
      const EDGE_PAD = 20;
      const lastDate = candles[lastIdx]?.date ?? '';
      const buildFutureDates = (count: number): string[] => {
        const fd: string[] = [];
        if (!lastDate || lastDate.includes(' ')) return fd;
        const d = new Date(lastDate + 'T00:00:00Z');
        let added = 0;
        while (added < count) {
          d.setUTCDate(d.getUTCDate() + 1);
          const dow = d.getUTCDay();
          if (dow === 0 || dow === 6) continue;
          fd.push(d.toISOString().slice(0, 10));
          added++;
        }
        return fd;
      };
      /** 從 startIdx 到 endIdx 畫線（以 anchorIndex/anchorPrice + slope 決定每點值） */
      const buildLine = (startIdx: number, endIdx: number, anchorIndex: number, anchorPrice: number, slope: number) => {
        const pts: { time: ReturnType<typeof toTime>; value: number }[] = [];
        const safeStart = Math.max(0, startIdx);
        // 在已存在的 K 棒範圍內畫
        for (let i = safeStart; i <= Math.min(endIdx, lastIdx); i++) {
          if (i < 0 || i >= candles.length) continue;
          pts.push({ time: toTime(candles[i].date), value: anchorPrice + slope * (i - anchorIndex) });
        }
        // 若 endIdx 超過今天，延伸到未來
        if (endIdx > lastIdx) {
          const futureCount = endIdx - lastIdx;
          const futureDates = buildFutureDates(futureCount);
          futureDates.forEach((fd, k) => {
            const futureIdx = lastIdx + 1 + k;
            pts.push({ time: toTime(fd), value: anchorPrice + slope * (futureIdx - anchorIndex) });
          });
        }
        return pts;
      };

      // 下降線：連最近兩個頭（findPivots 回傳 newest-first，highs[1]=older, highs[0]=newer）
      // 範圍：older - 10 天 ~ newer + 10 天
      let descSlope = 0;
      let descOlderIdx = -1;
      let descNewerIdx = -1;
      if (recentHighs.length === 2) {
        const older = recentHighs[1];
        const newer = recentHighs[0];
        descSlope = (newer.price - older.price) / (newer.index - older.index);
        descOlderIdx = older.index;
        descNewerIdx = newer.index;
        if (showDesc) {
          trendlineRefs.current.descending?.setData(
            buildLine(older.index - EDGE_PAD, newer.index + EDGE_PAD, older.index, older.price, descSlope)
          );
          descInfo = { anchorIndex: older.index, anchorPrice: older.price, slope: descSlope };
        } else {
          trendlineRefs.current.descending?.setData([]);
        }
      } else {
        trendlineRefs.current.descending?.setData([]);
      }
      // 上升線：連最近兩個底；範圍：older - 10 天 ~ newer + 10 天
      let ascSlope = 0;
      let ascOlderIdx = -1;
      let ascNewerIdx = -1;
      if (recentLows.length === 2) {
        const older = recentLows[1];
        const newer = recentLows[0];
        ascSlope = (newer.price - older.price) / (newer.index - older.index);
        ascOlderIdx = older.index;
        ascNewerIdx = newer.index;
        if (showAsc) {
          trendlineRefs.current.ascending?.setData(
            buildLine(older.index - EDGE_PAD, newer.index + EDGE_PAD, older.index, older.price, ascSlope)
          );
          ascInfo = { anchorIndex: older.index, anchorPrice: older.price, slope: ascSlope };
        } else {
          trendlineRefs.current.ascending?.setData([]);
        }
      } else {
        trendlineRefs.current.ascending?.setData([]);
      }

      // ── 軌道線：與切線平行，穿過兩 pivot 之間的最高點/最低點（《抓住飆股》p.205-208）──
      // 上升軌道線：在 ascOlderIdx ~ ascNewerIdx 之間找 candle.high 最大值當錨點，slope = ascSlope
      if (showAscCh && ascOlderIdx >= 0 && ascNewerIdx > ascOlderIdx) {
        let anchorIdx = ascOlderIdx;
        let anchorPrice = candles[ascOlderIdx]?.high ?? 0;
        for (let i = ascOlderIdx + 1; i < ascNewerIdx; i++) {
          if (candles[i]?.high != null && candles[i].high > anchorPrice) {
            anchorPrice = candles[i].high;
            anchorIdx = i;
          }
        }
        if (anchorIdx > ascOlderIdx) {  // 確實找到中間有更高點
          channelRefs.current.ascending?.setData(
            buildLine(ascOlderIdx - EDGE_PAD, ascNewerIdx + EDGE_PAD, anchorIdx, anchorPrice, ascSlope)
          );
          ascChInfo = { anchorIndex: anchorIdx, anchorPrice, slope: ascSlope };
        } else {
          channelRefs.current.ascending?.setData([]);
        }
      } else {
        channelRefs.current.ascending?.setData([]);
      }
      // 下跌軌道線：在 descOlderIdx ~ descNewerIdx 之間找 candle.low 最小值當錨點，slope = descSlope
      if (showDescCh && descOlderIdx >= 0 && descNewerIdx > descOlderIdx) {
        let anchorIdx = descOlderIdx;
        let anchorPrice = candles[descOlderIdx]?.low ?? Number.MAX_VALUE;
        for (let i = descOlderIdx + 1; i < descNewerIdx; i++) {
          if (candles[i]?.low != null && candles[i].low < anchorPrice) {
            anchorPrice = candles[i].low;
            anchorIdx = i;
          }
        }
        if (anchorIdx > descOlderIdx) {
          channelRefs.current.descending?.setData(
            buildLine(descOlderIdx - EDGE_PAD, descNewerIdx + EDGE_PAD, anchorIdx, anchorPrice, descSlope)
          );
          descChInfo = { anchorIndex: anchorIdx, anchorPrice, slope: descSlope };
        } else {
          channelRefs.current.descending?.setData([]);
        }
      } else {
        channelRefs.current.descending?.setData([]);
      }
      // ── 盤整切線：上頸線（連最近 2 個 high pivot）+ 下頸線（連最近 2 個 low pivot）──
      // 跟上升/下降切線使用同樣的 pivot 來源（recentHighs/recentLows），但獨立 toggle 控制
      // 視覺上用 amber 點線區分；使用者可單獨開盤整切線而不開上升/下降切線
      if (showCons && recentHighs.length === 2) {
        const olderH = recentHighs[1];
        const newerH = recentHighs[0];
        const slopeUpper = (newerH.price - olderH.price) / (newerH.index - olderH.index);
        consolidationRefs.current.upper?.setData(
          buildLine(olderH.index - EDGE_PAD, newerH.index + EDGE_PAD, olderH.index, olderH.price, slopeUpper)
        );
        consUpperInfo = { anchorIndex: olderH.index, anchorPrice: olderH.price, slope: slopeUpper };
      } else {
        consolidationRefs.current.upper?.setData([]);
      }
      if (showCons && recentLows.length === 2) {
        const olderL = recentLows[1];
        const newerL = recentLows[0];
        const slopeLower = (newerL.price - olderL.price) / (newerL.index - olderL.index);
        consolidationRefs.current.lower?.setData(
          buildLine(olderL.index - EDGE_PAD, newerL.index + EDGE_PAD, olderL.index, olderL.price, slopeLower)
        );
        consLowerInfo = { anchorIndex: olderL.index, anchorPrice: olderL.price, slope: slopeLower };
      } else {
        consolidationRefs.current.lower?.setData([]);
      }
    } else {
      trendlineRefs.current.descending?.setData([]);
      trendlineRefs.current.ascending?.setData([]);
      channelRefs.current.descending?.setData([]);
      channelRefs.current.ascending?.setData([]);
      consolidationRefs.current.upper?.setData([]);
      consolidationRefs.current.lower?.setData([]);
    }
    setTrendlineStatus({ ascending: ascInfo, descending: descInfo });
    setChannelStatus({ ascending: ascChInfo, descending: descChInfo });
    setConsolidationStatus({ upper: consUpperInfo, lower: consLowerInfo });
    // scrollToPosition 後稍等一個 tick 再廣播，確保 range 已更新
    const chart = chartRef.current;
    if (chart) {
      const totalBars = candles.length;
      // 日K 預設看最近 80 根（~4 個月，K 棒大小清晰）；分鐘K 若也只給 80 根＝才 ~4 天，
      // 均線沒背景、看起來又短又跳 → 分鐘K 改成預設看最近 ~15 個交易日（估每日根數 × 15）。
      const isIntradayBars = candles[0]?.date?.includes(' ') ?? false;
      let visibleBars = 80;
      if (isIntradayBars) {
        const days = new Set(candles.map(c => c.date.slice(0, 10))).size || 1;
        const perDay = candles.length / days;
        visibleBars = Math.min(Math.round(perDay * 15), candles.length - 1);
      }

      // 只有「換股 / 換週期 / 換中心日」才自動套用可視範圍；盤中輪詢只是換新 candles
      // reference（同檔同週期、只動最後一根），key 不變 → 不重置，保留使用者拖動的視窗。
      const fitKey = `${centerOnDate ?? ''}|${candles[0]?.date ?? ''}|${candles[1]?.date ?? ''}|${paintNonce}`;
      if (lastFitKeyRef.current !== fitKey) {
        lastFitKeyRef.current = fitKey;
        if (centerOnDate) {
          // 以指定日期為中心，前後各顯示 40 根
          let centerIdx = candles.findIndex(c => c.date === centerOnDate);
          if (centerIdx === -1) {
            // fallback: 找最近前一根
            for (let i = candles.length - 1; i >= 0; i--) {
              if (candles[i].date <= centerOnDate) { centerIdx = i; break; }
            }
          }
          if (centerIdx === -1) centerIdx = totalBars - 1;
          const half = Math.floor(visibleBars / 2);
          chart.timeScale().setVisibleLogicalRange({
            from: centerIdx - half,
            to:   centerIdx + half,
          });
        } else {
          // 預設顯示最近 80 根K棒（仿 WantGoo 6個月日線），讓K棒大小清晰
          chart.timeScale().setVisibleLogicalRange({
            from: totalBars - visibleBars - 1,
            to:   totalBars + 3,
          });
        }
        requestAnimationFrame(() => {
          const range = chart.timeScale().getVisibleLogicalRange();
          if (range) broadcastRange(range as { from: number; to: number });
        });
      }
    }
  }, [candles, centerOnDate, highlightDate, showTrendlines, showAscendingTrendline, showDescendingTrendline, showAscendingChannel, showDescendingChannel, showConsolidationLines, paintNonce]);

  // ── 雙B戰法主圖疊加：set/clear 四條線（markers 併入下方 markers effect）──
  useEffect(() => {
    const r = shuangBRefs.current;
    const toLine = (pts?: { time: string; value: number }[]) =>
      (pts ?? []).map(p => ({ time: toTime(p.time), value: p.value }));
    r.zhineng?.setData(shuangB ? toLine(shuangB.zhineng) : []);
    r.zb4?.setData(shuangB ? toLine(shuangB.zb4) : []);
    r.zb5?.setData(shuangB ? toLine(shuangB.zb5) : []);
    r.duokong?.setData(shuangB ? toLine(shuangB.duokong) : []);
  }, [shuangB]);

  // ── 大戶持股趨勢線：set/clear（值已對齊 K 棒日期）──
  useEffect(() => {
    holderLineRef.current?.setData(
      holderLine ? holderLine.map(p => ({ time: toTime(p.time), value: p.value })) : []
    );
  }, [holderLine]);

  // ── ABC 偵測器腳位切線：set/clear（markers 併入下方 markers effect）──
  useEffect(() => {
    const ref = abcTrendlineRef.current;
    if (!ref) return;
    if (abcOverlay && abcOverlay.trendline.length >= 2) {
      // 突破=amber 實線（命中）、未突破=灰色（候選但沒過）
      ref.applyOptions({ color: abcOverlay.broke ? '#f59e0b' : '#94a3b8' });
      ref.setData(abcOverlay.trendline.map(p => ({ time: toTime(p.time), value: p.value })));
    } else {
      ref.setData([]);
    }
  }, [abcOverlay]);

  // ── MA visibility toggle ─────────────────────────────────────────────────
  useEffect(() => {
    const maKeys = ['ma5', 'ma10', 'ma20', 'ma60', 'ma120', 'ma240'] as const;
    for (const key of maKeys) {
      const series = maRefs.current[key];
      if (series) {
        series.applyOptions({ visible: maToggles[key] });
      }
    }
  }, [maToggles]);

  // ── Bollinger Bands visibility ──
  useEffect(() => {
    bbRefs.current.upper?.applyOptions({ visible: showBollinger });
    bbRefs.current.lower?.applyOptions({ visible: showBollinger });
  }, [showBollinger]);

  // ── 楊氏EMA濾網：算 EMA23/EMA60 + ±1%/±3% 帶，set data + 顯示切換 ──
  useEffect(() => {
    const r = yangEmaRefs.current;
    const keys = ['ema23', 'up1', 'up3', 'dn1', 'dn3', 'ema60'] as const;
    if (!r.ema23) return;
    if (!showYangEma || candles.length === 0) {
      for (const k of keys) r[k]?.applyOptions({ visible: false });
      return;
    }
    const closes = candles.map(c => c.close);
    const e23 = computeEMA(closes, 23);
    const e60 = computeEMA(closes, 60);
    const mk = (arr: number[], mult: number) =>
      candles.reduce<{ time: Time; value: number }[]>((acc, c, i) => {
        if (Number.isFinite(arr[i])) acc.push({ time: toTime(c.date), value: arr[i] * mult });
        return acc;
      }, []);
    r.ema23!.setData(mk(e23, 1));
    r.up1!.setData(mk(e23, 1.01));
    r.up3!.setData(mk(e23, 1.03));
    r.dn1!.setData(mk(e23, 0.99));
    r.dn3!.setData(mk(e23, 0.97));
    r.ema60!.setData(mk(e60, 1));
    for (const k of keys) r[k]?.applyOptions({ visible: true });
  }, [candles, showYangEma]);

  // ── Avg cost price line ───────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current) return;
    if (avgCostLineRef.current) {
      try { candleRef.current.removePriceLine(avgCostLineRef.current); } catch {}
      avgCostLineRef.current = null;
    }
    if (avgCost && avgCost > 0) {
      avgCostLineRef.current = candleRef.current.createPriceLine({
        price: avgCost, color: '#fbbf24', lineWidth: 1,
        lineStyle: 2, axisLabelVisible: true, title: '均價',
      });
    }
  }, [avgCost]);

  // ── Stop-loss price line ──────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current) return;
    if (stopLossLineRef.current) {
      try { candleRef.current.removePriceLine(stopLossLineRef.current); } catch {}
      stopLossLineRef.current = null;
    }
    if (stopLossPrice && stopLossPrice > 0) {
      stopLossLineRef.current = candleRef.current.createPriceLine({
        price: stopLossPrice, color: '#f87171', lineWidth: 1,
        lineStyle: 1, axisLabelVisible: true, title: '停損',
      });
    }
  }, [stopLossPrice]);

  // ── Chart markers ─────────────────────────────────────────────────────────
  // 頭底標記共用同一批已確認 pivot；不顯示進行中的 provisional 轉折。
  const confirmedPivots = useMemo(
    () => showPivots && candles.length >= 20
      ? findPivots(candles, candles.length - 1, 30)
      : [],
    [showPivots, candles],
  );

  useEffect(() => {
    if (!markersPlugRef.current) return;
    const markerCfg = getMarkerConfig();
    // 主圖通常顯示最近約 120 根；密集時保留每個箭頭位置，但拿掉重複的「買×N／賣×N」文字。
    // 字母買法與特殊風險警示仍顯示原標籤，強共振則用較大的箭頭表達。
    const recentDates = new Set(candles.slice(-120).map(candle => candle.date.replace(/\*$/, '')));
    const recentMarkers = chartMarkers.filter(marker => recentDates.has(marker.date.replace(/\*$/, '')));
    const hideAggregateSignalLabels = shouldHideAggregateSignalLabels(recentMarkers);
    const converted: SeriesMarker<Time>[] = chartMarkers.map(m => {
      const cfg = markerCfg[m.type];
      return {
        time: toTime(m.date),
        position: cfg.position,
        shape: cfg.shape,
        color: cfg.color,
        text: hideAggregateSignalLabels && isAggregateSignalMarker(m)
          ? ''
          : getCompactSignalMarkerLabel(m),
        size: (m.strength ?? 0) >= 4 ? 2 : 1,
      };
    });
    // 訊號日改為整根 K 棒塗黃（見上方 candle setData），不再用黃點 + 文字標記
    // 加入頭底標記（寶典 p.21-22 MA5 分段轉折波，書本規則無振幅門檻）
    // 只顯示已確認 pivot（不含 provisional），進行中段不算頭/底
    if (showPivots && candles.length >= 20) {
      const patternPivotIndices = new Set(
        showPattern && activePattern && shouldShowPatternGeometry(patternStatus)
          ? activePattern.pivots.map(p => p.index)
          : [],
      );
      for (const p of confirmedPivots) {
        // 同一轉折已由型態腳位（如 H1/L1/頭/肩）標示時，不再疊一層「頭/底」。
        if (patternPivotIndices.has(p.index)) continue;
        const c = candles[p.index];
        if (!c) continue;
        converted.push({
          time: toTime(c.date),
          position: p.type === 'high' ? 'aboveBar' : 'belowBar',
          shape: p.type === 'high' ? 'arrowDown' : 'arrowUp',
          color: p.type === 'high' ? '#ec4899' : '#06b6d4',
          // 直接標示中文，不要求使用者記住顏色或箭頭方向。
          text: getPivotMarkerLabel(p),
          size: 1,
        });
      }
    }
    // 加入形態 ABCDE 關鍵點標籤（showPattern toggle）
    if (showPattern && activePattern && shouldShowPatternGeometry(patternStatus)) {
      const pivotLabels = getPivotLabels(activePattern.patternType, activePattern.pivots);
      for (let i = 0; i < activePattern.pivots.length; i++) {
        const p = activePattern.pivots[i];
        const c = candles[p.index];
        if (!c) continue;
        converted.push({
          time: toTime(c.date),
          position: p.type === 'high' ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: '#e879f9',  // 紫桃，配合 patternConnectorRef
          // K 棒旁保留短標籤避免窄圖重疊；精確價位與日期固定列在左上「腳位」圖例。
          text: pivotLabels[i] ?? `P${i + 1}`,
          size: 2,
        });
      }
    }
    // 雙B戰法買賣點（黃紅雙線金叉/死叉 + 突破/跌破智能交易線）
    if (shuangB) {
      for (const m of shuangB.markers) {
        converted.push({
          time: toTime(m.time), position: m.position, shape: m.shape,
          color: m.color, text: m.text, size: m.size ?? 1,
        });
      }
    }
    // ABC 偵測器腳位 marker（A峰/A底/B峰/C底）— amber 圓點，標籤即偵測器選的腳
    if (abcOverlay) {
      for (const m of abcOverlay.markers) {
        converted.push({
          time: toTime(m.time), position: m.position, shape: 'circle',
          color: '#f59e0b', text: m.label, size: 2,
        });
      }
    }
    // 進場/訊號日 — K 棒下方黃圓點（取代整根塗黃）
    const hlMark = highlightDate ? highlightDate.replace(/\*$/, '') : null;
    if (hlMark) {
      const bar = candles.find(c => c.date.replace(/\*$/, '') === hlMark);
      if (bar) {
        converted.push({
          time: toTime(bar.date), position: 'belowBar', shape: 'circle',
          color: '#facc15', text: '', size: 2,
        });
      }
    }
    // 楊氏EMA濾網買賣訊號 ▲進▼出（開啟疊圖時才標）
    if (showYangEma) {
      for (const m of computeYangMarkers(candles)) converted.push(m);
    }
    // lightweight-charts 要求 markers 按時間升序
    converted.sort((a, b) => {
      const ta = String(a.time);
      const tb = String(b.time);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    markersPlugRef.current.setMarkers(converted);
  }, [chartMarkers, highlightDate, candles, showPivots, confirmedPivots, showPattern, activePattern, patternStatus, shuangB, abcOverlay, showYangEma]);

  // ── 均線移動扣抵三角標：算各 MA「下一根要丟掉」那根 K 棒的 x 像素，貼在圖最底一排 ──
  // 扣抵棒索引 = 最新一根 − N + 1（今收高於該根收盤 → 均線下一步往上，見 lib/analysis/maDeduction）。
  // 跟著各 MA 顯示與否連動；用 timeToCoordinate 對齊，捲動/縮放/resize 都重算，捲出畫面就不畫。
  useEffect(() => {
    const chart = chartRef.current;
    const node  = containerRef.current;
    if (!chart || !node) return;
    const ts = chart.timeScale();
    const deductMAs: Array<{ n: number; key: keyof typeof MA_COLORS }> = [
      { n: 5,  key: 'ma5'  },
      { n: 10, key: 'ma10' },
      { n: 20, key: 'ma20' },
      { n: 60, key: 'ma60' },
    ];

    const recompute = () => {
      if (!showMaDeduction || candles.length === 0) { setDeductMarks([]); return; }
      const asOf = candles.length - 1;
      const marks: Array<{ key: keyof typeof MA_COLORS; n: number; color: string; x: number }> = [];
      for (const { n, key } of deductMAs) {
        if (!maToggles[key]) continue;          // 該 MA 沒開 → 不畫它的扣抵三角
        const dropIdx = asOf - n + 1;
        if (dropIdx < 0) continue;              // 窗口還沒滿
        const bar = candles[dropIdx];
        if (!bar) continue;
        const x = ts.timeToCoordinate(toTime(bar.date));
        if (x == null) continue;               // 扣抵棒捲出畫面
        marks.push({ key, n, color: MA_COLORS[key], x: x as number });
      }
      setDeductMarks(marks);
    };

    recompute();
    ts.subscribeVisibleLogicalRangeChange(recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(node);
    return () => {
      ts.unsubscribeVisibleLogicalRangeChange(recompute);
      ro.disconnect();
    };
  }, [candles, maToggles, showMaDeduction]);

  // ── Support/resistance price lines（最近有效壓 / 撐 / 大量價）──────────
  useEffect(() => {
    if (!candleRef.current) return;
    // 清除舊線
    for (const line of srLineRefs.current) {
      try { candleRef.current.removePriceLine(line); } catch { /* noop */ }
    }
    srLineRefs.current = [];

    if (!showSupportResistance || candles.length < 20) return;

    const lastIdx = candles.length - 1;
    const currClose = candles[lastIdx].close;

    // 轉折只取離現價最近的可執行價位，不再把整段最高頭／最低底塞進同一張圖。
    const pivots = findPivots(candles, lastIdx, 12);
    // 大量撐/壓 — 最近 60 根 K 棒中最大量的收盤價
    const lookback = 60;
    const start = Math.max(0, lastIdx - lookback + 1);
    let maxVol = -Infinity;
    let maxVolIdx = -1;
    for (let i = start; i <= lastIdx; i++) {
      if (candles[i].volume > maxVol) {
        maxVol = candles[i].volume;
        maxVolIdx = i;
      }
    }
    const bigVolPrice = maxVolIdx >= 0 ? candles[maxVolIdx].close : undefined;
    const levels = selectActionableSupportResistanceLevels(pivots, currClose, bigVolPrice);
    for (const level of levels) {
      srLineRefs.current.push(candleRef.current.createPriceLine({
        price: level.price,
        color: level.role === 'support' ? '#10b981' : '#ec4899',
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
        title: level.label,
      }));
    }
  }, [showSupportResistance, candles]);

  // ── 最近長紅／長黑 K 棒高、½、低三價位 ──────────────────────────────
  // 使用中性名稱；在價格尚未站穩／跌破前，不先把 K 棒高低宣告成已成立的支撐或壓力。
  useEffect(() => {
    if (!candleRef.current) return;
    for (const line of candleSRLineRefs.current) {
      try { candleRef.current.removePriceLine(line); } catch { /* noop */ }
    }
    candleSRLineRefs.current = [];

    if (!showCandleSR || candles.length === 0) return;

    // 從最新往回找最近一根長紅（多方）或長黑（空方）K 棒當錨點
    let anchorIdx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (isLongRedCandle(candles[i]) || isLongBlackCandle(candles[i])) { anchorIdx = i; break; }
    }
    if (anchorIdx < 0) return;  // 近期無長紅/長黑 → 不畫

    const lv = candleSRLevels(candles[anchorIdx]);
    const isUp = lv.direction === 'up';
    // 多方三層支撐用綠、空方三層壓力用紅；中線（平均成本）一律 amber 虛線
    const strongColor = isUp ? '#10b981' : '#ec4899';
    const weakColor   = isUp ? '#10b981' : '#ec4899';
    const labels = getCandleRangeLabels(lv.direction);
    const lines: Array<{ price: number; color: string; title: string; width: 1 | 2 }> = [
      { price: lv.strong, color: strongColor, title: labels.strong, width: 2 },
      { price: lv.mid,    color: '#f59e0b', title: labels.mid, width: 1 },
      { price: lv.weak,   color: weakColor, title: labels.weak, width: 1 },
    ];
    for (const ln of lines) {
      candleSRLineRefs.current.push(candleRef.current.createPriceLine({
        price: ln.price, color: ln.color, lineWidth: ln.width, lineStyle: 2,
        axisLabelVisible: true, title: ln.title,
      }));
    }
  }, [showCandleSR, candles]);

  // ── 頸線 / 真突破 / 突破後目標 / 回測防守（showNeckline）+ 型態連線（showPattern） ──
  useEffect(() => {
    const neckSeries = necklineRef.current;
    const confirmationSeries = confirmationRef.current;
    const tgtSeries = targetRef.current;
    const stopSeries = stopRef.current;
    const connSeries = patternConnectorRef.current;
    if (!neckSeries || !confirmationSeries || !tgtSeries || !stopSeries || !connSeries) return;

    // 預設清空所有
    neckSeries.setData([]);
    confirmationSeries.setData([]);
    tgtSeries.setData([]);
    stopSeries.setData([]);
    connSeries.setData([]);

    if (!activePattern || !patternStatus) return;
    const { pivots, necklinePrice, targetPrice, stopPrice } = activePattern;
    const directionLabels = getPatternDirectionLabels(activePattern.kind);
    const levelVisibility = getPatternLevelVisibility(patternStatus);
    neckSeries.applyOptions({
      title: '結構頸線',
      lastValueVisible: levelVisibility.necklineAxisLabel,
    });
    confirmationSeries.applyOptions({
      title: directionLabels.confirmation,
      lastValueVisible: levelVisibility.confirmationAxisLabel,
    });
    tgtSeries.applyOptions({
      title: directionLabels.target,
      lastValueVisible: levelVisibility.targetAxisLabel,
    });
    stopSeries.applyOptions({
      title: directionLabels.stop,
      lastValueVisible: levelVisibility.stopAxisLabel,
    });

    // lockedPattern 路徑 pivots 可能為空（fresh detection 失敗時 pivots = []）
    // 此時頸線/目標仍用第一根 K → 最後一根 K，避免 undefined.index crash
    const lastIdx = candles.length - 1;
    if (lastIdx < 0) return;
    const sortedByIndex = pivots.length > 0 ? [...pivots].sort((a, b) => a.index - b.index) : [];
    const firstIdx = sortedByIndex.length > 0 ? sortedByIndex[0].index : 0;
    if (firstIdx < 0 || firstIdx > lastIdx) return;
    const t0 = toTime(candles[firstIdx].date);
    const t1 = toTime(candles[lastIdx].date);

    const slopedPatterns = new Set(['descending-wedge', 'falling-diamond']);
    const slopedOlderHigh = slopedPatterns.has(activePattern.patternType) && activePattern.pivots.length >= 2
      ? activePattern.pivots[1]
      : null;

    if (showNeckline && levelVisibility.neckline) {
      // descending-wedge / falling-diamond 的頸線是「兩高點延伸線」，本質上是斜線
      // detectDescendingWedge 回傳 necklinePrice = upperToday（今日延伸值），需要從較舊 high 連到 upperToday
      // 其他底/頂部型態的頸線是水平線（兩內部 pivot 連線取較高/較低，水平延伸）
      if (slopedOlderHigh) {
        // pivots[1] = highs[1]（較舊 high），detector 順序：[highs[0], highs[1], lows[0], lows[1]]
        const olderTime = toTime(candles[slopedOlderHigh.index].date);
        neckSeries.setData([
          { time: olderTime, value: slopedOlderHigh.price },
          { time: t1, value: necklinePrice },
        ]);
      } else {
        neckSeries.setData([{ time: t0, value: necklinePrice }, { time: t1, value: necklinePrice }]);
      }
    }
    if (showNeckline && levelVisibility.confirmation) {
      const confirmationPrice = getPatternConfirmationPrice(activePattern.kind, necklinePrice);
      if (slopedOlderHigh) {
        confirmationSeries.setData([
          { time: toTime(candles[slopedOlderHigh.index].date), value: getPatternConfirmationPrice(activePattern.kind, slopedOlderHigh.price) },
          { time: t1, value: confirmationPrice },
        ]);
      } else {
        confirmationSeries.setData([{ time: t0, value: confirmationPrice }, { time: t1, value: confirmationPrice }]);
      }
    }
    if (showNeckline && levelVisibility.target) {
      tgtSeries.setData([{ time: t0, value: targetPrice }, { time: t1, value: targetPrice }]);
    }
    if (showNeckline && levelVisibility.stop) {
      if (slopedOlderHigh) {
        stopSeries.setData([
          { time: toTime(candles[slopedOlderHigh.index].date), value: slopedOlderHigh.price * 0.97 },
          { time: t1, value: stopPrice },
        ]);
      } else {
        stopSeries.setData([{ time: t0, value: stopPrice }, { time: t1, value: stopPrice }]);
      }
    }

    // 形態連線：依時間順序連接 pivots（去重 time，lightweight-charts 要求嚴格升序）
    if (showPattern && shouldShowPatternGeometry(patternStatus)) {
      const seen = new Set<string>();
      const points = sortedByIndex
        .map(p => ({ time: toTime(candles[p.index].date), value: p.price }))
        .filter(pt => {
          const key = String(pt.time);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      connSeries.setData(points);
    }
  }, [activePattern, patternStatus, showNeckline, showPattern, candles]);

  // MA legend: show hovered candle's values if hovering, else last candle
  const last = candles[candles.length - 1];
  const displayForLegend = hoverCandle ?? last;
  const idxForLegend = hoverCandle
    ? candles.findIndex(c => c.date === hoverCandle.date)
    : candles.length - 1;
  const prevForLegend = candles[idxForLegend - 1];

  // 信號（右上獨立）+ 形態 chip（左側 row 2）預先計算
  const PRIORITY: Record<string, number> = { SELL: 4, BUY: 3, REDUCE: 2, ADD: 1 };
  const filteredSignals = signals.filter(s => s.type !== 'WATCH');
  const bestSignal = filteredSignals.length > 0
    ? filteredSignals.reduce((a, b) => (PRIORITY[b.type] ?? 0) > (PRIORITY[a.type] ?? 0) ? b : a)
    : null;
  const patternAnalysisRequested = showNeckline || showPattern;
  const showPatternChip = patternAnalysisRequested && activePattern;
  // 即使目前沒有合格型態，也要回應使用者已開啟型態分析，避免按鈕像失效。
  const hasInfoRow = patternAnalysisRequested;  // 信號移到右上，不算左側 row 2
  // 雙B 線（智能交易線/黃線/紅線/多空線）在 hover（或最新）K 棒的數值 —
  // 比照 MA 圖例：疊圖開啟時把線值標出來，游標移動時跟著變。
  const shuangBMaps = useMemo(() => {
    if (!shuangB) return null;
    const m = (pts: { time: string; value: number }[]) =>
      new Map(pts.map(p => [String(p.time).replace(/\*$/, ''), p.value] as const));
    return { zhineng: m(shuangB.zhineng), zb4: m(shuangB.zb4), zb5: m(shuangB.zb5), duokong: m(shuangB.duokong) };
  }, [shuangB]);

  // 楊氏EMA濾網數值（EMA23/EMA60）— 疊圖開啟時算，供左上圖例顯示
  const yangEmaArrays = useMemo(() => {
    if (!showYangEma || candles.length === 0) return null;
    const closes = candles.map(c => c.close);
    return { e23: computeEMA(closes, 23), e60: computeEMA(closes, 60) };
  }, [showYangEma, candles]);
  const shuangBLegend = (() => {
    if (!shuangBMaps || !displayForLegend) return null;
    const d = displayForLegend.date.replace(/\*$/, '');
    const pd = prevForLegend?.date?.replace(/\*$/, '');
    const at = (map: Map<string, number>) => {
      const v = map.get(d);
      if (v == null) return null;
      const pv = pd != null ? map.get(pd) : undefined;
      return { v, arrow: pv != null ? (v >= pv ? ' ↑' : ' ↓') : '' };
    };
    const z = at(shuangBMaps.zhineng), y = at(shuangBMaps.zb4), r = at(shuangBMaps.zb5), dk = at(shuangBMaps.duokong);
    return (z || y || r || dk) ? { z, y, r, dk } : null;
  })();

  // 大戶持股趨勢線在 hover（或最新）K 棒的數值
  const holderLegend = (() => {
    if (!holderLine || !displayForLegend) return null;
    const map = new Map(holderLine.map(p => [String(p.time).replace(/\*$/, ''), p.value] as const));
    const d = displayForLegend.date.replace(/\*$/, '');
    const v = map.get(d);
    if (v == null) return null;
    const pd = prevForLegend?.date?.replace(/\*$/, '');
    const pv = pd != null ? map.get(pd) : undefined;
    return { v, arrow: pv != null ? (v >= pv ? ' ↑' : v < pv ? ' ↓' : '') : '' };
  })();

  // 楊氏EMA濾網在 hover（或最新）K 棒的數值：EMA23 + ±1%/±3% + EMA60
  const yangEmaLegend = (() => {
    if (!yangEmaArrays || idxForLegend < 0) return null;
    const e23 = yangEmaArrays.e23[idxForLegend], e60 = yangEmaArrays.e60[idxForLegend];
    if (!Number.isFinite(e23) || !Number.isFinite(e60)) return null;
    const p23 = idxForLegend > 0 ? yangEmaArrays.e23[idxForLegend - 1] : undefined;
    const p60 = idxForLegend > 0 ? yangEmaArrays.e60[idxForLegend - 1] : undefined;
    const arr = (v: number, pv?: number) => pv != null ? (v >= pv ? ' ↑' : ' ↓') : '';
    return { e23, up1: e23 * 1.01, up3: e23 * 1.03, dn1: e23 * 0.99, dn3: e23 * 0.97, e60, a23: arr(e23, p23), a60: arr(e60, p60) };
  })();

  const patternDirectionLabels = activePattern ? getPatternDirectionLabels(activePattern.kind) : null;
  const patternLevelVisibility = getPatternLevelVisibility(patternStatus);
  const targetDistanceText = activePattern
    ? getTargetDistanceText(candles[candles.length - 1]?.close ?? 0, activePattern.targetPrice)
    : null;
  const statusLabel: Record<PatternLifecycleStatus, { text: string; cls: string }> = {
    pending: { text: '待確認', cls: 'bg-amber-900/80 text-amber-100 border-amber-700' },
    confirmed: { text: patternDirectionLabels?.confirmed ?? '型態成立', cls: 'bg-emerald-900/80 text-emerald-100 border-emerald-700' },
    retest: { text: patternDirectionLabels?.retest ?? '確認後回測', cls: 'bg-sky-900/80 text-sky-100 border-sky-700' },
    'breakout-failed': { text: patternDirectionLabels?.failed ?? '型態失敗', cls: 'bg-red-900/80 text-red-100 border-red-700' },
    'formation-broken': { text: '原型態已破壞', cls: 'bg-red-900/80 text-red-100 border-red-700' },
    target:  { text: '測量目標達成', cls: 'bg-blue-900/80 text-blue-100 border-blue-700' },
  };

  return (
    <div className="relative w-full h-full">
      {/* 左上資訊區 — 單一垂直容器：MA → 信號/形態 → 切線圖例 */}
      <div className="absolute top-2 left-3 z-10 flex flex-col gap-1 pointer-events-none">
        {/* Row 1: MA Legend + 信號 badge（接在 MA240 之後） */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-mono">
          {(Object.entries(MA_COLORS) as [keyof typeof MA_COLORS, string][]).filter(([key]) => maToggles[key]).map(([key, color]) => {
            const val  = displayForLegend?.[key];
            const pVal = prevForLegend?.[key];
            const arrow = val != null && pVal != null ? (val >= pVal ? ' ↑' : ' ↓') : '';
            return (
              <span key={key} style={{ color }}>
                {key.toUpperCase()} {val != null ? val.toFixed(2) : '—'}{arrow}
              </span>
            );
          })}
          {bestSignal && (
            <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${
              bestSignal.type === 'BUY'    ? 'bg-bull/20 text-bull border border-bull'  :
              bestSignal.type === 'ADD'    ? 'bg-orange-500 text-white'  :
              bestSignal.type === 'SELL'   ? 'bg-bear/20 text-bear border border-bear'  :
                                              'bg-teal-500 text-white'
            }`}>{bestSignal.label}</span>
          )}
        </div>

        {/* Row 1.5: 雙B 線數值（智能交易線/黃線/紅線/多空線）— 疊圖開啟才顯示，對齊 hover/最新 K 棒 */}
        {shuangBLegend && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-mono">
            {shuangBLegend.z && <span style={{ color: '#22D3EE' }}>智能線 {shuangBLegend.z.v.toFixed(2)}{shuangBLegend.z.arrow}</span>}
            {shuangBLegend.y && <span style={{ color: '#FFD000' }}>黃線 {shuangBLegend.y.v.toFixed(2)}{shuangBLegend.y.arrow}</span>}
            {shuangBLegend.r && <span style={{ color: '#FF433D' }}>紅線 {shuangBLegend.r.v.toFixed(2)}{shuangBLegend.r.arrow}</span>}
            {shuangBLegend.dk && <span style={{ color: '#FFD000' }} className="opacity-70">多空線 {shuangBLegend.dk.v.toFixed(2)}{shuangBLegend.dk.arrow}</span>}
          </div>
        )}

        {/* Row 1.6: 大戶持股趨勢線數值（千張大戶%）— 開啟才顯示，對齊 hover/最新 K 棒 */}
        {holderLegend && (
          <div className="flex items-center text-xs font-mono">
            <span style={{ color: '#ec4899' }} className="opacity-80">{holderLineLabel} {holderLegend.v.toFixed(1)}%{holderLegend.arrow}</span>
          </div>
        )}

        {/* Row 1.7: 楊氏EMA濾網數值（EMA23 + ±1%/±3% + EMA60）— 疊圖開啟才顯示，對齊 hover/最新 K 棒 */}
        {showYangEma && yangEmaLegend && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-mono">
            <span style={{ color: '#F59E0B' }}>EMA23 {yangEmaLegend.e23.toFixed(2)}{yangEmaLegend.a23}</span>
            <span style={{ color: 'rgba(239,68,68,0.95)' }}>+3% {yangEmaLegend.up3.toFixed(2)}</span>
            <span style={{ color: 'rgba(239,68,68,0.6)' }}>+1% {yangEmaLegend.up1.toFixed(2)}</span>
            <span style={{ color: 'rgba(34,197,94,0.6)' }}>−1% {yangEmaLegend.dn1.toFixed(2)}</span>
            <span style={{ color: 'rgba(34,197,94,0.95)' }}>−3% {yangEmaLegend.dn3.toFixed(2)}</span>
            <span style={{ color: '#3B82F6' }}>EMA60 {yangEmaLegend.e60.toFixed(2)}{yangEmaLegend.a60}</span>
          </div>
        )}

        {/* Row 2: 圖表型態來源 + 生命週期 + 關鍵價位（信號 badge 在右上獨立）*/}
        {hasInfoRow && (
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[11px] font-mono">
            {patternAnalysisRequested && !activePattern && (
              <span className="px-2 py-1 rounded bg-slate-900/85 text-slate-300 border border-slate-600">
                目前沒有通過條件的型態
              </span>
            )}
            {patternAnalysisRequested && lockedPatternReplay?.status === 'rejected' && (
              <span
                className="px-2 py-1 rounded bg-amber-950/90 text-amber-100 border border-amber-500/80"
                title={`舊鎖定未通過目前版本的觸發日回放（${lockedPatternReplay.reason}）；歷史紀錄保留，但不再沿用它的頸線與目標。`}
              >
                舊鎖定已停用｜{activePattern ? '顯示新版型態' : '目前無合格型態'}
              </span>
            )}
            {showPatternChip && (
              <span
                className="px-2 py-1 rounded bg-fuchsia-900/80 text-fuchsia-100 border border-fuchsia-700"
                title={[
                  activePattern.qualityScore != null
                    ? `形狀吻合 ${activePattern.qualityScore}/100（只評腳位幾何，不是勝率）${activePattern.qualityReasons?.length ? `：${activePattern.qualityReasons.join('、')}` : ''}`
                    : null,
                  activePattern.achievementRate != null
                    ? `舊書達標統計 ${activePattern.achievementRate}% 是教材歷史統計，不是本次偵測勝率`
                    : null,
                ].filter(Boolean).join('｜') || undefined}
              >
                {getPatternDisplayName(activePattern.patternType)} · {activePattern.isLocked ? '觸發日鎖定' : '即時候選'}
                {activePattern.qualityScore != null && `｜形狀吻合 ${activePattern.qualityScore}/100（非勝率）`}
                {activePattern.achievementRate != null && `｜舊書統計 ${activePattern.achievementRate}%≠本次勝率`}
                {isLegacyBookObservationOnly(activePattern.patternType) && '｜低達標統計，僅觀察'}
                {isCrossMarketObservationOnly(activePattern.patternType) && '｜跨市場回測未過，僅觀察'}
              </span>
            )}
            {showPatternChip && activePattern.isLocked && !activePattern.pivotsVerified && showPattern && (
              <span
                className="px-1.5 py-0.5 rounded border border-amber-500/70 text-amber-200 text-[10px] font-normal"
                title="鎖定紀錄與目前走圖偵測到的型態不同；已保留鎖定的頸線與目標，但不冒用另一型態的腳位。"
              >
                腳位待對齊
              </span>
            )}
            {showPatternChip && patternStatus && activePattern && (() => {
              const close = candles[candles.length - 1]?.close ?? 0;
              const target = activePattern.targetPrice;
              const confirmationPrice = getPatternConfirmationPrice(activePattern.kind, activePattern.necklinePrice);
              const distanceText = getTargetDistanceText(close, target);
              const labels = getPatternDirectionLabels(activePattern.kind);
              const isBeforeNeckline = activePattern.kind === 'bottom'
                ? close < activePattern.necklinePrice
                : close > activePattern.necklinePrice;
              const necklineDistancePct = Math.abs(close - activePattern.necklinePrice) /
                Math.max(activePattern.necklinePrice, Number.EPSILON) * 100;
              const displayStatusText = patternStatus === 'pending'
                ? isBeforeNeckline ? '形成中' : '接近確認'
                : statusLabel[patternStatus].text;
              const detail = patternStatus === 'pending'
                ? isBeforeNeckline
                  ? `距頸線 ${necklineDistancePct.toFixed(1)}%｜收盤 ${labels.pendingOperator} ${confirmationPrice.toFixed(2)} 才確認`
                  : `已過頸線｜收盤 ${labels.pendingOperator} ${confirmationPrice.toFixed(2)} 才確認`
                : patternStatus === 'confirmed'
                  ? `下一步看 ${labels.target} ${target.toFixed(2)}${distanceText ? `（${distanceText}）` : ''}`
                  : patternStatus === 'retest'
                    ? `${labels.stop} ${activePattern.stopPrice.toFixed(2)}｜${labels.target} ${target.toFixed(2)}${distanceText ? `（${distanceText}）` : ''}｜重新通過 ${confirmationPrice.toFixed(2)}`
                    : patternStatus === 'breakout-failed'
                      ? `已越過 ${labels.stop} ${activePattern.stopPrice.toFixed(2)}｜原目標取消`
                      : patternStatus === 'formation-broken'
                        ? `尚未完成${labels.confirmation}，原型態腳位已被破壞`
                        : `${labels.target} ${target.toFixed(2)} 已達成`;
              return (
                <span
                  className={`px-2 py-1 rounded border text-[11px] font-bold ${statusLabel[patternStatus].cls}`}
                  title={`${displayStatusText}｜${detail}`}
                >
                  {displayStatusText}
                  <span className="ml-1 opacity-80 font-normal">{detail}</span>
                </span>
              );
            })()}
            {showPatternChip && showNeckline && (
              <>
                {patternLevelVisibility.neckline && <span className="flex items-center gap-1" style={{ color: '#22d3ee' }}>
                  <span className="inline-block w-3 h-[2px]" style={{ background: '#22d3ee' }} />
                  結構頸線 {activePattern.necklinePrice.toFixed(2)}
                </span>}
                {patternLevelVisibility.confirmation && <span className="flex items-center gap-1" style={{ color: '#67e8f9' }}>
                  <span className="inline-block w-3 h-[2px] border-t border-dotted" style={{ borderColor: '#67e8f9' }} />
                  {patternDirectionLabels?.confirmation} {getPatternConfirmationPrice(activePattern.kind, activePattern.necklinePrice).toFixed(2)}
                </span>}
                {patternLevelVisibility.target && <span className="flex items-center gap-1" style={{ color: '#86efac' }}>
                  <span className="inline-block w-3 h-[2px] border-t border-dashed" style={{ borderColor: '#86efac' }} />
                  {patternDirectionLabels?.target} {activePattern.targetPrice.toFixed(2)}
                  {targetDistanceText && `｜${targetDistanceText}`}
                </span>}
                {patternLevelVisibility.stop && <span className="flex items-center gap-1" style={{ color: '#fdba74' }}>
                  <span className="inline-block w-3 h-[2px] border-t border-dashed" style={{ borderColor: '#fdba74' }} />
                  {patternDirectionLabels?.stop} {activePattern.stopPrice.toFixed(2)}
                </span>}
              </>
            )}
          </div>
        )}

      {/* 切線 / 軌道線 / 盤整切線圖例 — 只在有線時顯示 */}
      {(trendlineStatus.ascending || trendlineStatus.descending || channelStatus.ascending || channelStatus.descending || consolidationStatus.upper || consolidationStatus.lower) && (() => {
        const refIdx = idxForLegend >= 0 ? idxForLegend : candles.length - 1;
        const ascVal = trendlineStatus.ascending
          ? trendlineStatus.ascending.anchorPrice + trendlineStatus.ascending.slope * (refIdx - trendlineStatus.ascending.anchorIndex)
          : null;
        const descVal = trendlineStatus.descending
          ? trendlineStatus.descending.anchorPrice + trendlineStatus.descending.slope * (refIdx - trendlineStatus.descending.anchorIndex)
          : null;
        const ascChVal = channelStatus.ascending
          ? channelStatus.ascending.anchorPrice + channelStatus.ascending.slope * (refIdx - channelStatus.ascending.anchorIndex)
          : null;
        const descChVal = channelStatus.descending
          ? channelStatus.descending.anchorPrice + channelStatus.descending.slope * (refIdx - channelStatus.descending.anchorIndex)
          : null;
        const consUpperVal = consolidationStatus.upper
          ? consolidationStatus.upper.anchorPrice + consolidationStatus.upper.slope * (refIdx - consolidationStatus.upper.anchorIndex)
          : null;
        const consLowerVal = consolidationStatus.lower
          ? consolidationStatus.lower.anchorPrice + consolidationStatus.lower.slope * (refIdx - consolidationStatus.lower.anchorIndex)
          : null;
        return (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono">
            {ascVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#ef4444' }}>
                <span className="inline-block w-4 h-[3px]" style={{ background: '#ef4444' }} />
                上升切線 {ascVal.toFixed(2)}
              </span>
            )}
            {ascChVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#ef4444' }}>
                <span className="inline-block w-4 h-[2px] border-t border-dashed" style={{ borderColor: '#ef4444' }} />
                上升軌道線 {ascChVal.toFixed(2)}
              </span>
            )}
            {descVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#10b981' }}>
                <span className="inline-block w-4 h-[3px]" style={{ background: '#10b981' }} />
                下降切線 {descVal.toFixed(2)}
              </span>
            )}
            {descChVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#10b981' }}>
                <span className="inline-block w-4 h-[2px] border-t border-dashed" style={{ borderColor: '#10b981' }} />
                下跌軌道線 {descChVal.toFixed(2)}
              </span>
            )}
            {consUpperVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#f59e0b' }}>
                <span className="inline-block w-4 h-[2px] border-t border-dotted" style={{ borderColor: '#f59e0b' }} />
                盤整上頸線 {consUpperVal.toFixed(2)}
              </span>
            )}
            {consLowerVal != null && (
              <span className="flex items-center gap-1" style={{ color: '#f59e0b' }}>
                <span className="inline-block w-4 h-[2px] border-t border-dotted" style={{ borderColor: '#f59e0b' }} />
                盤整下頸線 {consLowerVal.toFixed(2)}
              </span>
            )}
          </div>
        );
      })()}
      </div>{/* /左上資訊區 container（含 MA + 信號 badge + 形態 chip + 切線 legend）*/}

      <div ref={containerRef} className={fillContainer ? 'w-full h-full' : 'w-full'} style={fillContainer ? undefined : { height }} />

      {/* 均線移動扣抵三角標 ▲ — 貼在圖最底一排（x 對齊各 MA「下一根要丟掉」的 K 棒，同色） */}
      {showMaDeduction && deductMarks.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 z-10" style={{ bottom: 24 }}>
          {deductMarks.map(m => (
            <div
              key={m.key}
              className="absolute flex flex-col items-center font-mono leading-none"
              style={{ left: m.x, transform: 'translateX(-50%)' }}
              title={`MA${m.n} 扣抵棒 — 今收高於這根 → ${m.n} 日線下一步往上`}
            >
              <span style={{ color: m.color, fontSize: 11 }}>▲</span>
              <span style={{ color: m.color, fontSize: 9 }}>{m.n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
