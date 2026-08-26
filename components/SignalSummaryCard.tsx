'use client';

/**
 * SignalSummaryCard.tsx — 訊號分頁整合卡（2026-05-10）
 *
 * 取代原訊號分頁 5 個重複面板：
 *   ConclusionCard / V12SignalAlerts / ProhibitionAlerts / WinnerPatternAlerts / RuleAlerts
 *
 * 結構（由上而下）：
 *   1. 策略與持倉狀態
 *   2. 走圖解說（唯一主結論 + 確認/失效）
 *   3. 持倉守則或綜合風向
 *   4. 分層明細（交易計畫 / 均線扣抵 / K 線與贏家圖像 / 其他規則）
 *   5. 朱老師深度分析（預設摺疊）
 *
 * 設計原則（用戶 feedback）：
 *   - feedback_ui_text_concise_over_redundant：最多 3 種語意，不重複
 *   - feedback_no_emoji_in_panels：左邊色條替代 emoji
 *   - 操作建議文字寫得清楚（每條訊號補一行白話「為什麼這條重要」）
 */

import { useEffect, useMemo, useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { usePortfolioStore } from '@/store/portfolioStore';
import { useBacktestStore } from '@/store/backtestStore';
import { classifySignal } from '@/lib/rules/signalClassifier';
import { calcKLineStopLoss } from '@/lib/sell/v12StopLoss';
import { computePartialExitState, type PartialExitState } from '@/lib/sell/v12PartialExit';
import { sopFor } from '@/lib/portfolio/letterSOP';
import {
  resolvePartialExitDisplay,
  resolveHoldingProfitTarget,
  resolveSignalPanelActionPlan,
  resolveSignalPanelOperatingMA,
} from '@/lib/portfolio/signalPanelPlan';
import { getTickSize } from '@/lib/utils/tickSize';
import { marketFromSymbol, formatSharesAsLots } from '@/lib/utils/shareUnits';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { resolveSignalEvaluationPhase } from '@/lib/portfolio/signalEvaluationPhase';
import { resolveHoldingSignalSubtype } from '@/lib/portfolio/holdingSignalPolicy';
import {
  cashDividendAdjustedThreshold,
  cumulativeCashDividend,
  type CashDividendEvent,
} from '@/lib/analysis/dividendEvents';
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import { detectLetterN, detectTopPatterns, type TopPatternType } from '@/lib/analysis/v12LetterN';
import { detectLetterO } from '@/lib/analysis/v12LetterO';
import { detectLetterP } from '@/lib/analysis/v12LetterP';
import { detectLetterQ } from '@/lib/analysis/v12LetterQ';
import { STOP_LOSS_PRICE_MULT, PROFIT_TARGET_PRICE_MULT } from '@/lib/analysis/bookThresholds';
import {
  deductPrice,
  forecastBullishAlignmentDurability,
  forecastAllMaRising,
  daysUntilBullishAlignment,
  daysUntilGoldenCross,
  daysUntilMaRises,
  daysUntilMaTurn,
  formatMaTurnLine,
  MA_PLAIN_LABEL,
  multiMaDeductionStates,
} from '@/lib/analysis/maDeduction';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { ShortSixConditionsResult } from '@/lib/analysis/shortAnalysis';
import type { ProhibitionResult } from '@/lib/rules/entryProhibitions';
import type { RuleSignal, CandleWithIndicators } from '@/types';
import { getPatternDisplayName } from '@/lib/chart/patternDisplay';
import { analyzeKLineSignals, isKLineSignal } from '@/lib/rules/klineSignalAnalysis';
import { pickHoldingRiskProhibitions } from '@/lib/rules/prohibitionRelevance';
import type { PatternSignal } from '@/lib/rules/winnerPatternRules';
import { buildChartNarrative } from '@/lib/narrative/buildChartNarrative';
import { DEFAULT_STOP_LOSS_MULT, evaluateHolding } from '@/lib/agents/holdingsActionEngine';
import type { NarrativeAction } from '@/lib/narrative/types';
import ChartCoachAdvice from './ChartCoachAdvice';
import KLineSignalAnalysisPanel from './KLineSignalAnalysisPanel';
import ChartNarrativePanel from './narrative/ChartNarrativePanel';
import SignalDisclosure from './narrative/SignalDisclosure';

// ── 訊號白話說明對照表 ────────────────────────────────────────────────────────
//
// label 命中時補一行「為什麼這條重要」。沒列入的訊號會 fallback 到原 description。
// 用書本根據而非技術指標白話。

const SIGNAL_EXPLAIN: Record<string, string> = {
  // 出場類
  '跌破MA10': '操作均線守不住，書本：跌破操作均線立即出場',
  '跌破MA5':  'MA5 是短線操作生命線，書本：守不住 MA5 視同短線出場',
  '跌破MA20': '月線跌破代表中期趨勢轉弱',
  '跌破MA60': '季線跌破，書本：「破季線是大空頭」需立即離場',
  '跌破前低': '波浪結構失敗（底底低），書本：明確空方訊號',
  'KD死叉':  '指標背離，動能轉弱訊號',
  'MACD死叉':'中期動能由多轉空',
  // 進場類（V12 字母也走這層）
  '紅K':     '紅K實體棒+量配合，書本：強勢進場訊號',
  'MA5上穿': '短線翻多，書本：突破 MA5 是短線進場時機',
  'MA20上穿':'中線翻多，書本：突破 MA20 是進場好位置',
  '突破前高': '波浪結構成立（頭頭高），書本：多方訊號',
  'KD金叉':  '指標翻多，動能加速訊號',
  'MACD金叉':'中期動能由空轉多',
};

/** 進場類字母（只有這 5 個會在訊號卡顯示，避免和持倉 letter 混淆）*/
type EntryLetter = 'M' | 'N' | 'O' | 'P' | 'Q';

// trackName 不含字母前綴（badge 已標 M/N/O/P/Q，避免顯示時 Q + Q 三均線戰法 + Q ... 三層重複）
const V12_TRACK_NAMES: Record<EntryLetter, string> = {
  M: '突破上升軌道（多頭續攻）',
  N: '型態確認突破頸線（課程六型優先＋舊書補充）',
  O: '打底完成由空翻多',
  P: '高檔淺回 1-2 天後再上漲',
  Q: '三均線戰法（MA3+10+24）',
};

// ── 結論計算 ─────────────────────────────────────────────────────────────────

const NARRATIVE_BAR: Record<NarrativeAction, string> = {
  exit: 'bg-emerald-500',
  reduce: 'bg-amber-500',
  'evaluate-entry': 'bg-rose-500',
  hold: 'bg-rose-500',
  wait: 'bg-sky-500',
  'avoid-entry': 'bg-emerald-500',
};

// ── V12 字母動態偵測 ──────────────────────────────────────────────────────────

interface V12Hit {
  letter: EntryLetter;
  trackName: string;
  detail: string;
  patternType?: string;
  patternTargetPrice?: number;
  achievementRate?: number;
  necklinePrice?: number;
}

/** 頂部型態命中（出場警示用，僅持股中時顯示）*/
interface TopPatternHit {
  patternType: TopPatternType;
  detail: string;
  necklinePrice?: number;
  patternTargetPrice?: number;
  achievementRate?: number;
}

function uniqueRuleSignals(signals: RuleSignal[]): RuleSignal[] {
  return [...new Map(
    signals.map(signal => [`${signal.type}:${signal.ruleId}:${signal.label}`, signal] as const),
  ).values()];
}

function klineDisclosureMeta(
  analyses: ReturnType<typeof analyzeKLineSignals>,
  bullishPatterns: PatternSignal[],
  bearishPatterns: PatternSignal[],
  action: NarrativeAction,
): string {
  const winnerCount = bullishPatterns.length + bearishPatterns.length;
  const confirmedBullish = analyses.some(item => item.state === 'confirmed' && item.direction === 'bullish')
    || bullishPatterns.length > 0;
  const riskFirst = action === 'exit' || action === 'reduce' || action === 'avoid-entry';
  if (riskFirst && confirmedBullish) return '多方型態，但風險優先';
  if (analyses.length === 0 && winnerCount === 0) return '今日未命中';
  if (analyses.length === 1 && winnerCount === 0) {
    return `${analyses[0].stateLabel} · ${analyses[0].signal.label}`;
  }
  if (analyses.length === 0 && winnerCount === 1) {
    return `贏家圖像 · ${(bullishPatterns[0] ?? bearishPatterns[0]).name}`;
  }
  return `K 線 ${analyses.length} · 圖像 ${winnerCount}`;
}

function klineConflictMessage(
  analyses: ReturnType<typeof analyzeKLineSignals>,
  bullishPatterns: PatternSignal[],
  action: NarrativeAction,
): string | null {
  const confirmedBullish = analyses.some(item => item.state === 'confirmed' && item.direction === 'bullish')
    || bullishPatterns.length > 0;
  const riskFirst = action === 'exit' || action === 'reduce' || action === 'avoid-entry';
  if (!riskFirst || !confirmedBullish) return null;
  return '雖有多方 K 線或贏家圖像，但不會抵銷目前的風險結論；先依趨勢、戒律與操作均線處理。';
}

// ── 主元件 ──────────────────────────────────────────────────────────────────

export default function SignalSummaryCard() {
  const {
    currentSignals, allCandles, currentIndex, currentStock,
    currentInterval, longProhibitions, shortProhibitions, shortConditions, winnerPatterns,
  } = useReplayStore();
  const { holdings } = usePortfolioStore();
  // 掃描面板選的策略 — 讓訊號卡的操作 SOP（操作均線/停損停利框架）跟著換
  const activeBuyMethod = useBacktestStore(s => s.activeBuyMethod);
  const scanDirection = useBacktestStore(s => s.scanDirection);

  const candle = allCandles[currentIndex];
  const ticker = currentStock?.ticker ?? '';
  const market = marketFromSymbol(ticker);
  // 避免 SSR / hydration 直接讀取不同時間；掛載後每 30 秒更新一次盤中／收盤階段，
  // 即使報價剛好沒有變動，收盤後也能把「盤中預警」切成正式判讀。
  const [signalClock, setSignalClock] = useState<Date | null>(null);
  useEffect(() => {
    const updateClock = () => setSignalClock(new Date());
    updateClock();
    const timer = window.setInterval(updateClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const evaluationPhase = signalClock
    ? resolveSignalEvaluationPhase({
        interval: currentInterval,
        currentIndex,
        candleCount: allCandles.length,
        candleDate: candle?.date,
        market,
        now: signalClock,
      })
    : 'closed';

  // V12 字母偵測（M/N/O/P/Q）+ 頂部型態（持股中才顯示）
  const [v12Hits, setV12Hits] = useState<V12Hit[]>([]);
  const [topPatternHit, setTopPatternHit] = useState<TopPatternHit | null>(null);
  const v12Market: 'TW' | 'CN' = useMemo(
    () => /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW',
    [ticker],
  );

  useEffect(() => {
    if (!ticker || allCandles.length < 30 || currentIndex < 25) {
      setV12Hits([]);
      setTopPatternHit(null);
      return;
    }
    // 同步偵測（detector 為純函式無 await）— 不需要 cancellation flag
    try {
      const m = detectLetterM(allCandles, currentIndex, v12Market, ticker);
      const n = detectLetterN(allCandles, currentIndex, v12Market, ticker);
      const o = detectLetterO(allCandles, currentIndex, v12Market, ticker);
      const p = detectLetterP(allCandles, currentIndex, v12Market, ticker);
      const q = detectLetterQ(allCandles, currentIndex, v12Market, ticker);
      const top = detectTopPatterns(allCandles, currentIndex);
      const hits: V12Hit[] = [];
      if (m.triggered) hits.push({ letter: 'M', trackName: V12_TRACK_NAMES.M, detail: m.detail });
      if (n.triggered && n.patternType) {
        hits.push({
          letter: 'N',
          trackName: V12_TRACK_NAMES.N,
          detail: n.detail,
          patternType: n.patternType,
          patternTargetPrice: n.patternTargetPrice,
          achievementRate: n.achievementRate ? n.achievementRate / 100 : undefined,
          necklinePrice: n.necklinePrice,
        });
      }
      if (o.triggered) hits.push({ letter: 'O', trackName: V12_TRACK_NAMES.O, detail: o.detail });
      if (p.triggered) hits.push({ letter: 'P', trackName: V12_TRACK_NAMES.P, detail: p.detail });
      if (q.triggered) hits.push({ letter: 'Q', trackName: V12_TRACK_NAMES.Q, detail: q.detail });
      setV12Hits(hits);
      setTopPatternHit(top.triggered && top.patternType ? {
        patternType: top.patternType,
        detail: top.detail,
        necklinePrice: top.necklinePrice,
        patternTargetPrice: top.patternTargetPrice,
        achievementRate: top.achievementRate ? top.achievementRate / 100 : undefined,
      } : null);
    } catch (err) {
      console.error('[SignalSummaryCard] v12 detect error', err);
      // 異常時清空避免顯示前次股票的殘留 hit
      setV12Hits([]);
      setTopPatternHit(null);
    }
  }, [ticker, v12Market, allCandles, currentIndex]);

  if (!candle || !ticker) return null;

  const currentSymbol = ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const maPreviewStates = multiMaDeductionStates(
    allCandles.map(item => item.close),
    MA_FORECAST_SET.map(item => item.n),
    currentIndex,
  );
  const maPreviewUp = maPreviewStates.filter(state => state.nextDirection === 'up').length;
  const maPreviewDown = maPreviewStates.filter(state => state.nextDirection === 'down').length;
  const maForecastMeta = maPreviewStates.length > 0
    ? `明天 ${maPreviewUp} 上彎 · ${maPreviewDown} 下彎`
    : '5 · 10 · 20 · 60 日線';
  const heldPosition = holdings.find(h => h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === currentSymbol);
  const hasPosition = !!heldPosition;

  // ── 主訊號字母（2026-07-06 持倉買法優先）──────────────────────────────
  //   持股中：這筆「怎麼買的」（triggerSignal）決定出場 SOP；舊資料缺字母固定預設 B，
  //           不得退回右側掃描策略，避免切換瀏覽條件時改寫持倉守則。
  //   未持倉：跟掃描面板選的策略（讓訊號跟著策略換）→ V12 偵測 → 持倉字母 → 'B'
  const ENTRY_LETTERS = new Set(['B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']);
  const V11_ALIAS_MAP: Record<string, string> = { G: 'J', H: 'L', I: 'K' };
  const heldLetterRaw = heldPosition?.triggerSignal;
  const heldLetterNorm = heldLetterRaw ? (V11_ALIAS_MAP[heldLetterRaw] ?? heldLetterRaw) : null;
  const heldLetter: V12Letter | null = heldLetterNorm && ENTRY_LETTERS.has(heldLetterNorm)
    ? (heldLetterNorm as V12Letter)
    : null;
  const normalizedActive = V11_ALIAS_MAP[activeBuyMethod] ?? activeBuyMethod;
  const strategyLetter: V12Letter | null = ENTRY_LETTERS.has(normalizedActive) ? (normalizedActive as V12Letter) : null;
  const PRIORITY: EntryLetter[] = ['Q', 'N', 'M', 'P', 'O'];
  const primaryV12 = PRIORITY.map(l => v12Hits.find(h => h.letter === l)).find(Boolean);
  const missingHoldingLetter = hasPosition && heldLetter == null;
  const primaryLetter: V12Letter = hasPosition
    ? (heldLetter ?? 'B')
    : (strategyLetter ?? primaryV12?.letter ?? 'B');
  const operationMode = hasPosition ? (heldPosition?.operationMode ?? 'short') : 'short';
  const holdingModeLabel = operationMode === 'long' ? ' · 長線' : '';
  // 策略視角顯示名（持倉買法優先時標示來源；A/R 不是單一進場字母，特別標示）
  const strategyName = heldLetter ? `${sopFor(primaryLetter).name} · 持倉 ${primaryLetter}${holdingModeLabel}`
    : missingHoldingLetter ? `${sopFor(primaryLetter).name} · 預設 B${holdingModeLabel}`
    : activeBuyMethod === 'A' ? '六條件（預選池）'
    : activeBuyMethod === 'R' ? '機械軌（乖離率）'
    : sopFor(primaryLetter).name;
  // 短線模式與 letterSOP 對齊；持倉升級長線後必須改用 MA20，和後端風控保持一致。
  const operatingMA = resolveSignalPanelOperatingMA(primaryLetter, operationMode);
  const strategyContextTitle = hasPosition
    ? `此訊號卡依這筆持倉的進場買法與操作模式，固定套用「${strategyName}」 SOP（操作均線 ${operatingMA ?? '—'}），不會跟著右側掃描策略改變。`
    : `此訊號卡套用「${strategyName}」 SOP（操作均線 ${operatingMA ?? '—'}）；在右側掃描面板換策略時會同步切換。`;

  // ── 訊號分類（出場訊號對齊操作均線）────────────────────────────────────
  // 全市場的飆股走圖規則在持倉中只保留資訊；正式交易動作由下方持倉引擎確認。
  // 持股中：比操作均線「短」的跌破均線出場訊號降級為軟出場（緊盯/減碼，不喊該出場）。
  // 例：J（ABC 突破）操作 MA20 — 破 MA5/MA10 只是減碼警示，收盤破 MA20 才是硬出場。
  const classified = currentSignals.map(s => {
    const subtype = resolveHoldingSignalSubtype({
      signal: s,
      subtype: s.subtype ?? classifySignal(s),
      hasPosition,
      operatingMA,
    });
    return { sig: s, subtype };
  });
  const entrySigs = classified
    .filter(c => c.subtype === 'entry_strong' || c.subtype === 'entry_soft' || c.subtype === 'trend')
    .map(c => c.sig);
  // 硬出場排前面，明細中依風險優先順序顯示。
  const exitSigs = [
    ...classified.filter(c => c.subtype === 'exit_strong'),
    ...classified.filter(c => c.subtype === 'exit_soft'),
  ].map(c => c.sig);
  const warnSigs = classified.filter(c => c.subtype === 'warn').map(c => c.sig);
  const klineAnalyses = analyzeKLineSignals(currentSignals);
  const entryReasonSigs = uniqueRuleSignals(entrySigs.filter(signal => !isKLineSignal(signal)));
  const exitReasonSigs = uniqueRuleSignals(exitSigs.filter(signal => !isKLineSignal(signal)));
  const warnReasonSigs = uniqueRuleSignals(warnSigs.filter(signal => !isKLineSignal(signal)));

  const criticalProhibitions = pickHoldingRiskProhibitions(longProhibitions?.reasons ?? []);
  // 持倉主結論與每日持股風控共用同一套引擎，避免同一檔同時出現「續抱」與「停損」。
  let formalExitRisk: string | null = null;
  let formalExitReason: string | null = null;
  if (heldPosition && allCandles.length > 0) {
    try {
      const holdingDecision = evaluateHolding({
        symbol: ticker,
        entryPrice: heldPosition.costPrice,
        stopLoss: heldPosition.stopLoss
          ?? +(heldPosition.costPrice * DEFAULT_STOP_LOSS_MULT).toFixed(2),
        candles: allCandles.slice(0, currentIndex + 1),
        todayClose: candle.close,
        triggerSignal: heldPosition.triggerSignal,
        operationMode: heldPosition.operationMode ?? 'short',
        entryDate: heldPosition.buyDate,
        positionSide: heldPosition.positionSide ?? 'long',
        entryHigh: heldPosition.entryKbar?.high,
        entryKlineLow: heldPosition.entryKbar?.low,
      });
      if (['stop_loss', 'exit_all', 'cover_all'].includes(holdingDecision.action)) {
        const primarySignal = holdingDecision.signals[0];
        formalExitReason = primarySignal?.label ?? holdingDecision.label;
        formalExitRisk = primarySignal
          ? `${formalExitReason}：${primarySignal.detail}`
          : holdingDecision.label;
      }
    } catch (error) {
      console.error('[SignalSummaryCard] holding action evaluation error', error);
    }
  }
  const reasonDetailCount = (!hasPosition ? v12Hits.length + entryReasonSigs.length : 0)
    + (hasPosition ? exitReasonSigs.length : 0)
    + warnReasonSigs.length
    + (topPatternHit ? 1 : 0)
    + (hasPosition ? criticalProhibitions.length : 0);
  const chartNarrative = buildChartNarrative({
    candles: allCandles,
    currentIndex,
    signals: currentSignals,
    classifiedSignals: classified,
    hasPosition,
    prohibitions: longProhibitions?.reasons ?? [],
    hardRisks: [
      ...(formalExitRisk ? [formalExitRisk] : []),
      ...(topPatternHit
        ? [`${getPatternDisplayName(topPatternHit.patternType)}跌破頸線：${topPatternHit.detail}`]
        : []),
    ],
    operatingMA,
    evaluationPhase,
  });
  const operatingMAValue = operatingMA
    ? (candle as unknown as Record<string, number | undefined>)[operatingMA.toLowerCase()]
    : undefined;
  const actionPlan = resolveSignalPanelActionPlan({
    action: chartNarrative.action,
    primaryCategory: chartNarrative.primaryEvent.category,
    hasPosition,
    close: candle.close,
    operatingMA,
    operatingMAValue,
    confirmation: chartNarrative.confirmation,
    decisiveReason: chartNarrative.action === 'exit'
      ? (formalExitReason ?? chartNarrative.summary)
      : formalExitReason,
    evaluationPhase,
  });
  // ── 停損 / 停利 ─────────────────────────────────────────────────────────
  // 持股中 vs 未持倉 兩條計算徹底分流，不再共用 entryPrice
  const currentPatternTarget = primaryV12?.patternTargetPrice;
  const holdingPatternTarget = heldPosition?.entryPattern?.targetPrice;

  // 持倉中只讀進場時凍結的型態快照，不得用今日新偵測的型態目標改寫持倉計畫。
  const holdingProfitPlan = hasPosition && heldPosition?.costPrice != null
    ? resolveHoldingProfitTarget(heldPosition.costPrice, holdingPatternTarget)
    : null;
  const profitLine = holdingProfitPlan?.price ?? null;
  const profitLineReached = profitLine != null && candle.close >= profitLine;
  const profitLineSource = holdingProfitPlan?.source ?? 'rule';

  // 未持倉（若今日進場 試算）：進場=今收、停損=K線最低 vs 7% floor、停利=今收×1.10 或型態目標
  const projEntry = candle.close;
  const tickSize = getTickSize(projEntry, market);
  const projKlineStop = calcKLineStopLoss(candle, tickSize);
  const projStopLoss = Math.max(projKlineStop, projEntry * STOP_LOSS_PRICE_MULT);  // 書本守則：停損 7% 上限
  const projSlPct = ((projStopLoss - projEntry) / projEntry) * 100;
  const projProfit = currentPatternTarget ?? projEntry * PROFIT_TARGET_PRICE_MULT;
  const projPtPct = ((projProfit - projEntry) / projEntry) * 100;
  const projProfitSource: 'pattern' | 'rule' = currentPatternTarget != null ? 'pattern' : 'rule';

  // ── 33 種贏家圖像（與當日 K 線訊號同區呈現，避免把局部圖像分數寫成全局趨勢）──
  const adjust = winnerPatterns?.compositeAdjust ?? 0;
  const bullishWinnerPatterns = winnerPatterns?.bullishPatterns ?? [];
  const bearishWinnerPatterns = winnerPatterns?.bearishPatterns ?? [];
  const klineConflict = klineConflictMessage(klineAnalyses, bullishWinnerPatterns, chartNarrative.action);

  // ── 持倉損益 ────────────────────────────────────────────────────────────
  const pnlPct = (heldPosition?.costPrice && candle.close)
    ? ((candle.close - heldPosition.costPrice) / heldPosition.costPrice) * 100
    : null;

  // ── CH8 8-5 三條均線分批出場（選用「賠少」模式，純顯示，不改既有停損停利）──
  let partialExitState: PartialExitState | null = null;
  if (hasPosition && heldPosition?.costPrice != null && allCandles.length > 0) {
    const eIdx = allCandles.findIndex(c => c.date === heldPosition.buyDate);
    if (eIdx >= 0) {
      const upto = allCandles.slice(0, Math.min(currentIndex, allCandles.length - 1) + 1);
      if (upto.length > eIdx + 1) {
        partialExitState = computePartialExitState(upto, eIdx, heldPosition.costPrice, 'long');
      }
    }
  }

  if (scanDirection === 'short') {
    return (
      <ShortSignalSummary
        candle={candle}
        conditions={shortConditions}
        prohibitions={shortProhibitions}
        klineAnalyses={klineAnalyses}
      />
    );
  }

  return (
    <div className="bg-card ring-1 ring-foreground/10 rounded-xl overflow-hidden">
      <div className="flex">
        {/* 左邊強度色條 */}
        <div className={`w-1 shrink-0 ${NARRATIVE_BAR[chartNarrative.action]}`} />
        <div className="flex-1 p-3 space-y-3">

          {/* ── 0. 策略視角（跟著右側掃描面板選的策略換）──────────────── */}
          <div
            className="flex items-center gap-2 text-xs"
            title={strategyContextTitle}
          >
            <span className="px-1.5 py-0.5 rounded bg-sky-900/50 text-sky-200 font-semibold shrink-0">策略</span>
            <span className="text-foreground/85 font-medium truncate">{strategyName}</span>
            {operatingMA && (
              <span className="ml-auto shrink-0 text-muted-foreground/80">
                操作均線 <span className="font-mono text-foreground/80">{operatingMA}</span>
              </span>
            )}
          </div>

          {/* 字體系統（3 級）：
                Heading: text-base font-bold（一句話結論「該出場」「可進場」）
                Body:    text-xs（一般文字 / 數字 / 描述）
                Small:   text-[11px]（label / 書本根據 tag / 細節）
              避免 9px / 10px / lg 混用 */}

          {/* ── 1. 持倉狀態（雙行版面：身分 / 報價對照） ───────────────── */}
          <div className="space-y-1">
            {/* 第一行：身分標籤 + 數量 */}
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${hasPosition ? 'text-rose-300' : 'text-muted-foreground'}`}>
                {hasPosition ? '持股中' : '未持倉'}
              </span>
              {hasPosition && heldPosition && (
                <span className="text-[11px] text-muted-foreground font-mono">
                  {formatSharesAsLots(heldPosition.shares, market)}
                </span>
              )}
            </div>
            {/* 第二行：現價 + 成本 + PnL（持股才顯示成本對照） */}
            <div className="flex items-center justify-between font-mono text-xs">
              <span>
                <span className="text-muted-foreground/70 text-[11px]">現價</span>
                <span className="ml-1 text-foreground font-bold">{candle.close.toFixed(2)}</span>
              </span>
              {heldPosition?.costPrice != null && (
                <span>
                  <span className="text-muted-foreground/70 text-[11px]">成本</span>
                  <span className="ml-1 text-foreground/80">{heldPosition.costPrice.toFixed(2)}</span>
                  {pnlPct != null && (
                    <span className={`ml-1.5 font-bold ${pnlPct >= 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>


          <ChartNarrativePanel narrative={chartNarrative} actionPlan={actionPlan} />

          {/* ── 3. 交易框架 + 風向 ──
                持股中 → 持倉診斷（動態停損 + 10% 紀律停利）
                未持倉 → 試算收進摺疊，避免「暫不進場」下方立刻叫人進場 */}
          {!(hasPosition && chartNarrative.action === 'exit') && (
            <div className="border-t border-border/40 pt-2 space-y-2">
              {hasPosition ? (
                <>
                  <HoldingDiscipline
                    candle={candle}
                    operatingMA={operatingMA}
                    profitLine={profitLine}
                    profitLineReached={profitLineReached}
                    profitLineSource={profitLineSource}
                  />
                  {partialExitState && <PartialExitMini state={partialExitState} />}
                </>
              ) : (
                <SignalDisclosure
                  title="交易計畫"
                  meta={chartNarrative.action === 'evaluate-entry' ? '進場條件成立' : '條件成立後試算'}
                >
                  <EntryProjection
                    projEntry={projEntry}
                    projStopLoss={projStopLoss}
                    projSlPct={projSlPct}
                    projProfit={projProfit}
                    projPtPct={projPtPct}
                    projProfitSource={projProfitSource}
                  />
                </SignalDisclosure>
              )}
            </div>
          )}

          <SignalDisclosure title="均線扣抵預測" meta={maForecastMeta}>
            <MaDeductionForecast
              candles={allCandles}
              index={currentIndex}
              symbol={currentSymbol}
              market={market === 'CN' ? 'CN' : 'TW'}
              embedded
            />
          </SignalDisclosure>

          <SignalDisclosure
            title="K 線與贏家圖像"
            meta={klineDisclosureMeta(
              klineAnalyses,
              bullishWinnerPatterns,
              bearishWinnerPatterns,
              chartNarrative.action,
            )}
          >
            <div className="space-y-3">
              {klineConflict && (
                <p className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-100/90">
                  {klineConflict}
                </p>
              )}
              <KLineSignalAnalysisPanel
                analyses={klineAnalyses}
                showHeader={false}
                context={{ action: chartNarrative.action }}
              />
              <WinnerPatternDetails
                bullishPatterns={bullishWinnerPatterns}
                bearishPatterns={bearishWinnerPatterns}
                compositeAdjust={adjust}
              />
            </div>
          </SignalDisclosure>

          {/* ── 4. 為什麼？分組 ───────────────────────────── */}
          {/* topPatternHit 不論持倉都傳，持股時是出場警示，未持倉時是禁止做多依據。
              hasPosition 決定要不要顯示「進場依據」（持股中隱藏，避免暗示加碼）*/}
          {reasonDetailCount > 0 && (
            <SignalDisclosure title="其他規則明細" meta={`${reasonDetailCount} 項`}>
              <Reasons
                hasPosition={hasPosition}
                v12Hits={v12Hits}
                topPatternHit={topPatternHit}
                entrySigs={entryReasonSigs}
                exitSigs={exitReasonSigs}
                warnSigs={warnReasonSigs}
                criticalProhibitions={criticalProhibitions}
                todayClose={candle.close}
                embedded
              />
            </SignalDisclosure>
          )}
        </div>
      </div>

      {/* ── 5. 朱老師深度分析（底部，預設摺疊） ─────────────── */}
      <div className="border-t border-border/60 bg-secondary/30 p-3">
        <ChartCoachAdvice defaultCollapsed />
      </div>
    </div>
  );
}

function WinnerPatternDetails({
  bullishPatterns,
  bearishPatterns,
  compositeAdjust,
}: {
  bullishPatterns: PatternSignal[];
  bearishPatterns: PatternSignal[];
  compositeAdjust: number;
}) {
  const patterns = [...bearishPatterns, ...bullishPatterns];
  const scoreLabel = compositeAdjust > 0
    ? `偏多 +${compositeAdjust}`
    : compositeAdjust < 0
      ? `偏空 ${compositeAdjust}`
      : '多空相抵';

  return (
    <section aria-label="33 種贏家圖像" className="border-t border-border/35 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground/85">33 種贏家圖像</h3>
        {patterns.length > 0 && (
          <span className="text-[10px] text-muted-foreground/75">
            多 {bullishPatterns.length} · 空 {bearishPatterns.length} · {scoreLabel}
          </span>
        )}
      </div>

      {patterns.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
          今日未命中書本 33 種贏家圖像；這不代表沒有其他進出場訊號。
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {patterns.map(pattern => (
            <div key={pattern.id} className="rounded-md bg-secondary/25 px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <p className={`text-[11px] font-semibold ${
                  pattern.direction === 'bullish' ? 'text-rose-200' : 'text-emerald-200'
                }`}>
                  {pattern.name}
                </p>
                <span className="shrink-0 text-[10px] text-muted-foreground/65">
                  規則權重 {pattern.confidence}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/70">
                {pattern.description}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ShortSignalSummary({
  candle,
  conditions,
  prohibitions,
  klineAnalyses,
}: {
  candle: CandleWithIndicators;
  conditions: ShortSixConditionsResult | null;
  prohibitions: ProhibitionResult | null;
  klineAnalyses: ReturnType<typeof analyzeKLineSignals>;
}) {
  const blocked = prohibitions?.prohibited === true;
  const ready = conditions?.isCoreReady === true && !blocked;
  return (
    <div className="bg-card ring-1 ring-foreground/10 rounded-xl overflow-hidden">
      <div className="flex">
        <div className={`w-1 shrink-0 ${ready ? 'bg-emerald-500' : blocked ? 'bg-rose-500' : 'bg-amber-500'}`} />
        <div className="flex-1 p-3 space-y-3">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-200 font-semibold">策略</span>
            <span className="text-foreground/85 font-medium">做空六條件</span>
            <span className="ml-auto font-mono text-muted-foreground">現價 {candle.close.toFixed(2)}</span>
          </div>
          <div>
            <p className={`text-base font-bold ${ready ? 'text-emerald-300' : blocked ? 'text-rose-300' : 'text-amber-300'}`}>
              {blocked ? '戒律觸發，不宜放空' : ready ? '空方核心條件成立' : '空方條件不足，先觀望'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              核心 {conditions?.coreScore ?? 0}/5｜總分 {conditions?.totalScore ?? 0}/6
            </p>
          </div>
          {blocked && (prohibitions?.reasons.length ?? 0) > 0 && (
            <ul className="space-y-1 text-[11px] text-rose-200/90">
              {prohibitions?.reasons.slice(0, 5).map((reason) => <li key={reason}>· {reason}</li>)}
            </ul>
          )}
          <KLineSignalAnalysisPanel
            analyses={klineAnalyses}
            context={ready
              ? { preferredDirection: 'bearish' }
              : { suppressActionable: true }}
          />
          <div className="pt-2 border-t border-border/40 text-[10px] text-muted-foreground leading-relaxed">
            做空結果只使用空方六條件與空方戒律；實際下單前另確認借券來源、券量與融券限制。
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 子元件：移動扣抵預測（課程 CH3-2 · 純顯示層）──────────────────────────
//
// 「移動扣抵」是均線的內建確定性：N 日線下一根會丟掉 N 天前那根收盤（扣抵值）、
// 補進今收。今收 vs 扣抵值就先告訴你均線下一步往上/往下（課程 CH3-2：抵>扣上彎、
// 抵<扣下彎），再往前推估「幾天後翻向」「短均線幾天後黃金交叉」。
// 純提示用，刻意不接選股、不做進出場訊號。
// 未來 K 棒一律假設「價停在今收」，越往後越粗估 → 黃金交叉只看近窗（5 根內）、
// 翻向結論句只看近窗 10 根（課程說 7~8 天前未卜先知）。

const MA_FORECAST_SET: ReadonlyArray<{ n: number; label: string }> = [
  { n: 5, label: 'MA5' },
  { n: 10, label: 'MA10' },
  { n: 20, label: 'MA20' },
  { n: 60, label: 'MA60' },
];

/** 翻向結論句最多往前看幾根（課程 CH3-2：7~8 天前未卜先知，再遠凍結價假設不可靠） */
const MA_TURN_LOOKAHEAD = 10;

function tradingDateAfter(dateStr: string, daysAhead: number, market: 'TW' | 'CN'): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr) || daysAhead < 1) return null;
  const cursor = new Date(`${dateStr.slice(0, 10)}T12:00:00Z`);
  let remaining = Math.floor(daysAhead);
  for (let guard = 0; guard < 45 && remaining > 0; guard++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = cursor.toISOString().slice(0, 10);
    if (isTradingDay(candidate, market)) remaining--;
  }
  return remaining === 0 ? cursor.toISOString().slice(0, 10) : null;
}

function tradingDateBefore(dateStr: string, market: 'TW' | 'CN'): string | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const cursor = new Date(`${dateStr.slice(0, 10)}T12:00:00Z`);
  for (let guard = 0; guard < 14; guard++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = cursor.toISOString().slice(0, 10);
    if (isTradingDay(candidate, market)) return candidate;
  }
  return null;
}

function shortDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(dateStr);
  return match ? `${Number(match[1])}/${Number(match[2])}` : null;
}

function MaDeductionForecast({
  candles, index, symbol, market, embedded = false,
}: {
  candles: CandleWithIndicators[];
  index: number;
  symbol: string;
  market: 'TW' | 'CN';
  embedded?: boolean;
}) {
  const asOfDate = candles[index]?.date?.slice(0, 10) ?? '';
  const [dividendEvents, setDividendEvents] = useState<CashDividendEvent[]>([]);

  useEffect(() => {
    setDividendEvents([]);
    if (market !== 'TW' || !/^\d{4}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return;
    const controller = new AbortController();
    void fetch(`/api/dividend-events?symbol=${encodeURIComponent(symbol)}&asOf=${encodeURIComponent(asOfDate)}`, {
      signal: controller.signal,
    })
      .then(response => response.ok ? response.json() : null)
      .then((payload: { events?: CashDividendEvent[] } | null) => {
        if (payload?.events && !controller.signal.aborted) setDividendEvents(payload.events);
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[MaDeductionForecast] dividend events fetch failed', error);
      });
    return () => controller.abort();
  }, [asOfDate, market, symbol]);

  const view = useMemo(() => {
    if (!candles.length) return null;
    const asOf = Math.min(Math.max(index, 0), candles.length - 1);
    const closes = candles.map(c => c.close);
    const today = closes[asOf];
    if (today == null) return null;

    const dates = candles.map(c => c.date);
    const states = multiMaDeductionStates(closes, MA_FORECAST_SET.map(row => row.n), asOf);
    const stateByPeriod = new Map(states.map(state => [state.period, state]));
    const rows = MA_FORECAST_SET.map(({ n, label }) => {
      const dp = deductPrice(closes, n, asOf);
      const turn = daysUntilMaTurn(closes, n, asOf, Math.min(n, MA_TURN_LOOKAHEAD));
      return { n, label, deduct: dp, turn, state: stateByPeriod.get(n) };
    }).filter(r => r.deduct != null);

    // 白話結論句（課程 CH3-2）：只對有翻向結論的均線出一行，例
    // 「月線 3 天後要扣 6/12 的高價 58.2 → 股價不漲將下彎（警覺）」
    const turnLines = MA_FORECAST_SET
      .map(({ n }) => formatMaTurnLine({
        label: MA_PLAIN_LABEL[n] ?? `${n}日線`,
        closes, maN: n, asOf,
        maxLookahead: Math.min(n, MA_TURN_LOOKAHEAD),
        dates,
      }))
      .filter((l): l is NonNullable<typeof l> => l != null);

    // 使用者指定重點：季線何時開始向上、短中線三線多排、四線多排是否能穩定維持。
    // 完整扣抵窗仍只是假設「未來收盤維持今收」的情境，不是行情預測。
    const ma60Rise = daysUntilMaRises(closes, 60, asOf, 60);
    const tripleAlignment = daysUntilBullishAlignment(closes, [5, 10, 20], asOf, 20);
    const allRise = forecastAllMaRising(closes, [5, 10, 20, 60], asOf, 10);
    const forecastDates = new Map<number, string>();
    for (let day = 1; day <= 20; day++) {
      const knownReplayDate = candles[asOf + day]?.date?.slice(0, 10);
      const estimatedDate = knownReplayDate ?? tradingDateAfter(dates[asOf], day, market);
      if (estimatedDate) forecastDates.set(day, estimatedDate);
    }
    const futureDividendEvents = dividendEvents.filter(event => event.exDate > asOfDate);
    const scenarioFutureCloses = (dailyReturn: number) => Array.from({ length: 20 }, (_, offset) => {
      const day = offset + 1;
      const date = forecastDates.get(day);
      const dividend = date ? cumulativeCashDividend(futureDividendEvents, date) : 0;
      return Math.max(0.01, today * ((1 + dailyReturn) ** day) - dividend);
    });
    const fourLineAlignment = forecastBullishAlignmentDurability(
      closes, [5, 10, 20, 60], asOf,
      { maxLookahead: 20, requiredConsecutiveDays: 3, futureCloses: scenarioFutureCloses(0) },
    );
    const fourLineScenarios = [0.0025, 0.005, 0.01].map(dailyReturn => ({
      dailyReturn,
      forecast: forecastBullishAlignmentDurability(
        closes, [5, 10, 20, 60], asOf,
        { maxLookahead: 20, dailyReturn, requiredConsecutiveDays: 3, futureCloses: scenarioFutureCloses(dailyReturn) },
      ),
    }));

    const nextUp = states.filter(state => state.nextDirection === 'up').length;
    const nextDown = states.filter(state => state.nextDirection === 'down').length;
    const ma20State = stateByPeriod.get(20);
    const ma60State = stateByPeriod.get(60);
    const ma60PressureJump = ma60State?.nextDirection === 'down'
      && (ma60State.changePercentile ?? 0) >= 0.75;
    const deductionSummary = nextUp === states.length
      ? '若明天收在今收附近，四條均線都會往上彎'
      : nextDown === states.length
        ? '若明天收在今收附近，四條均線都會往下彎'
        : ma20State?.nextDirection === 'up' && ma60State?.nextDirection === 'down'
          ? `月線會上彎、季線會下彎${ma60PressureJump ? '；季線明天扣得更高，長線較吃力' : '；長短線互相抵消'}`
          : ma20State?.nextDirection === 'down' && ma60State?.nextDirection === 'up'
            ? '月線會下彎、季線會上彎；短中線仍較吃力'
            : nextUp > nextDown
              ? '往上彎的均線較多，但四條線方向仍不一致'
              : nextDown > nextUp
                ? '往下彎的均線較多，短線結構較吃力'
                : '兩條上彎、兩條下彎，方向互相抵消';

    const maLevels = MA_FORECAST_SET.flatMap(({ n, label }) => {
      const value = candles[asOf]?.[`ma${n}` as keyof CandleWithIndicators];
      return typeof value === 'number' && Number.isFinite(value) ? [{ n, label, value }] : [];
    });
    const supports = maLevels.filter(level => level.value <= today).sort((a, b) => b.value - a.value);
    const pressures = maLevels.filter(level => level.value > today).sort((a, b) => a.value - b.value);
    const averageSupport = supports.length > 0
      ? supports.reduce((sum, level) => sum + level.value, 0) / supports.length
      : null;
    const averagePressure = pressures.length > 0
      ? pressures.reduce((sum, level) => sum + level.value, 0) / pressures.length
      : null;

    // 黃金交叉只估近窗 5 根（凍結價假設往後不可靠）
    const gc5x20 = daysUntilGoldenCross(closes, 5, 20, asOf, 5);

    if (rows.length === 0) return null;
    return {
      today, rows, turnLines, ma60Rise, tripleAlignment, fourLineAlignment, fourLineScenarios, allRise, gc5x20,
      nextUp, nextDown, deductionSummary, supports, pressures, averageSupport, averagePressure, forecastDates,
    };
  }, [asOfDate, candles, dividendEvents, index, market]);

  if (!view) return null;

  // asOf 當天若已除息，今收已是除息後價格，不能再重複扣一次；只調整尚未發生的事件。
  const futureDividendEvents = dividendEvents.filter(event => event.exDate > asOfDate);
  const thresholdForForecastDay = (day: { daysAhead: number; knownThreshold: number }) => {
    const date = view.forecastDates.get(day.daysAhead);
    return date
      ? cashDividendAdjustedThreshold(day.knownThreshold, futureDividendEvents, date)
      : day.knownThreshold;
  };
  const dividendForForecastDay = (daysAhead: number) => {
    const date = view.forecastDates.get(daysAhead);
    return date ? cumulativeCashDividend(futureDividendEvents, date) : 0;
  };
  const firstExactAtAdjustedPrice = view.allRise.exactDays.find(
    day => view.today > thresholdForForecastDay(day),
  ) ?? null;
  const conditionalDay = view.allRise.firstConditionalNearCurrentPrice;
  const nextAllRiseThreshold = view.allRise.nextDay
    ? thresholdForForecastDay(view.allRise.nextDay)
    : null;
  const nextAllRiseRawThreshold = view.allRise.nextDay?.knownThreshold ?? null;
  const nextAllRiseGap = nextAllRiseThreshold == null ? null : nextAllRiseThreshold - view.today;
  const nextAllRiseGapPct = nextAllRiseGap == null ? null : nextAllRiseGap / view.today;
  const nextAllRiseLeader = view.allRise.nextDay?.limitingPeriods
    .map(period => `${MA_PLAIN_LABEL[period] ?? `MA${period}`}（MA${period}）`)
    .join('、') ?? '';
  const allRiseCard = view.allRise.nextDay
    && nextAllRiseThreshold != null
    && nextAllRiseRawThreshold != null
    && nextAllRiseGap != null
    && nextAllRiseGapPct != null ? (
      <div className="rounded-md border border-amber-400/25 bg-amber-400/5 px-2 py-1.5 space-y-0.5">
        <p className="text-[11px] leading-relaxed text-foreground/85">
          <span className="font-bold">明天能否四線一起上彎？</span>
        </p>
        {nextAllRiseGap < 0 ? (
          <p className="text-[11px] leading-relaxed text-rose-300/90">
            可以。今收 {view.today.toFixed(2)} 已高於門檻 {nextAllRiseThreshold.toFixed(2)}，明天守住即可。
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-amber-200/90">
            要收過 {nextAllRiseThreshold.toFixed(2)}；比今收還差 {nextAllRiseGap.toFixed(2)}（{(nextAllRiseGapPct * 100).toFixed(1)}%）。
            {nextAllRiseGapPct > 0.1 ? '短期很難。' : nextAllRiseGapPct > 0.03 ? '門檻偏高。' : '已經接近。'}
          </p>
        )}
        <p className="text-[10px] leading-relaxed text-muted-foreground/75">
          主因：{nextAllRiseLeader}明天拿掉舊價 {nextAllRiseRawThreshold.toFixed(2)}。
          這是均線轉向門檻，不是股價壓力位。
          {dividendForForecastDay(view.allRise.nextDay.daysAhead) > 0 && ` 除息後門檻為 ${nextAllRiseThreshold.toFixed(2)}。`}
        </p>
      </div>
    ) : null;

  return (
    <div className={embedded ? 'space-y-1' : 'pt-2 border-t border-border/20 space-y-1'}>
      {!embedded && (
        <p className="text-[11px] leading-relaxed">
          <span
            className="text-muted-foreground"
            title="均線每天會拿掉一筆舊收盤，再加入最新收盤。新收盤較高，均線上彎；較低，均線下彎。"
          >均線預測</span>
          <span className="ml-2 text-muted-foreground/60">扣抵推估</span>
        </p>
      )}

      <div className="space-y-0.5">
        {dividendEvents.length > 0 && (
          <div className="mb-1.5 rounded-md border border-amber-400/25 bg-amber-400/5 px-2.5 py-2 space-y-0.5">
            {dividendEvents.map(event => (
              <div key={event.exDate}>
                <p className="text-[11px] leading-relaxed text-amber-200/90">
                  <span className="font-bold">事件提醒</span>
                  <span className="ml-1.5">
                    {shortDate(event.exDate)} 除息 {event.cashDividend.toFixed(2)} 元
                    {event.paymentDate ? ` · ${shortDate(event.paymentDate)} 發放` : ''}
                  </span>
                </p>
                <p className="text-[10px] leading-relaxed text-muted-foreground/65">
                  除息參考價約前收減 {event.cashDividend.toFixed(2)}；這是機械性下調，不等於賣壓，也不是免費報酬。
                </p>
                {tradingDateBefore(event.exDate, market) && (
                  <p className="text-[10px] leading-relaxed text-muted-foreground/65">
                    若要參與股息，須在 {shortDate(tradingDateBefore(event.exDate, market))} 收盤前持有。
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mb-1.5 rounded-md border border-border/35 bg-muted/15 px-2.5 py-2 space-y-1">
          <p className="text-[11px] leading-relaxed text-foreground/85">
            <span className="font-bold">先看結論</span>
            <span className="ml-1.5">{view.deductionSummary}</span>
          </p>
          <p className="text-[10px] leading-relaxed text-muted-foreground/65">
            明天：{view.nextUp} 條上彎 · {view.nextDown} 條下彎。只看均線，不代表股價一定漲跌。
          </p>
          {(view.supports.length > 0 || view.pressures.length > 0) && (
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              {view.supports.length > 0 && (
                <span>
                  均線支撐 {view.supports.map(level => `${level.label} ${level.value.toFixed(2)}`).join(' · ')}
                </span>
              )}
              {view.supports.length > 0 && view.pressures.length > 0 && <span className="mx-1.5">｜</span>}
              {view.pressures.length > 0 && (
                <span>
                  均線壓力 {view.pressures.map(level => `${level.label} ${level.value.toFixed(2)}`).join(' · ')}
                </span>
              )}
            </p>
          )}
          {(view.averageSupport != null || view.averagePressure != null) && (
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              均線平均：
              {view.averageSupport != null && <span> 支撐 {view.averageSupport.toFixed(2)}</span>}
              {view.averageSupport != null && view.averagePressure != null && <span className="mx-1.5">｜</span>}
              {view.averagePressure != null && <span>壓力 {view.averagePressure.toFixed(2)}</span>}
              <span className="ml-1.5 text-muted-foreground/45">（參考值，不是買賣點）</span>
            </p>
          )}
        </div>

        {allRiseCard}

        <p className="pt-1 text-[10px] font-semibold text-muted-foreground/75">各線明天方向</p>

        {view.rows.map(r => {
          const dir = r.turn.direction;
          const dirText = dir === 'up' ? '明天上彎' : dir === 'down' ? '明天下彎' : '明天走平';
          // 紅漲綠跌（台股慣例）：上揚紅、下彎綠
          const dirColor = dir === 'up' ? 'text-rose-300' : dir === 'down' ? 'text-emerald-300' : 'text-muted-foreground';
          const pressureChange = r.state?.deductChange != null && r.state.deductChange > 0
            && (r.state.changePercentile ?? 0) >= 0.75;
          const reliefChange = r.state?.deductChange != null && r.state.deductChange < 0
            && (r.state.changePercentile ?? 1) <= 0.25;
          return (
            <p key={r.n} className="text-[11px] leading-relaxed flex items-baseline gap-x-1.5 flex-wrap">
              <span className="text-foreground/70 font-mono shrink-0">
                {r.label}{r.n === 20 ? '（月）' : r.n === 60 ? '（季）' : ''}
              </span>
              {r.state?.currentDeductPrice != null && (
                <>
                  <span className="text-muted-foreground/55">舊價：今天</span>
                  <span className="font-mono text-foreground/65">{r.state.currentDeductPrice.toFixed(2)}</span>
                  <span className="text-muted-foreground/35">→</span>
                </>
              )}
              <span className="text-muted-foreground/70">明天</span>
              <span className="font-mono text-foreground/80">{(r.deduct as number).toFixed(2)}</span>
              <span className={`font-bold ${dirColor}`}>{dirText}</span>
              {pressureChange && (
                <span className="text-amber-300/85">舊價大幅變高，較難上彎</span>
              )}
              {reliefChange && (
                <span className="text-rose-300/80">舊價大幅變低，較容易上彎</span>
              )}
            </p>
          );
        })}

        {/* 白話結論句（課程 CH3-2「未卜先知」）：哪條均線、幾天後、扣哪天的什麼價 → 會怎樣 */}
        {view.turnLines.map(line => (
          <p
            key={line.text}
            className={`text-[11px] leading-relaxed ${line.tone === 'warn' ? 'text-amber-300/90' : 'text-rose-300/90'}`}
          >
            {line.text}
          </p>
        ))}

        {/* 使用者指定重點：助漲門檻、MA60 翻揚，以及三線／四線多排的完整情境推估 */}
        <div className="mt-1.5 space-y-0.5 border-t border-border/25 pt-1.5">
          {view.allRise.exactDays.length > 1 && (
            <details className="group/future rounded-md border border-border/25 bg-muted/5">
              <summary className="cursor-pointer list-none px-2 py-1 text-[10px] font-medium text-muted-foreground/75 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
                查看未來 {view.allRise.exactDays.length} 日門檻
                <span className="ml-1 text-muted-foreground/55 group-open/future:hidden">＋</span>
                <span className="ml-1 hidden text-muted-foreground/55 group-open/future:inline">－</span>
              </summary>
              <p className="border-t border-border/20 px-2 py-1 text-[10px] leading-relaxed text-muted-foreground/70">
                {view.allRise.exactDays.map(day => {
                  const date = shortDate(view.forecastDates.get(day.daysAhead) ?? null);
                  const dividend = dividendForForecastDay(day.daysAhead);
                  const threshold = thresholdForForecastDay(day);
                  return `${date ?? `${day.daysAhead}日後`} >${threshold.toFixed(2)}${dividend > 0 ? '（除息後）' : ''}`;
                }).join(' · ')}
              </p>
            </details>
          )}

          {firstExactAtAdjustedPrice ? (
            <p className="text-[11px] leading-relaxed text-rose-300/85">
              若維持今收，約 {firstExactAtAdjustedPrice.daysAhead} 日後四線可一起上彎。
            </p>
          ) : conditionalDay ? (
            <p className="text-[11px] leading-relaxed text-sky-300/85">
              較早機會約在
              {shortDate(view.forecastDates.get(conditionalDay.daysAhead) ?? null)
                ? ` ${shortDate(view.forecastDates.get(conditionalDay.daysAhead) ?? null)}`
                : ` ${conditionalDay.daysAhead} 個交易日後`}
              ：收盤須高於 {thresholdForForecastDay(conditionalDay).toFixed(2)}，
              也須高於{conditionalDay.unknownPeriods.map(n => `${n}日前收盤`).join('、')}。
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground/55">
              若維持今收，10 日內四線仍難一起上彎。
            </p>
          )}

          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            <span className="text-foreground/70">季線轉上</span>
            {view.ma60Rise.alreadyRising ? (
              <span className="ml-1.5 text-rose-300/90">目前已向上</span>
            ) : view.ma60Rise.days != null ? (
              <>
                <span className="ml-1.5 text-amber-300/90">若維持今收，約 {view.ma60Rise.days} 日後</span>
                {view.ma60Rise.deductPrice != null && (
                  <span className="ml-1.5 text-muted-foreground/45">（屆時拿掉舊價 {view.ma60Rise.deductPrice.toFixed(2)}）</span>
                )}
              </>
            ) : (
              <span className="ml-1.5 text-muted-foreground/55">若維持今收，60 日內不會轉上</span>
            )}
          </p>

          <div className="rounded-md border border-border/30 bg-muted/10 px-2 py-1.5 space-y-0.5">
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              <span className="text-foreground/75">四線多排（5 &gt; 10 &gt; 20 &gt; 60）</span>
              {view.fourLineAlignment.alreadyAligned ? (
                <span className="ml-1.5 text-rose-300/90">現在已形成</span>
              ) : view.fourLineAlignment.firstAlignedDay != null ? (
                <span className="ml-1.5 text-amber-300/90">
                  若維持今收，約 {shortDate(view.forecastDates.get(view.fourLineAlignment.firstAlignedDay) ?? null)
                    ?? `${view.fourLineAlignment.firstAlignedDay} 日後`}形成
                </span>
              ) : (
                <span className="ml-1.5 text-muted-foreground/55">若維持今收，20 日內不會形成</span>
              )}
            </p>
            {view.fourLineAlignment.firstAlignedDay != null && view.fourLineAlignment.firstRunLength < 3 && (
              <p className="text-[10px] leading-relaxed text-amber-300/80">
                只能維持 {view.fourLineAlignment.firstRunLength} 日
                {view.fourLineAlignment.firstBreakDay != null
                  ? `；${shortDate(view.forecastDates.get(view.fourLineAlignment.firstBreakDay) ?? null) ?? `${view.fourLineAlignment.firstBreakDay} 日後`}失效`
                  : ''}。
              </p>
            )}
            {view.fourLineAlignment.firstDurableDay === 0 ? (
              <p className="text-[10px] leading-relaxed text-rose-300/80">
                若維持今收，至少還能維持 3 日。
              </p>
            ) : view.fourLineAlignment.firstDurableDay != null ? (
              <p className="text-[10px] leading-relaxed text-rose-300/80">
                若維持今收，約 {shortDate(view.forecastDates.get(view.fourLineAlignment.firstDurableDay) ?? null)
                  ?? `${view.fourLineAlignment.firstDurableDay} 日後`}起可穩定 3 日。
              </p>
            ) : (
              <p className="text-[10px] leading-relaxed text-muted-foreground/60">
                若維持今收，20 日內無法穩定 3 日。
              </p>
            )}
            <details className="group/scenario">
              <summary className="cursor-pointer list-none text-[10px] text-sky-300/80 outline-none hover:text-sky-200 focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
                查看不同漲幅情境
                <span className="ml-1 group-open/scenario:hidden">＋</span>
                <span className="ml-1 hidden group-open/scenario:inline">－</span>
              </summary>
              <p className="pt-0.5 text-[10px] leading-relaxed text-sky-300/75">
                {view.fourLineScenarios.map(({ dailyReturn, forecast }) => {
                  const date = forecast.firstDurableDay == null
                    ? null
                    : shortDate(view.forecastDates.get(forecast.firstDurableDay) ?? null);
                  return `日漲 ${(dailyReturn * 100).toFixed(2)}%：${forecast.firstDurableDay === 0 ? '目前可維持' : date ?? (forecast.firstDurableDay == null ? '20日內無' : `${forecast.firstDurableDay}日後`)}`;
                }).join(' · ')}
              </p>
            </details>
            <p className="text-[10px] leading-relaxed text-muted-foreground/65">
              多排＝位置排好；一起上彎＝方向向上。兩者不同。
            </p>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            <span className="text-foreground/70">三線多排（5／10／20）</span>
            {view.tripleAlignment.alreadyAligned ? (
              <span className="ml-1.5 text-rose-300/90">現在已形成</span>
            ) : view.tripleAlignment.days != null ? (
              <span className="ml-1.5 text-amber-300/90">若維持今收，約 {view.tripleAlignment.days} 日後形成</span>
            ) : (
              <span className="ml-1.5 text-muted-foreground/55">若維持今收，20 日內不會形成</span>
            )}
          </p>
        </div>

        {/* 5×20 黃金交叉預測（近窗）*/}
        {view.gc5x20.alreadyAbove ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            <span className="text-foreground/70">5日線／月線</span>
            <span className="ml-1.5 text-rose-300/90">5日線已在月線之上</span>
          </p>
        ) : view.gc5x20.days != null ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            <span className="text-foreground/70">5日線／月線</span>
            <span className="ml-1.5 text-amber-300/90">約 {view.gc5x20.days} 日內可能黃金交叉</span>
            <span className="ml-1.5 text-muted-foreground/45">（{view.gc5x20.trend === 'converging' ? '正在靠近' : view.gc5x20.trend === 'diverging' ? '仍在遠離' : '持平'}）</span>
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground/55">
            <span className="text-foreground/60">5日線／月線</span>
            <span className="ml-1.5">近 5 日內無黃金交叉跡象</span>
          </p>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
        假設股價維持今收；越往後越不準，不能單獨當買賣訊號。
      </p>
    </div>
  );
}

// ── 子元件：持倉診斷（持股中模式）─────────────────────────────────────────
// 動態停損（跟著操作均線走）+ 10% 紀律停利線
// 不顯示「進場價/停損」這兩個試算行 — 持股者不需要被叫去加碼

function HoldingDiscipline({
  candle, operatingMA, profitLine, profitLineReached, profitLineSource,
}: {
  candle: CandleWithIndicators;
  operatingMA: string | null;
  profitLine: number | null;
  profitLineReached: boolean;
  profitLineSource: 'entry-pattern' | 'rule';
}) {
  const formatDistance = (value: number) => {
    const absolute = Math.abs(value);
    return absolute > 0 && absolute < 0.1 ? absolute.toFixed(2) : absolute.toFixed(1);
  };

  return (
    <div className="space-y-1 text-xs leading-relaxed">
      <p className="text-[11px] text-muted-foreground/80">持倉中守則：</p>

      {/* 動態停損 — 跌破操作均線出場 */}
      {operatingMA && (() => {
        const maKey = operatingMA.toLowerCase() as 'ma5' | 'ma10' | 'ma20' | 'ma60' | 'ma240';
        const maVal = (candle as unknown as Record<string, number | undefined>)[maKey];
        if (maVal == null) return null;
        const maPct = ((maVal - candle.close) / candle.close) * 100;
        const breached = candle.close < maVal;
        return (
          <p className={breached
            ? 'rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1.5 text-emerald-200'
            : 'text-foreground/80'}>
            <span
              className={breached ? 'font-bold text-emerald-200' : 'font-bold text-foreground/85'}
              title="進場後持倉期間，跌破此均線才出場（書本：跟著均線走，動態跟蹤停損）"
            >{breached ? '已跌破' : '動態停損'}</span>
            <span className="ml-2">{operatingMA}</span>
            <span className="ml-1.5 font-mono font-bold">{maVal.toFixed(2)}</span>
            <span className="ml-1.5 text-muted-foreground/75">
              {breached ? `低於 ${formatDistance(maPct)}% · 出場` : `距停損 ${formatDistance(maPct)}%`}
            </span>
          </p>
        );
      })()}

      {/* 10% 紀律停利線（或型態目標）*/}
      {profitLine != null && (
        <p className="text-rose-300">
          <span className="font-bold">停利目標</span>
          <span className="ml-2 font-mono font-bold">{profitLine.toFixed(2)}</span>
          <span className="ml-1.5 text-muted-foreground/70">
            {profitLineReached
              ? `已超過 ${formatDistance((candle.close - profitLine) / profitLine * 100)}%`
              : `距目標 +${formatDistance((profitLine - candle.close) / candle.close * 100)}%`}
          </span>
          <span className="ml-2 text-[11px] text-muted-foreground/60">
            {profitLineSource === 'entry-pattern' ? '進場型態快照' : '10%紀律'}
          </span>
          {profitLineReached && (
            <span className="ml-2 text-[11px] font-bold text-amber-300">
              改守動態停損
            </span>
          )}
        </p>
      )}
    </div>
  );
}

// ── 子元件：CH8 8-5 三條均線分批出場（選用「賠少」模式，純顯示）────────────
// 課程 CH8-5：部位拆 3 份，跌破 MA5/10/20 各出 1/3、站回各買 1/3。
// 回測定位＝控回撤工具（賠少），非賺最多；不改既有動態停損/停利，只多給一個參考。
function PartialExitMini({ state }: { state: PartialExitState }) {
  const { unitsHeld, totalUnits, todayAction, ended, endReason, ladder } = state;
  // 終止事件（exit-all）的日期 — 給「已結束」時顯示是哪天、為何結束
  const endEvent = ended ? [...ladder].reverse().find(l => l.action === 'exit-all') : null;
  const endWhy = endReason === 'stop-loss' ? '觸 −5% 停損'
    : endReason === 'full-take-profit' ? '賺超過 20% 又跌破 MA5 → 總停利'
    : endReason === 'trend-broken' ? '均線多頭排列被破壞（趨勢改變）'
    : '全部出場';
  // 一天可連破兩條線（如同日跌破 MA5+MA10 → 出 2 份），賣/買份數要用前一日差值算
  const prevUnits = ladder.length >= 2 ? ladder[ladder.length - 2].unitsHeld : totalUnits;
  const deltaUnits = Math.abs(unitsHeld - prevUnits);
  const actionText = ended
    ? '模型已結束'
    : todayAction === 'sell-third' ? `跌破均線 → 賣 ${deltaUnits}/${totalUnits}（剩 ${unitsHeld}/${totalUnits}）`
    : todayAction === 'buy-third' ? `站回均線 → 買回 ${deltaUnits}/${totalUnits}（持有 ${unitsHeld}/${totalUnits}）`
    : todayAction === 'flat' ? '已空手'
    : `續抱 ${unitsHeld}/${totalUnits}`;
  const display = resolvePartialExitDisplay({
    ended,
    endDate: endEvent?.date,
    endWhy,
    currentAction: actionText,
  });
  const tone = display.historical ? 'text-amber-200'
    : todayAction === 'sell-third' ? 'text-amber-300'
    : todayAction === 'buy-third' ? 'text-emerald-300'
    : 'text-muted-foreground';
  return (
    <div className="mt-2 pt-2 border-t border-border/20 space-y-1 text-xs leading-relaxed">
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-bold text-sky-300"
          title="課程 CH8-5 三條均線分批法（選用）：部位拆 3 份，收盤跌破 MA5/10/20 各賣 1/3、站回各買回 1/3。回測顯示這是「少賠/控回撤」工具，不是賺最多的工具，僅供參考，不取代上面的動態停損。"
        >{display.title}</span>
        <span className="flex gap-0.5" title={`目前應持有 ${unitsHeld}/${totalUnits} 份`}>
          {Array.from({ length: totalUnits }).map((_, i) => (
            <span key={i} className={`inline-block w-2.5 h-2.5 rounded-sm ${i < unitsHeld ? 'bg-sky-400' : 'bg-foreground/15'}`} />
          ))}
        </span>
      </div>
      <p className={tone}>
        <span className="font-semibold">{display.prefix}：</span>{display.text}
      </p>
    </div>
  );
}

// ── 子元件：若今日進場（試算，未持倉模式）─────────────────────────────────
// 試算進場/停損/停利 — 給「該不該進場」的決策用

function EntryProjection({
  projEntry, projStopLoss, projSlPct, projProfit, projPtPct, projProfitSource,
}: {
  projEntry: number;
  projStopLoss: number;
  projSlPct: number;
  projProfit: number;
  projPtPct: number;
  projProfitSource: 'pattern' | 'rule';
}) {
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      <p className="text-[11px] text-muted-foreground/80">若今日進場（試算）：</p>

      {/* 進場 */}
      <p>
        <span className="text-foreground/80 font-bold">進場</span>
        <span className="ml-2 font-mono font-bold text-foreground">{projEntry.toFixed(2)}</span>
      </p>
      {/* 停損（綠 = 跌）*/}
      <p>
        <span className="text-emerald-300 font-bold">停損</span>
        <span className="ml-2 font-mono text-emerald-300 font-bold">{projStopLoss.toFixed(2)}</span>
        <span className="ml-1.5 font-mono text-muted-foreground/70">({projSlPct.toFixed(1)}%)</span>
      </p>
      {/* 停利（紅 = 漲）*/}
      <p>
        <span className="text-rose-300 font-bold">停利</span>
        <span className="ml-2 font-mono text-rose-300 font-bold">{projProfit.toFixed(2)}</span>
        <span className="ml-1.5 font-mono text-muted-foreground/70">
          ({projPtPct >= 0 ? '+' : ''}{projPtPct.toFixed(1)}%)
        </span>
        <span className="ml-2 text-[11px] text-muted-foreground/60">
          {projProfitSource === 'pattern' ? '型態目標' : '10%紀律'}
        </span>
      </p>
    </div>
  );
}

// ── 子元件：為什麼？分組 ──────────────────────────────────────────────────

function Reasons({
  hasPosition, v12Hits, topPatternHit, entrySigs, exitSigs, warnSigs, criticalProhibitions, todayClose, embedded = false,
}: {
  hasPosition: boolean;
  v12Hits: V12Hit[];
  topPatternHit: TopPatternHit | null;
  entrySigs: RuleSignal[];
  exitSigs: RuleSignal[];
  warnSigs: RuleSignal[];
  criticalProhibitions: string[];
  todayClose: number;
  embedded?: boolean;
}) {
  // 持股中：不顯示「進場依據」（避免暗示加碼）；只顯示出場 + 注意事項 + 結構轉變戒律
  // 未持倉：不顯示「一般出場訊號」（沒倉位談何出場），但頂部型態仍顯示為「不要進場」依據
  const showEntry = !hasPosition && (v12Hits.length > 0 || entrySigs.length > 0);
  const showExit = hasPosition ? (exitSigs.length > 0 || topPatternHit != null) : (topPatternHit != null);
  const showWarn = warnSigs.length > 0;
  // 議題 C3：持股中露結構轉變戒律（戒律 6/7/8）— 趨勢已轉，再不謹慎會被套
  const showCriticalProhibitions = hasPosition && criticalProhibitions.length > 0;

  const empty = !showEntry && !showExit && !showWarn && !showCriticalProhibitions;

  if (empty) return null;

  const hasEntry = showEntry;
  const hasExit = showExit;

  return (
    <div className={embedded ? 'space-y-2' : 'border-t border-border/40 pt-2 space-y-2'}>
      {!embedded && <p className="text-xs font-semibold text-foreground/80">分析</p>}

      {/* 進場依據（V12 字母 + 朱家泓書本規則合併）*/}
      {hasEntry && (
        <div>
          <p className="text-[11px] font-bold mb-1 text-rose-300">進場依據</p>
          <div className="space-y-1.5">
            {/* V12 字母卡片（M/N/O/P/Q）— 用戶 PS 喜好：trackName 一整行不拆 */}
            {v12Hits.map(h => (
              <div key={h.letter} className="rounded px-2.5 py-2 bg-secondary/30">
                <p className="text-sm font-bold text-foreground/90">{h.trackName}</p>
                <p className="text-[11px] text-foreground/75 leading-relaxed mt-1">{h.detail.replace(/^[A-Z]\s+/, '')}</p>
                {h.patternType && h.patternTargetPrice && h.necklinePrice && (
                  <div className="mt-1.5 pt-1.5 border-t border-border/30 space-y-0.5 text-[11px]">
                    <div className="flex items-baseline justify-between">
                      <span className="text-indigo-300 font-bold">{getPatternDisplayName(h.patternType)}</span>
                      {h.achievementRate != null && (
                        <span className="text-amber-300" title="舊書附錄的歷史達標統計，不是本站回測勝率">舊書達標統計 {(h.achievementRate * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    <div className="flex items-baseline justify-between text-muted-foreground">
                      <span>頸線</span>
                      <span className="font-mono">{h.necklinePrice.toFixed(2)}</span>
                    </div>
                    <div className="flex items-baseline justify-between text-emerald-400">
                      <span>突破後測量目標</span>
                      <span className="font-mono">
                        {h.patternTargetPrice.toFixed(2)} ({((h.patternTargetPrice - todayClose) / todayClose * 100).toFixed(1)}%)
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {/* 朱家泓書本進場規則（朱SOP / 回檔再上漲 / 均線撐漲 / 下缺回補等）— 用戶 PS 喜好：暗紅紫底區分書本規則 */}
            {entrySigs.map(s => (
              <ReasonRow key={`entry-${s.type}-${s.ruleId}-${s.label}`} signal={s} bgColor="bg-rose-900/15" />
            ))}
          </div>
        </div>
      )}

      {/* 出場警示（持股中=該出場理由；未持倉=只顯示頂部型態作為「不要進場」依據）*/}
      {hasExit && (
        <div>
          <p className="text-[11px] font-bold mb-1 text-emerald-300">
            {hasPosition ? '出場警示' : '禁止做多依據'}
          </p>
          <div className="space-y-1.5">
            {/* 頂部型態（持股=該出場、未持倉=不要進場）*/}
            {topPatternHit && (
              <div className="rounded px-2.5 py-2 bg-rose-900/15">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-xs font-bold text-rose-300">{getPatternDisplayName(topPatternHit.patternType)}</span>
                  {topPatternHit.achievementRate != null && (
                    <span className="text-[11px] text-amber-300" title="舊書附錄的歷史達標統計，不是本站回測勝率">舊書達標統計 {(topPatternHit.achievementRate * 100).toFixed(0)}%</span>
                  )}
                </div>
                <div className="space-y-0.5 text-[11px]">
                  {topPatternHit.necklinePrice != null && (
                    <div className="flex items-baseline justify-between text-muted-foreground">
                      <span>頸線</span>
                      <span className="font-mono">{topPatternHit.necklinePrice.toFixed(2)}</span>
                    </div>
                  )}
                  {topPatternHit.patternTargetPrice != null && (
                    <div className="flex items-baseline justify-between text-rose-300">
                      <span>跌破後測量目標</span>
                      <span className="font-mono">
                        {topPatternHit.patternTargetPrice.toFixed(2)} ({((topPatternHit.patternTargetPrice - todayClose) / todayClose * 100).toFixed(1)}%)
                      </span>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-foreground/70 leading-relaxed mt-1.5 pt-1.5 border-t border-rose-700/30">
                  {topPatternHit.detail}
                </p>
                <p className="text-[11px] text-muted-foreground/60 mt-1">書本：見頂部型態+跌破頸線即出場</p>
              </div>
            )}
            {/* 一般出場訊號 — 只在持股中顯示 */}
            {hasPosition && exitSigs.map(s => (
              <ReasonRow key={`exit-${s.type}-${s.ruleId}-${s.label}`} signal={s} bgColor="bg-emerald-900/15" />
            ))}
          </div>
        </div>
      )}

      {/* 議題 C3：結構轉變戒律 — 持股中才顯示（戒律 6/7/8），其餘戒律詳見「條件」分頁 */}
      {showCriticalProhibitions && (
        <div>
          <p className="text-[11px] font-bold mb-1 text-amber-300">結構轉變警示</p>
          <div className="space-y-0.5">
            {criticalProhibitions.slice(0, 3).map((p, i) => (
              <div
                key={`crit-${i}`}
                className="text-[11px] px-2 py-1 rounded bg-amber-900/25 text-amber-200/90 leading-relaxed"
              >
                {p}
              </div>
            ))}
            {criticalProhibitions.length > 3 && (
              <p className="text-[10px] text-muted-foreground/70 italic">
                （顯示前 3 條，共 {criticalProhibitions.length} 條 — 完整清單見「條件」分頁）
              </p>
            )}
            <p className="text-[10px] text-muted-foreground/60 leading-relaxed pt-0.5">
              書本：結構轉變（戒律 6/7/8）/ 高位過熱（戒律 9）— 已持股應緊盯停損或考慮停利。
            </p>
          </div>
        </div>
      )}

      {/* 注意事項（非進出場，但需注意）*/}
      {warnSigs.length > 0 && (
        <ReasonGroup
          title="注意事項"
          color="text-yellow-300"
          bgColor="bg-yellow-900/15"
          signals={warnSigs}
        />
      )}
    </div>
  );
}

function ReasonRow({ signal: s, bgColor }: { signal: RuleSignal; bgColor: string }) {
  const override = SIGNAL_EXPLAIN[s.label];
  const mainText = override ?? s.description ?? '';
  const bookRef = override ? undefined : extractBookRef(s.reason);
  const operationHint = override ? undefined : extractOperationHint(s.reason);
  const nextDayHint = extractNextDayHint(s.reason); // 變盤線家族「明日怎麼辦」— 不因 override 而隱藏
  return (
    <div className={`rounded px-2.5 py-2 ${bgColor}`}>
      <p className="text-sm font-bold text-foreground/90">{s.label}</p>
      {mainText && (
        <p className="text-[11px] text-foreground/85 leading-snug mt-1 break-words">
          {mainText}
        </p>
      )}
      {nextDayHint && (
        <p className="text-[11px] leading-snug mt-1 break-words px-1.5 py-1 rounded bg-amber-900/30 text-amber-200">
          次日：{nextDayHint}
        </p>
      )}
      {operationHint && (
        <p className="text-[11px] text-foreground/70 leading-snug mt-1 break-words">
          {operationHint}
        </p>
      )}
      {bookRef && (
        <p className="text-[11px] text-muted-foreground/60 leading-snug mt-1 break-words">
          {bookRef}
        </p>
      )}
    </div>
  );
}

function ReasonGroup({
  title, color, bgColor, signals,
}: {
  title: string;
  color: string;
  bgColor: string;
  signals: RuleSignal[];
}) {
  return (
    <div>
      <p className={`text-[11px] font-bold mb-1 ${color}`}>{title}</p>
      <div className="space-y-1.5">
        {signals.map(s => (
          <ReasonRow key={`${s.type}-${s.ruleId}-${s.label}`} signal={s} bgColor={bgColor} />
        ))}
      </div>
    </div>
  );
}

/** 從 reason 抓【...】書本根據（保留括號）— 顯示在最末行 */
function extractBookRef(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const m = reason.match(/【[^】]+】/);
  return m?.[0];
}

/** 從 reason 抓「操作：...」實戰建議 — 顯示在描述底下 */
function extractOperationHint(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  // 匹配「操作：」或「策略：」開頭的 1-2 句
  const m = reason.match(/(?:操作|策略|建議)[：:]\s*([^\n。]+(?:。[^\n。]{0,40})?)/);
  return m?.[1] ? `操作：${m[1].trim()}` : undefined;
}

/**
 * 課程 CH2 訊號教學化（2026-07-05）：從 reason 抓「明日/次日 怎麼辦」那一行 —
 * 變盤線家族的核心可操作資訊（開低出場/開高續抱＋關鍵價位），highlight 顯示。
 */
function extractNextDayHint(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const line = reason.split('\n').find(l => /(明日|次日)[^\n]*(確認|開低|開高|開盤)/.test(l));
  return line?.trim();
}
