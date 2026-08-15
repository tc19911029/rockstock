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
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import { detectLetterN, detectTopPatterns, type TopPatternType } from '@/lib/analysis/v12LetterN';
import { detectLetterO } from '@/lib/analysis/v12LetterO';
import { detectLetterP } from '@/lib/analysis/v12LetterP';
import { detectLetterQ } from '@/lib/analysis/v12LetterQ';
import { STOP_LOSS_PRICE_MULT, PROFIT_TARGET_PRICE_MULT } from '@/lib/analysis/bookThresholds';
import { deductPrice, daysUntilMaTurn, daysUntilGoldenCross, formatMaTurnLine, MA_PLAIN_LABEL } from '@/lib/analysis/maDeduction';
import type { V12Letter } from '@/lib/analysis/v12Signals';
import type { RuleSignal, CandleWithIndicators } from '@/types';
import { getPatternDisplayName } from '@/lib/chart/patternDisplay';
import { analyzeKLineSignals, isKLineSignal } from '@/lib/rules/klineSignalAnalysis';
import { pickHoldingRiskProhibitions } from '@/lib/rules/prohibitionRelevance';
import type { PatternSignal } from '@/lib/rules/winnerPatternRules';
import { buildChartNarrative } from '@/lib/narrative/buildChartNarrative';
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

const V12_TRACK_BADGE: Record<EntryLetter, string> = {
  M: 'bg-red-700/70 text-red-100',
  N: 'bg-blue-700/70 text-blue-100',
  O: 'bg-blue-700/70 text-blue-100',
  P: 'bg-red-700/70 text-red-100',
  Q: 'bg-purple-700/70 text-purple-100',
};

const TOP_PATTERN_LABEL: Record<TopPatternType, string> = {
  'head-shoulder-top': '頭肩頂',
  'triple-top': '三重頂',
  'double-top': '雙重頂',
  'complex-head-shoulder-top': '複式頭肩頂',
  'inverted-n-top': '倒N字頂',
  'long-double-top': '長雙頭頂',
  'one-line-top': '一字頂',
};

/** V12 字母解釋（hover tooltip 顯示）— 用於「操作均線」行的字母 underline */
const V12_LETTER_DESC: Record<string, string> = {
  A: 'A 六條件 — 純結構過濾池',
  B: 'B 回後買上漲 — 多頭回檔站回 MA5',
  C: 'C 盤整突破',
  D: 'D 一字底（均線糾結）',
  E: 'E 跳空缺口進場',
  F: 'F V 形反轉（變盤線止跌）',
  G: 'G ABC 突破',
  H: 'H 過大量黑K高',
  I: 'I K 線橫盤突破',
  J: 'J ABC 突破（v12 多頭軌）',
  K: 'K K 線橫盤突破（v12 多頭軌）',
  L: 'L 過大量黑K（v12 多頭軌）',
  M: 'M 突破上升軌道線',
  N: 'N 型態確認（書本 25 種型態）',
  O: 'O 打底完成（空頭→多頭）',
  P: 'P 高檔拉回（淺回 1-2 天）',
  Q: 'Q 三條均線戰法（MA3+10+24）',
};

