/**
 * Technical Agent — Phase 1 第一個 agent
 *
 * 職責：
 *   1. 從 L4 取 candidateRow（不重算技術指標）
 *   2. 把 candidateRow 的 sixConditionsBreakdown / mtfWeeklyChecks /
 *      eliminationReasons / entryProhibitionReasons 攤平成 BookRuleEntry 清單
 *   3. 從 StrategyThresholds 取重點閾值（不可在 prompt 自創）
 *   4. 寫 technical-question.json → 觸發 /multi-agent-decide skill
 *
 * 紅線（contract 守的）：
 *   - 不在這裡計算任何技術指標（純讀 L4 + StrategyConfig）
 *   - 寫到 question 的 ruleId 必須全在 KNOWN_BOOK_RULE_IDS 集合
 *   - 不調用 LLM SDK；只寫檔
 *
 * 仿範式：lib/ai/zhuPrefetch.ts
 */

import type { ScanSession, StockScanResult } from '@/lib/scanner/types';
import type { StrategyConfig } from '@/lib/strategy/StrategyConfig';
import {
  AGENT_SCHEMA_VERSION,
  BookRuleEntry,
  ELIMINATION_RULE_IDS,
  KNOWN_BOOK_RULE_IDS,
  LONG_PROHIBITION_RULE_IDS,
  MTF_WEEKLY_RULE_IDS,
  SIX_CONDITION_RULE_IDS,
  TechnicalBookRulesRef,
  TechnicalGroundTruth,
  TechnicalQuestion,
} from '@/lib/agents/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import { sliceSourcesForAgent } from '@/lib/agents/candidates/types';

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

export interface BuildTechnicalQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  /** 來自 loadScanSession 的整個 session（給 candidateRow 元資料用）*/
  session: ScanSession;
  /** 在 session.results 中對應的那一筆 */
  candidateRow: StockScanResult;
  /** 目前 active strategy（取 thresholds + ruleGroups）*/
  strategy: StrategyConfig;
  /** P3.5：完整 candidate（會被切片，只塞 technical sources 給 agent）*/
  candidate?: Candidate;
}

/**
 * 建構 TechnicalQuestion — 純函式，不寫檔（寫檔在 orchestrator）
 *
 * 之所以拆出來：方便 contract test + 未來其他 agent 仿照
 */
export function buildTechnicalQuestion(args: BuildTechnicalQuestionArgs): TechnicalQuestion {
  const { runId, date, symbol, session, candidateRow, strategy, candidate } = args;

  const groundTruth: TechnicalGroundTruth = {
    candidateRow,
    mtfMode: session.buyMethod ?? (session.multiTimeframeEnabled ? 'mtf' : 'daily'),
    strategy: strategy.id,
    scanTime: session.scanTime,
    sessionType: session.sessionType,
  };

  const bookRulesRef = extractBookRulesRef(candidateRow);
  validateRuleIds(bookRulesRef);

  const question: TechnicalQuestion = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'technical',
    runId,
    date,
    symbol,
    market: candidateRow.market,
    groundTruth,
    bookRulesRef,
    thresholdsSummary: summariseThresholds(strategy),
  };

  if (candidate) {
    question.entryContext = {
      sources: sliceSourcesForAgent(candidate.sources, 'technical') as Pick<
        Candidate['sources'], 'technical'
      >,
      sourceCount: candidate.sourceCount,
    };
  }

  return question;
}

// ────────────────────────────────────────────────────────────────────────────
// 六條件 / 戒律 / 淘汰法 / MTF 提取
// ────────────────────────────────────────────────────────────────────────────

function extractBookRulesRef(row: StockScanResult): TechnicalBookRulesRef {
  return {
    sixConditions: extractSixConditions(row),
    longProhibitions: extractProhibitions(row),
    eliminations: extractEliminations(row),
  };
}

/**
 * 把 sixConditionsBreakdown 攤平成 6 個 BookRuleEntry（順序固定）
 */