const PATTERN_LABEL: Record<string, string> = {
  'head-shoulder': '頭肩底', 'complex-head-shoulder': '複式頭肩底',
  'triple-bottom': '三重底', 'falling-diamond': '跌菱形',
  'rounding-bottom': '圓弧底', 'descending-wedge': '下降楔形',
  'double-bottom': '雙重底', 'n-shape': 'N 字底',
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
    longProhibitions, winnerPatterns,
  } = useReplayStore();
  const { holdings } = usePortfolioStore();
  // 掃描面板選的策略 — 讓訊號卡的操作 SOP（操作均線/停損停利框架）跟著換
  const activeBuyMethod = useBacktestStore(s => s.activeBuyMethod);

  const candle = allCandles[currentIndex];
  const ticker = currentStock?.ticker ?? '';
  const market = marketFromSymbol(ticker);

  // V12 字母偵測（M/N/O/P/Q）+ 頂部型態（持股中才顯示）
  const [v12Hits, setV12Hits] = useState<V12Hit[]>([]);
  const [topPatternHit, setTopPatternHit] = useState<TopPatternHit | null>(null);
  const v12Market: 'TW' | 'CN' = useMemo(
    () => /\.(SS|SZ)$/i.test(ticker) ? 'CN' : 'TW',
    [ticker],
  );

  useEffect(() => {
    if (!ticker || allCandles.length < 30 || currentIndex < 25) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 條件不足時 reset signals；非 cascading render
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
  // 持股中：比操作均線「短」的跌破均線出場訊號降級為軟出場（緊盯/減碼，不喊該出場）。
  // 例：J（ABC 突破）操作 MA20 — 破 MA5/MA10 只是減碼警示，收盤破 MA20 才是硬出場。
  const MA_RANK: Record<string, number> = { MA3: 1, MA5: 2, MA10: 3, MA20: 4, MA60: 5 };
  const opRank = operatingMA ? (MA_RANK[operatingMA] ?? null) : null;
  const maRankOfSignal = (s: RuleSignal): number | null => {
    const hay = `${s.ruleId} ${s.label} ${s.description ?? ''}`;
    const hits = (['MA60', 'MA20', 'MA10', 'MA5', 'MA3'] as const)
      .filter(m => new RegExp(`${m}(?![0-9])`, 'i').test(hay));
    return hits.length === 1 ? MA_RANK[hits[0]] : null;  // 一次講多條均線的訊號不動
  };
  const classified = currentSignals.map(s => {
    let t = s.subtype ?? classifySignal(s);
    if (hasPosition && opRank != null && t === 'exit_strong') {
      const r = maRankOfSignal(s);
      if (r != null && r < opRank) t = 'exit_soft';
    }
    return { sig: s, subtype: t };
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
    hardRisks: topPatternHit
      ? [`${getPatternDisplayName(topPatternHit.patternType)}跌破頸線：${topPatternHit.detail}`]
      : [],
    operatingMA,
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

          <SignalDisclosure title="均線扣抵預測" meta="MA5 · 10 · 20 · 60">
            <MaDeductionForecast candles={allCandles} index={currentIndex} embedded />
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

function MaDeductionForecast({
  candles, index, embedded = false,
}: {
  candles: CandleWithIndicators[];
  index: number;
  embedded?: boolean;
}) {
  const view = useMemo(() => {
    if (!candles.length) return null;
    const asOf = Math.min(Math.max(index, 0), candles.length - 1);
    const closes = candles.map(c => c.close);
    const today = closes[asOf];
    if (today == null) return null;

    const dates = candles.map(c => c.date);
    const rows = MA_FORECAST_SET.map(({ n, label }) => {
      const dp = deductPrice(closes, n, asOf);
      const turn = daysUntilMaTurn(closes, n, asOf, Math.min(n, MA_TURN_LOOKAHEAD));
      return { n, label, deduct: dp, turn };
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

    // 黃金交叉只估近窗 5 根（凍結價假設往後不可靠）
    const gc5x20 = daysUntilGoldenCross(closes, 5, 20, asOf, 5);

    if (rows.length === 0) return null;
    return { today, rows, turnLines, gc5x20 };
  }, [candles, index]);

  if (!view) return null;

  return (
    <div className={embedded ? 'space-y-1' : 'pt-2 border-t border-border/20 space-y-1'}>
      {!embedded && (
        <p className="text-[11px] leading-relaxed">
          <span
            className="text-muted-foreground"
            title="移動扣抵：N 日均線下一根會丟掉 N 天前的收盤（扣抵值）、補進今收。今收 > 扣抵值 → 均線往上；今收 < 扣抵值 → 往下。純預測提示、不發進出場訊號，未來假設價停在今收、越往後越粗估。"
          >均線預測</span>
          <span className="ml-2 text-muted-foreground/60">扣抵推估</span>
        </p>
      )}

      <div className="space-y-0.5">
        {view.rows.map(r => {
          const dir = r.turn.direction;
          const dirText = dir === 'up' ? '將上揚' : dir === 'down' ? '將下彎' : '走平';
          // 紅漲綠跌（台股慣例）：上揚紅、下彎綠
          const dirColor = dir === 'up' ? 'text-rose-300' : dir === 'down' ? 'text-emerald-300' : 'text-muted-foreground';
          const cmp = view.today > (r.deduct as number) ? '今收高於扣抵' : view.today < (r.deduct as number) ? '今收低於扣抵' : '今收等於扣抵';
          return (
            <p key={r.n} className="text-[11px] leading-relaxed flex items-baseline gap-1.5 flex-wrap">
              <span className="text-foreground/70 font-mono w-9 shrink-0">{r.label}</span>
              <span className="text-muted-foreground/70">扣抵</span>
              <span className="font-mono text-foreground/80">{(r.deduct as number).toFixed(2)}</span>
              <span className={`font-bold ${dirColor}`}>{dirText}</span>
              <span className="text-muted-foreground/45">（{cmp}）</span>
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

        {/* 5×20 黃金交叉預測（近窗）*/}
        {view.gc5x20.alreadyAbove ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            <span className="text-foreground/70">MA5/MA20</span>
            <span className="ml-1.5 text-rose-300/90">短均線已在長均線之上</span>
            <span className="ml-1.5 text-muted-foreground/45">（多頭排列）</span>
          </p>
        ) : view.gc5x20.days != null ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
            <span className="text-foreground/70">MA5/MA20</span>
            <span className="ml-1.5 text-amber-300/90">約 {view.gc5x20.days} 天內可能黃金交叉</span>
            <span className="ml-1.5 text-muted-foreground/45">（{view.gc5x20.trend === 'converging' ? '正在靠近' : view.gc5x20.trend === 'diverging' ? '仍在遠離' : '持平'}）</span>
          </p>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground/55">
            <span className="text-foreground/60">MA5/MA20</span>
            <span className="ml-1.5">近 5 日內無黃金交叉跡象</span>
          </p>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground/45 leading-relaxed">
        粗估提示，假設未來價停在今收；非進出場訊號。
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