function extractSixConditions(row: StockScanResult): BookRuleEntry[] {
  const b = row.sixConditionsBreakdown;
  const labels: Record<typeof SIX_CONDITION_RULE_IDS[number], string> = {
    'c-trend':     '① 趨勢多頭',
    'c-ma':        '② 均線多排+向上',
    'c-position':  '③ 收盤 > MA10/MA20',
    'c-volume':    '④ 攻擊量 ≥ 1.3 倍',
    'c-kbar':      '⑤ 紅 K 實體+高收',
    'c-indicator': '⑥ KD/MACD 多排',
  };
  return [
    { ruleId: 'c-trend',     label: labels['c-trend'],     triggered: b?.trend ?? false },
    { ruleId: 'c-ma',        label: labels['c-ma'],        triggered: b?.ma ?? false },
    { ruleId: 'c-position',  label: labels['c-position'],  triggered: b?.position ?? false },
    { ruleId: 'c-volume',    label: labels['c-volume'],    triggered: b?.volume ?? false },
    { ruleId: 'c-kbar',      label: labels['c-kbar'],      triggered: b?.kbar ?? false },
    { ruleId: 'c-indicator', label: labels['c-indicator'], triggered: b?.indicator ?? false },
  ];
}

/**
 * 從 entryProhibitionReasons + longProhibitionsReasons 抽 ruleId
 *
 * Reason 字串範例：「戒律8：空頭趨勢下的紅K反彈」「戒律2：上漲第3根勿追高」
 * 用 regex 抓「戒律(\d+)」→ p-NN
 *
 * 沒觸發的戒律也要列（triggered=false），讓 Technical Agent 可以引用「未觸發」作為通過證據
 */
function extractProhibitions(row: StockScanResult): BookRuleEntry[] {
  const reasonsAll = [
    ...(row.entryProhibitionReasons ?? []),
    ...(row.longProhibitionsReasons ?? []),
  ];
  const triggered = new Map<string, string>();
  for (const reason of reasonsAll) {
    const m = reason.match(/戒律\s*(\d+)/);
    if (m) {
      const id = `p-${m[1].padStart(2, '0')}`;
      if (!triggered.has(id)) triggered.set(id, reason);
    }
  }
  return LONG_PROHIBITION_RULE_IDS.map((id) => {
    const hit = triggered.get(id);
    return {
      ruleId: id,
      label: hit ?? labelForProhibition(id),
      triggered: !!hit,
    };
  });
}

function labelForProhibition(id: string): string {
  // P1 簡版 — 戒律全文留待 P4 補
  const map: Record<string, string> = {
    'p-01': '戒律 1',
    'p-02': '戒律 2：上漲第 3 根以上勿追高',
    'p-03': '戒律 3',
    'p-04': '戒律 4',
    'p-05': '戒律 5：未突破月線勿做多（六條件 ③ 已涵蓋）',
    'p-06': '戒律 6',
    'p-07': '戒律 7',
    'p-08': '戒律 8：空頭趨勢紅 K 反彈勿做多',
    'p-09': '戒律 9',
    'p-10': '戒律 10：黑 K 不進場',
  };
  return map[id] ?? id;
}

/**
 * 從 eliminationReasons 抽 ruleId
 *
 * Reason 字串範例：「淘汰1: 尚未走出底部」「淘汰7: 頭頭低+MACD背離」
 */
function extractEliminations(row: StockScanResult): BookRuleEntry[] {
  const reasonsAll = row.eliminationReasons ?? [];
  const triggered = new Map<string, string>();
  for (const reason of reasonsAll) {
    const m = reason.match(/淘汰\s*(\d+)/);
    if (m) {
      const id = `e-${m[1].padStart(2, '0')}`;
      if (!triggered.has(id)) triggered.set(id, reason);
    }
  }
  return ELIMINATION_RULE_IDS.map((id) => {
    const hit = triggered.get(id);
    return {
      ruleId: id,
      label: hit ?? labelForElimination(id),
      triggered: !!hit,
    };
  });
}

function labelForElimination(id: string): string {
  const map: Record<string, string> = {
    'e-01': '淘汰 R1：沒走出底部（均線空排 + 月線下）',
    'e-02': '淘汰 R2：重壓不過跌破 MA5',
    'e-03': '淘汰 R3：上漲一波後趨勢不明',
    'e-04': '淘汰 R4：上漲中量能嚴重萎縮',
    'e-05': '淘汰 R5：大幅上漲 ×1 倍且盤整',
    'e-06': '淘汰 R6：高檔多次大量長黑',
    'e-07': '淘汰 R7：頭頭低 + MACD/KD 背離',
    'e-08': '淘汰 R8：三大法人連續賣超（未實作）',
    'e-09': '淘汰 R9：頻頻爆大量股價不漲',
    'e-10': '淘汰 R10：看不懂的股票（未實作）',
    'e-11': '淘汰 R11：有基本面沒技術面（未實作）',
  };
  return map[id] ?? id;
}

/** 取 MTF 週線 6 項（給 mtf 段引用，雖然 question 沒列在 bookRulesRef 但 contract 白名單有）*/
export function extractMtfChecks(row: StockScanResult): BookRuleEntry[] {
  const c = row.mtfWeeklyChecks;
  if (!c) return MTF_WEEKLY_RULE_IDS.map((id) => ({ ruleId: id, label: id, triggered: false }));
  return [
    { ruleId: 'm-trend',     label: '週線 ① 趨勢多頭',           triggered: c.trend },
    { ruleId: 'm-ma',        label: '週線 ② MA 三線多排',         triggered: c.ma },
    { ruleId: 'm-position',  label: '週線 ③ 收盤 > MA10/MA20',    triggered: c.position },
    { ruleId: 'm-volume',    label: '週線 ④ 量 ≥ 前週 ×1.3',      triggered: c.volume },
    { ruleId: 'm-kbar',      label: '週線 ⑤ 紅 K 實體 ≥ 2%',      triggered: c.kbar },
    { ruleId: 'm-indicator', label: '週線 ⑥ MACD+KD 多排',        triggered: c.indicator },
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// StrategyThresholds 摘要
// ────────────────────────────────────────────────────────────────────────────

function summariseThresholds(strategy: StrategyConfig): Record<string, number | string | boolean> {
  const t = strategy.thresholds;
  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    strategyType: strategy.strategyType ?? 'trend',
    maShortPeriod: t.maShortPeriod,
    maMidPeriod: t.maMidPeriod,
    maLongPeriod: t.maLongPeriod,
    kbarMinBodyPct: t.kbarMinBodyPct,
    upperShadowMax: t.upperShadowMax,
    volumeRatioMin: t.volumeRatioMin,
    kdMaxEntry: t.kdMaxEntry,
    deviationMax: t.deviationMax,
    minScore: t.minScore,
    bullMinScore: t.bullMinScore,
    sidewaysMinScore: t.sidewaysMinScore,
    bearMinScore: t.bearMinScore,
    multiTimeframeFilter: t.multiTimeframeFilter,
    mtfWeeklyStrict: t.mtfWeeklyStrict,
    mtfMonthlyStrict: t.mtfMonthlyStrict,
    mtfMinScore: t.mtfMinScore,
    kdDecliningFilter: t.kdDecliningFilter,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Sanity validation（build time 守門員）
// ────────────────────────────────────────────────────────────────────────────

function validateRuleIds(ref: TechnicalBookRulesRef): void {
  const allIds = [
    ...ref.sixConditions.map((e) => e.ruleId),
    ...ref.longProhibitions.map((e) => e.ruleId),
    ...ref.eliminations.map((e) => e.ruleId),
  ];
  for (const id of allIds) {
    if (!KNOWN_BOOK_RULE_IDS.has(id)) {
      throw new Error(`[technicalAgent] unknown ruleId in BookRulesRef: ${id}`);
    }
  }
}
