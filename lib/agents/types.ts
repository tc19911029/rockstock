/**
 * Multi-Agent 股票決策系統 — Schema 單一事實來源
 *
 * 設計範式：仿 lib/ai/zhuTypes.ts 的 reasoning + dataPoints 結構，
 *           但每個 Agent 有獨立 schema（避免一份 schema 撐 8 個 agent 變太鬆）。
 *
 * P1 範圍：先完整實作 Technical Agent 相關 type；其他 7 個 agent 留 stub。
 * P2-P4 再補完。
 */

import type { StockScanResult, MarketId } from '@/lib/scanner/types';
import type { CandidateSources } from '@/lib/agents/candidates/types';
import type { JudgmentRule } from '@/lib/agents/judgmentRules';
import type {
  AgentScoreBlock,
  GradeBlock,
  ScoredAgentId,
} from '@/lib/agents/scoringTypes';

// ────────────────────────────────────────────────────────────────────────────
// 共用基礎
// ────────────────────────────────────────────────────────────────────────────

export type AgentId =
  | 'technical' | 'chip' | 'fundamental' | 'news'
  | 'risk' | 'bull' | 'bear' | 'decision';

export type AgentPhase = 1 | 2 | 3 | 4;

/** Agent answer schema 版本；改 schema 必須升 major */
export const AGENT_SCHEMA_VERSION = 1 as const;
export type AgentSchemaVersion = typeof AGENT_SCHEMA_VERSION;

/** 統一的 dataPoint 結構（仿 zhu v3）*/
export type DataCategory =
  | 'technical' | 'chip' | 'fundamental' | 'news'
  | 'macro' | 'valuation' | 'governance' | 'industry';

export interface DataPoint {
  category: DataCategory;
  /** 「外資 5 日累計買賣超」「MA20 上揚 3%」 */
  label: string;
  /** 保留單位的字串：「+12,400 張」「PER 18.5」「4.32%」 */
  value: string;
  /** 'prefetch.<field>' / 'L4.candidateRow.<field>' / 'WebSearch: 鉅亨網 5/21' / 'WebSearch 無結果' */
  source: string;
  /** ISO date / '2026Q1' / '近 1 週' */
  asOf?: string;
}

/** 引用書本規則的證據（Technical Agent 專用，但其他 agent 可選用）*/
export interface BookCitation {
  /** 必須在 KNOWN_BOOK_RULE_IDS 集合內（contract test 驗證）*/
  ruleId: string;
  /** 人話描述（UI 顯示用）*/
  label: string;
  /** 從 candidateRow / prefetch 取到的值 */
  value: string;
  /** 是否通過該規則 */
  pass: boolean;
}

/** Phase lockfile 結構（_phase.json）*/
export interface AgentPhaseState {
  schemaVersion: AgentSchemaVersion;
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  startedAt: string;
  /** 目前進行到哪個 phase（1-4），4 = 完成 */
  currentPhase: AgentPhase | 'completed';
  /** 各 agent 是否已完成（key = AgentId）*/
  completed: Partial<Record<AgentId, { at: string; answerPath: string }>>;
}

/** Run metadata（_meta.json）*/
export interface AgentRunMeta {
  schemaVersion: AgentSchemaVersion;
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  startedAt: string;
  completedAt?: string;
  gitSha?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Technical Agent (Agent A) — P1 重點，完整實作
// ────────────────────────────────────────────────────────────────────────────

/**
 * Technical Agent 的 6 段 reasoning
 *
 *   trend   趨勢（多頭/空頭/盤整 + 起/中/末升段位置）
 *   kbar    K 線型態（紅黑、實體、影線、量價對齊）
 *   ma      均線（MA5/10/20 排列、斜率、扣抵）
 *   volume  量能（攻擊量、爆量、量縮）
 *   kd      指標（KD + MACD，遵循 v12 議題 51）
 *   mtf     多時間框架（週線、月線、長線保護短線）
 */
export type TechnicalSection = 'trend' | 'kbar' | 'ma' | 'volume' | 'kd' | 'mtf';

export const TECHNICAL_REQUIRED_SECTIONS: TechnicalSection[] = [
  'trend', 'kbar', 'ma', 'volume', 'kd', 'mtf',
];

export interface TechnicalReasoningItem {
  section: TechnicalSection;
  /** 強制要件：≥ 2 個具體數字，每個數字後括號標來源 */
  text: string;
  /** 該段引用的 book rule ids（與 bookCitations 對應）*/
  ruleIds: string[];
}

export interface TechnicalAnswer {
  schemaVersion: AgentSchemaVersion;
  agent: 'technical';
  runId: string;
  date: string;
  symbol: string;

  /** 該股是否通過技術面（pass = 適合進場 / watch = 持續觀察 / fail = 不進場）*/
  verdict: 'pass' | 'watch' | 'fail';

  /** 一句話總結（< 40 字）*/
  overview: string;
  /** 一句話說 verdict 理由（< 40 字）*/
  verdictReason: string;
  /** 風險提醒（選擇性）*/
  caveat?: string;

  /** 固定 6 段，順序：trend → kbar → ma → volume → kd → mtf */
  reasoning: TechnicalReasoningItem[];

  /** 至少 8 筆 category:'technical' 的具體數值 */
  dataPoints: DataPoint[];

  /**
   * 書本規則引用 ≥ 10 條
   *
   * 必填：六條件 6 項（c-trend / c-ma / c-position / c-volume / c-kbar / c-indicator）
   * 加：戒律觸發狀態 + 淘汰法觸發狀態（任一條都要列）
   */
  bookCitations: BookCitation[];

  /**
   * 評分區塊（v1 新加，optional 向下相容）
   *
   * - LLM 在 answer 內附 raw signals（signals 欄位）
   * - orchestrator.persistAgentAnswer 算 score/light/confidence 覆蓋
   * - 舊 answer 無此欄位仍合法
   */
  scoreBlock?: AgentScoreBlock;
}

// ────────────────────────────────────────────────────────────────────────────
// Technical Agent 輸入 (technical-question.json)
// ────────────────────────────────────────────────────────────────────────────

/**
 * groundTruthSnapshot — 從 L4 candidateRow 抓出來的數值，
 * answer 引用任何技術面數字時必須來自此 snapshot（contract 驗證 < 2% 差距）。
 *
 * 注意：candidateRow 來自 loadScanSession()，我們不對它做計算，只是把欄位攤平給 agent 參考。
 */
export interface TechnicalGroundTruth {
  /** 來自 L4 的 StockScanResult 整包（agent prompt 中就有完整原文）*/
  candidateRow: StockScanResult;
  /** L4 session 的 mtfMode（決定要看哪一個排序）*/
  mtfMode: string;
  /** L4 session 的 strategy（決定六條件的 thresholds）*/
  strategy?: string;
  /** L4 session 的 scanTime / sessionType（讓 agent 知道資料新鮮度）*/
  scanTime: string;
  sessionType?: 'intraday' | 'post_close';
}

/** Book rule 白名單（給 agent 寫 ruleId 時的可選清單；contract 驗證 ruleId ∈ 此集合）*/
export interface TechnicalBookRulesRef {
  /** 六條件 6 個 ID，固定 */
  sixConditions: BookRuleEntry[];
  /** 戒律 reasons（從 candidateRow.entryProhibitionReasons + longProhibitionsReasons 取）*/
  longProhibitions: BookRuleEntry[];
  /** 淘汰法 reasons（從 candidateRow.eliminationReasons 取）*/
  eliminations: BookRuleEntry[];
}

export interface BookRuleEntry {
  /** 唯一 ID（e.g. 'c-trend', 'c-ma', 'p-08', 'e-04') — 必須在 KNOWN_BOOK_RULE_IDS 內 */
  ruleId: string;
  /** 人話標題 */
  label: string;
  /** 是否在本檔股票上觸發 / 通過 */
  triggered: boolean;
}

export interface TechnicalQuestion {
  schemaVersion: AgentSchemaVersion;
  agent: 'technical';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;

  groundTruth: TechnicalGroundTruth;
  bookRulesRef: TechnicalBookRulesRef;

  /** 從 StrategyConfig 取出的 thresholds 摘要（不可在 agent prompt 自創）*/
  thresholdsSummary: Record<string, number | string | boolean>;

  /** P3.5：進入 pool 的理由切片（§0 隔離 — 只給 technical 面向）*/
  entryContext?: { sources: Pick<CandidateSources, 'technical'>; sourceCount: number };
}

// ────────────────────────────────────────────────────────────────────────────
// 已知書本 ruleId 白名單（contract 驗證用）
//
// 維護規則：
//   - 六條件 6 個 固定不變
//   - longProhibitions p-XX 對應書本戒律 1-10
//   - eliminations e-XX 對應淘汰法 R1-R11
//   - 朱老師其他規則（zhu-5steps / kline / ma-strategy / momentum / advanced / soar / long-term）
//     的 ruleId 由 ruleRegistry 動態提供 — 此處只列「Technical Agent 必引用」的核心 ID
// ────────────────────────────────────────────────────────────────────────────

/** 六條件固定 ID（Technical Agent reasoning + bookCitations 必引用）*/
export const SIX_CONDITION_RULE_IDS = [
  'c-trend',       // ① 趨勢（多頭）
  'c-ma',          // ② 均線多排 + 向上
  'c-position',    // ③ 收盤 > MA10/MA20
  'c-volume',      // ④ 攻擊量 ≥ 1.3
  'c-kbar',        // ⑤ K 棒（紅 K + 實體 + 高收）
  'c-indicator',   // ⑥ 指標（KD 或 MACD）
] as const;

/**
 * 戒律 10 條 ID（書本《活用技術分析寶典》p.54）
 *
 * 注意：rockstock 實作上有刪減（戒律 5/10 被六條件涵蓋；戒律 8 走 eliminationFilter R8），
 *       但 Technical Agent 可以引用全部 10 條供朱老師寫 reasoning 對照。
 */
export const LONG_PROHIBITION_RULE_IDS = [
  'p-01', // 第 1 條
  'p-02', // 上漲第 3 根以上勿追高
  'p-03',
  'p-04',
  'p-05',
  'p-06',
  'p-07',
  'p-08', // 空頭趨勢紅 K 反彈勿做多
  'p-09',
  'p-10',
] as const;

/** 淘汰法 R1-R11 ID（書本《活用技術分析寶典》Part 10 p.659-668）*/
export const ELIMINATION_RULE_IDS = [
  'e-01', // 沒走出底部
  'e-02', // 重壓不過跌破 MA5
  'e-03', // 上漲一波後趨勢不明
  'e-04', // 沒有量能
  'e-05', // 大幅上漲且盤整
  'e-06', // 遇壓力大量長黑
  'e-07', // 頭頭低 + MACD/KD 背離
  'e-08', // 三大法人連續賣超
  'e-09', // 頻頻爆大量股價不漲
  'e-10', // 看不懂的股票
  'e-11', // 有基本面沒技術面
] as const;

/** MTF（多時間框架）週線 6 項 checklist ID */
export const MTF_WEEKLY_RULE_IDS = [
  'm-trend', 'm-ma', 'm-position', 'm-volume', 'm-kbar', 'm-indicator',
] as const;

/**
 * 完整白名單 — contract test 用此 Set 驗證 ruleId
 *
 * 注意：contract 只擋「自創的 ruleId」（如「黃金交叉」「布林通道擠壓」），
 *       朱老師 ruleRegistry 中已註冊的 100+ 條規則 ID 我們不強制納入此白名單
 *       （那些 ID 屬於 ruleRegistry 動態載入）。
 *
 * P1：只強制 Technical Agent 引用六條件 6 個 + 戒律 + 淘汰法 + MTF
 *       （即 6 + 10 + 11 + 6 = 33 個 ID 必須命中其中至少 10 個）
 */
export const KNOWN_BOOK_RULE_IDS = new Set<string>([
  ...SIX_CONDITION_RULE_IDS,
  ...LONG_PROHIBITION_RULE_IDS,
  ...ELIMINATION_RULE_IDS,
  ...MTF_WEEKLY_RULE_IDS,
]);

// ────────────────────────────────────────────────────────────────────────────
// News Agent (Agent B) — P3
//
// 隔離原則：只看 YouTube analysis + RSS 新聞；
//          dataPoints 必須全部 category='news'（contract 擋技術/籌碼/基本面）
// ────────────────────────────────────────────────────────────────────────────

export type NewsSection = 'youtube_consensus' | 'rss_news' | 'event_risk';

export const NEWS_REQUIRED_SECTIONS: NewsSection[] = [
  'youtube_consensus', 'rss_news', 'event_risk',
];

export interface NewsReasoningItem {
  section: NewsSection;
  text: string;
  /** 引用的 source ID（YouTube video_id、RSS article hash 等）— 供 traceability */
  sources: string[];
}

/** /api/youtube/analysis/{date} 內該 symbol 的 mention 摘要 */
export interface NewsYouTubeMention {
  /** 是否在當日 high_consensus_stocks（≥2 節目 + 同向 sentiment）*/
  inHighConsensus: boolean;
  /** 該 symbol 被提到的次數 */
  mentionCount: number;
  /** Claude 跨節目評估後的 combined confidence（≥ 0.6 才入彙整）*/
  combinedConfidence: number | null;
  /** sentiment：bullish / bearish / mixed */
  sentiment: string | null;
  /** 來源 video_ids */
  videoIds: string[];
  /** 主持人原話片段（前 N 則）*/
  contexts: string[];
  /**
   * 已讀的 analysis 日期清單（T-1 + T 聯集窗口）。
   * 例：date='2026-05-22' → ['2026-05-21', '2026-05-22']。
   * 解決「T-1 盤後節目隔天才反映」case — Agent 須讀 T-1 才能看見 published_at < T 09:00 CST 的提及。
   */
  windowDates?: string[];
  /**
   * 影片 published_at 必須落在此 ISO 區間內的 mention 才會計入。
   * 預設 = [T-1 01:00 UTC, T 16:00 UTC]（= T-1 09:00 CST 到 T+1 00:00 CST）。
   */
  publishedAtWindow?: { startUtc: string; endUtc: string };
}

/** /api/news/{symbol} 取 RSS 後的精簡彙整 */
export interface NewsRssSummary {
  hasNews: boolean;
  aggregateSentiment: number;  // -1.0 ~ +1.0
  summary: string;
  recentCount: number;
  /** 前 5 則新聞 metadata（給 reasoning 引用）*/
  articles: Array<{
    title: string;
    source: string;
    publishedAt: string;
    label: 'positive' | 'negative' | 'neutral';
    score: number;
  }>;
}

export interface NewsGroundTruth {
  symbol: string;
  name: string | null;
  /** 從 /api/youtube/analysis/{date} 提取，無資料時為 null */
  youtube: NewsYouTubeMention | null;
  /** 從 /api/news/{symbol} 提取，無資料時為 null */
  rss: NewsRssSummary | null;
  /** prefetch 失敗的來源 */
  fetchErrors: string[];
}

export interface NewsQuestion {
  schemaVersion: AgentSchemaVersion;
  agent: 'news';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  groundTruth: NewsGroundTruth;
  /** P3.5：進入 pool 的理由切片（§0 隔離 — 只給 youtube 面向）*/
  entryContext?: { sources: Pick<CandidateSources, 'youtube'>; sourceCount: number };
  /** 判讀規則清單（2026-06-12 A1，描述性引用不計分 — lib/agents/judgmentRules.ts）*/
  judgmentRulesRef?: JudgmentRule[];
}

export interface NewsAnswer {
  schemaVersion: AgentSchemaVersion;
  agent: 'news';
  runId: string;
  date: string;
  symbol: string;

  verdict: 'pass' | 'watch' | 'fail';
  /** 消息面 verdict 釋義：
   * pass = 多源正向催化（YouTube 高共識 + RSS 正向）
   * watch = 部分正向但缺乏共識 / 資料不足
   * fail = 多源負向 / 利空事件 */
  overview: string;
  verdictReason: string;
  caveat?: string;

  /** 3 段：youtube_consensus → rss_news → event_risk */
  reasoning: NewsReasoningItem[];

  /** ≥ 6 筆 category:'news'，禁止其他 category（隔離原則）*/
  dataPoints: DataPoint[];

  /** 是否進入彙整池（combined_confidence ≥ 0.6 才入）*/
  mentioned: boolean;

  /** 評分區塊（v1 新加，optional 向下相容）— 由 orchestrator 算分覆蓋 */
  scoreBlock?: AgentScoreBlock;
}

// ────────────────────────────────────────────────────────────────────────────
// Chip Agent (Agent C) — P3
//
// 隔離原則：只看籌碼資料（三大法人 / 融資融券 / 借券 / 大戶 / 當沖）
//          dataPoints 必須全部 category='chip'（contract 擋技術/基本面/消息）
// ────────────────────────────────────────────────────────────────────────────

export type ChipSection = 'institutional' | 'margin' | 'lending' | 'large_holders';

export const CHIP_REQUIRED_SECTIONS: ChipSection[] = [
  'institutional', 'margin', 'lending', 'large_holders',
];

export interface ChipReasoningItem {
  section: ChipSection;
  text: string;
  /** 引用的 prefetch 來源（'prefetch.chip.foreignBuy' 等）*/
  sources: string[];
}

/** /api/chip 回傳的精簡 ground truth — 不算技術指標 */
export interface ChipGroundTruth {
  symbol: string;
  /** /api/chip 整包 */
  chip: {
    chipScore: number | null;
    chipGrade: string | null;
    chipSignal: string | null;
    chipDetail: string | null;
    foreignBuy: number | null;
    trustBuy: number | null;
    dealerBuy: number | null;
    totalInstitutional: number | null;
    marginBalance: number | null;
    marginNet: number | null;
    shortBalance: number | null;
    shortNet: number | null;
    marginUtilRate: number | null;
    dayTradeVolume: number | null;
    dayTradeRatio: number | null;
    largeTraderBuy: number | null;
    largeTraderSell: number | null;
    largeTraderNet: number | null;
    lendingBalance: number | null;
    lendingNet: number | null;
    largeHolderPct: number | null;
    largeHolderChange: number | null;
  } | null;
  /** /api/institutional/[symbol]?mode=summary 取連續買賣超天數等 */
  institutionalHistory: unknown | null;
  fetchErrors: string[];
}

export interface ChipQuestion {
  schemaVersion: AgentSchemaVersion;
  agent: 'chip';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  groundTruth: ChipGroundTruth;
  /** P3.5：進入 pool 的理由切片（§0 隔離 — 只給 chip 面向）*/
  entryContext?: { sources: Pick<CandidateSources, 'chip'>; sourceCount: number };
  /** 判讀規則清單（2026-06-12 A1，描述性引用不計分 — lib/agents/judgmentRules.ts）*/
  judgmentRulesRef?: JudgmentRule[];
}

export interface ChipAnswer {
  schemaVersion: AgentSchemaVersion;
  agent: 'chip';
  runId: string;
  date: string;
  symbol: string;

  verdict: 'pass' | 'watch' | 'fail';
  /** 籌碼面 verdict 釋義：
   * pass = 法人買超 + 籌碼集中 + 融資未過熱
   * watch = 部分指標 mixed
   * fail = 法人賣超 / 融資過熱 / 主力出貨 */
  overview: string;
  verdictReason: string;
  caveat?: string;

  /** 4 段：institutional → margin → lending → large_holders */
  reasoning: ChipReasoningItem[];

  /** ≥ 8 筆 category:'chip'，禁止其他 category（隔離原則）*/
  dataPoints: DataPoint[];

  /** 評分區塊（v1 新加，optional 向下相容）— 由 orchestrator 算分覆蓋
   *  包含 ETF 共識、投信動向、大戶分層等子訊號（plan §3.3 合進此 panel）*/
  scoreBlock?: AgentScoreBlock;
}

// ────────────────────────────────────────────────────────────────────────────
// Fundamental Agent (Agent D) — P3
//
// 隔離原則：只看月營收 / EPS / 毛利率 / 估值 / 產業
//          dataPoints 必須 category='fundamental' 或 'valuation' 或 'industry'
//          （contract 擋技術/籌碼/消息）
// ────────────────────────────────────────────────────────────────────────────

export type FundamentalSection = 'revenue' | 'profit' | 'valuation' | 'industry';

export const FUNDAMENTAL_REQUIRED_SECTIONS: FundamentalSection[] = [
  'revenue', 'profit', 'valuation', 'industry',
];

export interface FundamentalReasoningItem {
  section: FundamentalSection;
  text: string;
  sources: string[];
}

/** /api/fundamentals/{symbol}?mode=full 的精簡欄位 */
export interface FundamentalGroundTruth {
  symbol: string;
  name: string | null;
  /** 從 prefetch 拉到的基本面數字（仿 ZhuFundamentalsLite）*/
  fundamentals: {
    eps: number | null;
    epsYoY: number | null;
    grossMargin: number | null;
    netMargin: number | null;
    per: number | null;
    pbr: number | null;
    dividendYield: number | null;
    revenueLatest: number | null;
    revenueMoM: number | null;
    revenueYoY: number | null;
  } | null;
  /** 從 candidateRow.industry 或 FinMind TaiwanStockInfo */
  industry: string | null;
  /** ── v2 估值分析輸入（向下相容，optional）─────────────────────────
   *  由 fundamentalAgent prefetch 補齊，skill 用來算三情境 + GDR 稀釋。
   *  台股有 monthlyRevenueHistory；陸股 monthlyRevenueHistory 為空陣列。 */
  valuationInputs?: {
    /** 'TW' | 'CN' — 估值流程依市場分支（陸股不抓月營收，用季度情境） */
    market: 'TW' | 'CN';
    /** 當天最新股價（FinMind quote / TWSE / EastMoney） */
    currentPrice: number | null;
    /** 報價真正所屬交易日；休市日不得填成今天。 */
    currentPriceDate?: string | null;
    /** 近 8 季逐季財報 — 由近到遠 */
    quarterlyHistory: Array<{
      quarter: string;
      revenue: number | null;
      grossProfit: number | null;
      netIncome: number | null;
      /** 扣非淨利（陸股 = 扣除非經常性損益後）；台股近似 = 稅後淨利 - 業外損益 */
      nonRecurringNetIncome?: number | null;
      eps: number | null;
      netMargin: number | null;
      grossMargin: number | null;
    }>;
    /** 近 12 月營收 — 由近到遠（陸股空陣列） */
    monthlyRevenueHistory: Array<{
      month: string;
      revenue: number;
      mom: number | null;
      yoy: number | null;
    }>;
    /** 注意股重大訊息揭露的單月自結實績；正式程度高於月營收模型、低於核閱季報。 */
    selfReportedMonthlyActuals?: Array<{
      period: string;
      revenue: number | null;
      pretaxIncome: number | null;
      netIncome: number | null;
      eps: number;
      announcedAt: string;
      sourceUrl: string;
      source: 'yahoo_tw_mops_republication';
      audited: false;
      note: string;
    }>;
    /** 交易所最新季報的本年度累計口徑；避免把各季 EPS 相加造成加權股數誤差。 */
    latestCumulativeActual?: {
      fiscalYear: number;
      quarter: number;
      reportedThrough: string;
      cumulativeRevenue: number | null;
      cumulativeNetIncome: number | null;
      cumulativeEps: number | null;
      sourceUrl: string;
    };
    /** 正式季報前的公司業績預告／快報；不得混入已審閱 TTM。 */
    earningsGuidance?: Array<{
      period: string;
      status: 'forecast' | 'preliminary' | 'actual';
      revenueMin?: number | null;
      revenueMax?: number | null;
      netIncomeMin?: number | null;
      netIncomeMax?: number | null;
      normalizedNetIncomeMin?: number | null;
      normalizedNetIncomeMax?: number | null;
      epsMin?: number | null;
      epsMax?: number | null;
      announcedAt: string;
      sourceUrl: string;
      note: string;
    }>;
    /** 流通在外股數 / 總股本 */
    sharesOutstanding: number | null;
    /** 每股淨值 / 每股淨資產 */
    bookValuePerShare: number | null;
    /** 程式預先算好的 TTM */
    ttmEps: number | null;
    ttmPe: number | null;
    /** 以最新股數重算的備考 TTM；增資／配股後與報表 EPS 並列，不互相冒充。 */
    proFormaTtmEps?: number | null;
    proFormaTtmPe?: number | null;
    ttmNetIncome?: number | null;
    /** 動態 PE = 股價 /（最新季 EPS × 4）— 兩市場通用，陸股 App 顯示「市盈率（動）」 */
    dynamicPe: number | null;
    /** 靜態 PE = 股價 / 去年全年 EPS — 陸股 App 顯示「市盈率（靜）」 */
    staticPe: number | null;
    /** 最近一個完整會計年度的四季 EPS 加總。 */
    lastYearTotalEps: number | null;
    /** 從 data/dilution/{symbol}.json 讀的 GDR/增資/CB 公告（陸股目前空陣列） */
    dilutionEvents: Array<{
      type: 'gdr' | 'rights_issue' | 'convertible_bond' | 'employee_option' | 'private_placement';
      newShares: number;
      status?: 'pending' | 'approved' | 'completed' | 'cancelled';
      potentialDilutionPct?: number;
      expectedDate?: string;
      priceIfKnown?: number;
      sourceUrl?: string;
      announcedAt?: string;
      description?: string;
    }>;
    /** 程式由 industry 推得的估值模板（7 大類 + other） */
    industryTemplate:
      | 'high_growth_asic'
      | 'cyclical'
      | 'distributor'
      | 'stable_mature'
      | 'advanced_material'
      | 'consumer_pharma_leader'
      | 'hype_extreme_growth'
      | 'other';
    industryTemplateLabel: string;
    /** 程式預設合理 PE 區間（skill 可依法說會/法人 override） */
    reasonablePeRange: { pessimistic: number; base: number; optimistic: number };
    /** 每個資料欄位的來源 URL（同 youtube evidence 規則） */
    sourceUrls: Record<string, string>;
  };
  fetchErrors: string[];
}

export interface FundamentalQuestion {
  schemaVersion: AgentSchemaVersion;
  agent: 'fundamental';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  groundTruth: FundamentalGroundTruth;
  /** P3.5：進入 pool 的理由切片（§0 隔離 — 只給 fundamental 面向）*/
  entryContext?: { sources: Pick<CandidateSources, 'fundamental'>; sourceCount: number };
  /** 判讀規則清單（2026-06-12 A1，描述性引用不計分 — lib/agents/judgmentRules.ts）*/
  judgmentRulesRef?: JudgmentRule[];
}

export interface FundamentalAnswer {
  schemaVersion: AgentSchemaVersion;
  agent: 'fundamental';
  runId: string;
  date: string;
  symbol: string;

  verdict: 'pass' | 'watch' | 'fail';
  /** 基本面 verdict 釋義：
   * pass = 營收成長 + 獲利改善 + 估值合理
   * watch = 部分指標好但估值偏高 / 資料不足
   * fail = 衰退 / 估值過貴 / 虧損 */
  overview: string;
  verdictReason: string;
  caveat?: string;

  /** 4 段：revenue → profit → valuation → industry */
  reasoning: FundamentalReasoningItem[];

  /** dataPoints：≥ 6 category:'fundamental' + ≥ 2 category:'valuation'，可加 industry
   *  禁止其他 category（隔離原則）*/
  dataPoints: DataPoint[];

  /** 評分區塊（v1 新加，optional 向下相容）— 由 orchestrator 算分覆蓋 */
  scoreBlock?: AgentScoreBlock;

  /** ── v2 估值分析段（向下相容，optional）──────────────────────────────
   *  由 skill 在分析時上網查法說會/法人預估後填寫；
   *  ttmPe 由程式預算後 echo 回來，scenarios 由 skill 推算。 */
  valuation?: {
    ttmPe: number;
    /** 估值產生時的報價與 TTM EPS；畫面可用即時價重算價格衍生指標。 */
    currentPriceContext?: {
      currentPrice: number;
      priceDate: string;
      ttmEps?: number;
      sharesOutstanding?: number;
      fullyDilutedShares?: number;
      currency?: string;
      sourceUrl?: string;
    };
    /** 本次估值涵蓋的會計年度與已公告進度；舊資料可能沒有。 */
    fiscalYear?: number;
    reportedThrough?: string;
    actualEpsYtd?: number;
    /** 本次估值實際納入的資料期別，用來偵測後續新公告。 */
    dataAsOf?: {
      financialReportPeriod?: string;
      monthlyRevenuePeriod?: string;
      selfReportedPeriod?: string;
      sharesOutstanding?: number;
      dilutionSignature?: string;
    };
    /** 已納入情境計算的單月公司自結實績；不得再以 monthlyEpsEstimate 覆蓋同月份。 */
    monthlyEpsActuals?: Array<{
      period: string;
      eps: number;
      revenue?: number | null;
      netIncome?: number | null;
      announcedAt: string;
      sourceUrl: string;
      audited: false;
      note: string;
    }>;
    /** 真正未來 12 個月（NTM）估值；資料不足時應省略，不得用本年度 EPS 冒充。 */
    ntmEstimate?: {
      period: string;
      eps: number;
      pe: number;
      method: string;
    };
    /** 合理 PE 的可比同業校準明細。 */
    peerComparison?: {
      asOf: string;
      selectionBasis: string;
      peers: Array<{
        symbol: string;
        name: string;
        market: 'TW' | 'CN' | 'US' | 'OTHER';
        ttmPe: number | null;
        currentYearPe: number | null;
        excluded: boolean;
        exclusionReason?: string;
        sourceUrl: string;
        asOf: string;
      }>;
      medianTtmPe: number | null;
      medianCurrentYearPe: number | null;
      lowerQuartilePe: number | null;
      upperQuartilePe: number | null;
      appliedPeRationale: string;
    };
    /** 產業適配的主估值法與交叉驗證，避免所有公司一律只套 PE。 */
    valuationMethod?: {
      primaryModel: string;
      crossChecks: string[];
      rationale: string;
      probabilityWeightedFairPrice?: number;
    };
    /** skill 推估的當月 EPS（用月營收 × 上一季淨利率 / 股數） */
    monthlyEpsEstimate?: {
      month: string;
      monthlyRevenue: number;
      netMarginUsed: number;
      estimatedNetIncome: number;
      estimatedEps: number;
      note: string;
    };
    scenarios: {
      pessimistic: ScenarioOutput;
      base: ScenarioOutput;
      optimistic: ScenarioOutput;
    };
    dilution: {
      originalShares: number;
      newShares: number;
      ratio: number;
      pessimisticDilutedEps: number;
      baseDilutedEps: number;
      optimisticDilutedEps: number;
      pessimisticDilutedPrice: number;
      baseDilutedPrice: number;
      optimisticDilutedPrice: number;
      events: Array<{ type: string; newShares: number; sourceUrl?: string; description?: string }>;
    } | null;
    riskFlags: Array<
      | 'one_time_gain'
      | 'pb_overheated'
      | 'cyclical_peak'
      | 'forward_pe_misleading'
      | 'dilution_pending'
      | 'margin_declining_while_revenue_growing'
      | 'monthly_revenue_pending'
      | 'aggressive_scenario_assumption'
      | 'foreign_currency_sensitive'
      | 'customer_concentration'
      | {
          /** 深度估值可輸出擴充風險代碼，UI 必須保留向前相容。 */
          code: string;
          severity: 'low' | 'medium' | 'high';
          detail: string;
        }
    >;
    conclusion: 'undervalued' | 'fair' | 'overvalued';
    reasoning: string;
  };
}

/** 三情境之一的輸出（skill 填寫） */
export interface ScenarioOutput {
  /** 情境機率（0-1）；三情境合計必須為 1。 */
  probability?: number;
  /** Q2-Q4 各季營收假設（億 / 與 quarterlyHistory 同單位） */
  q2Revenue: number;
  q3Revenue: number;
  q4Revenue: number;
  /** 各季淨利率假設（0-1 小數，例 0.34 = 34%） */
  q2NetMargin: number;
  q3NetMargin: number;
  q4NetMargin: number;
  /** 各季預估 EPS */
  q2Eps: number;
  q3Eps: number;
  q4Eps: number;
  fullYearEps: number;
  /** 實際拿來乘合理 PE、算 Forward PE 的 EPS；必須與 fairPrice 同口徑。 */
  valuationEps?: number;
  /** reported=報表、latest_shares=最新股數備考、fully_diluted=完全稀釋、normalized=剔除一次性。 */
  valuationEpsBasis?: 'reported' | 'latest_shares' | 'fully_diluted' | 'normalized';
  forwardPe: number;
  fairPe: number;
  fairPrice: number;
  upside: number;
  /** 假設來源（法說會展望 / 法人預估 / 月營收外推 等）必須附 URL */
  assumptionEvidence: Array<{ field: string; sourceUrl: string; rawQuote: string }>;

  /** ── v3 推估依據透明化（向下相容 optional） ─────────────────────
   *  以下欄位 skill 必須在 ScenarioOutput 內填寫，否則 UI 標「依據不明」。
   */
  /** 信心等級 — low: 純假設、medium: 有部分依據、high: 法說會明確展望 */
  confidenceLevel?: 'low' | 'medium' | 'high';
  /** 營收假設依據（自然語言）— 多行：方法 A 月營收外推 + 方法 B EPS 反推 + 方法 C 法說會語意 */
  revenueBasis?: string;
  /** 淨利率假設依據（自然語言）— 必須引用 Q1 淨利率為基準 */
  netMarginBasis?: string;
  /** 後續可驗證的月營收目標（用 5/6/7/8/9 月實際營收 vs 預期對照） */
  validationTriggers?: {
    may?: number;        // 5 月營收目標（億）
    june?: number;       // 6 月
    july?: number;       // 7 月
    aug?: number;        // 8 月
    sept?: number;       // 9 月
    q3MonthlyAvg?: number;  // Q3 月均營收目標
    q4MonthlyAvg?: number;  // Q4 月均營收目標
    description?: string;   // 「7/8/9 月平均月營收需達 35 億，中性情境成立」這類說明
  };
  /** 程式自動偵測的過度樂觀 flag（不要由 skill 填，由程式套用 detectOverlyOptimistic） */
  overlyOptimisticFlags?: Array<
    | 'q3_revenue_jump_over_50pct_vs_q2'
    | 'q4_revenue_jump_over_20pct_vs_q3'
    | 'q2_margin_above_q1_by_3pp'
    | 'q3_margin_above_q1_by_3pp'
    | 'q4_margin_above_q1_by_3pp'
    | 'fullyear_eps_above_consensus_upper_by_15pct'
  >;
  /** 反推模式：是否由「目標全年 EPS」反推營收 */
  reverseEngineeredFrom?: {
    targetFullYearEps: number;
    h2NetMarginUsed: number;
    h2RequiredRevenue: number;
    note: string;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Risk Agent (Agent E) — P4
//
// 隔離原則：Risk Agent 只挑毛病，不找買進理由
//   - 看 candidateRow 的戒律/淘汰法/趨勢位置 + 4 個 analyst answer 的 dataPoint
//   - 不可給 'pass' verdict（風控不負責通過 — 只給 green/yellow/red 風險等級）
// ────────────────────────────────────────────────────────────────────────────

export type RiskVerdict = 'green' | 'yellow' | 'red';

export interface RiskGroundTruth {
  symbol: string;
  /** 從 candidateRow 取（趨勢位置、戒律觸發等）*/
  candidateRow: StockScanResult;
  /** 4 個 analyst answer 的 verdict + 關鍵 dataPoint（用於 risk 觸發判斷）*/
  analystVerdicts: {
    technical:   { verdict: 'pass' | 'watch' | 'fail'; overview: string } | null;
    news:        { verdict: 'pass' | 'watch' | 'fail'; overview: string } | null;
    chip:        { verdict: 'pass' | 'watch' | 'fail'; overview: string } | null;
    fundamental: { verdict: 'pass' | 'watch' | 'fail'; overview: string } | null;
  };
  /** 大盤 regime（從 /api/scanner/market-trend 取）*/
  marketRegime: string | null;
  /**
   * 處置股/注意股官方名單旗標（2026-06-12 B1，lib/market/attentionList.ts 即時查）。
   * disposal=true → 紅燈（分盤交易，制度層不可交易）；notice=true → 黃燈警示。
   * null = 名單未收集（TW 以外市場或名單檔不存在）。
   */
  attentionFlags?: { disposal: boolean; notice: boolean } | null;
  fetchErrors: string[];
}

export interface RiskQuestion {
  schemaVersion: AgentSchemaVersion;
  agent: 'risk';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  groundTruth: RiskGroundTruth;
}

export interface RiskAnswer {
  schemaVersion: AgentSchemaVersion;
  agent: 'risk';
  runId: string;
  date: string;
  symbol: string;

  /** 風控等級：red = 必擋；yellow = 進場但降部位；green = 風險低 */
  verdict: RiskVerdict;
  overview: string;
  verdictReason: string;

  /**
   * Hard blockers — 任一觸發就 verdict=red，Decision Agent 必擋
   * 例：「淘汰 R7：頭頭低 + 背離」「戒律 8：空頭紅 K 反彈」「除權息日 T+2」
   */
  hardBlockers: Array<{ ruleId?: string; label: string; severity: 'critical' | 'high' }>;

  /**
   * Soft warnings — verdict=yellow，Decision Agent 降部位
   * 例：「位置 95% 接近壓力」「融資過熱」「漲多回檔風險」
   */
  softWarnings: Array<{ label: string; impact: 'high' | 'mid' | 'low' }>;

  /**
   * 事件風險 — 即將發生的事件（除權息、法說、董監改選、現增、可轉債）
   * 沒事件 → events 空陣列即可
   */
  events: Array<{ date: string; type: string; description: string }>;

  /**
   * 建議停損價（從 candidateRow 推 — 通常是 MA20 或前低）
   * Decision Agent 會把這個傳到 FinalDecision.stopLoss
   */
  suggestedStopLoss?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Bull / Bear Researcher (Agent F/G) — P4 辯護角色
//
// 紅線（§0）：
//   - 不引入新事實 — 每條 thesis 的 evidence 必須能對應到 A-E answer 已有的 dataPoint
//   - Bear 必須一對一反駁 Bull（rebuttals.length === bullThesis.length）
//   - Bull/Bear 是「整理觀點」的角色，不負責改寫規則
// ────────────────────────────────────────────────────────────────────────────

/** 引用某 agent 的某筆 dataPoint（contract 可解析驗證）*/
export interface EvidenceRef {
  /** 'technical' | 'news' | 'chip' | 'fundamental' | 'risk' */
  agent: AgentId;
  /** dataPoint 在該 agent answer 的 index（從 0 開始）*/
  dataPointIndex: number;
  /** 引用該 dataPoint 的 label（給 UI 顯示用，contract 不擋）*/
  label: string;
}

export interface BullClaim {
  /** 多方論點（一句話）*/
  claim: string;
  /** 必須引用 ≥ 1 個 A-E dataPoint */
  evidence: EvidenceRef[];
  /** 強度自評 1-5 */
  strength: 1 | 2 | 3 | 4 | 5;
  /** 承認的弱點 — 強制誠實，不可空 */
  weaknessAcknowledged: string;
}

export interface BullThesis {
  schemaVersion: AgentSchemaVersion;
  agent: 'bull';
  runId: string;
  date: string;
  symbol: string;
  overview: string;
  /** ≥ 3 條多方論點 */
  bullThesis: BullClaim[];
  /** 整體多方強度 — sum(strength) */
  totalStrength: number;
}

/** Bear 對單條 bull claim 的反駁 */
export interface BearRebuttal {
  /** 對應的 bullThesis index（0-based，必填）*/
  rebuts: number;
  /** 反駁內容 */
  counter: string;
  /** 反駁依據（引用 A-E dataPoint，可 0 條代表「對方論點本身就薄弱」）*/
  evidence: EvidenceRef[];
  /** 反駁強度 1-5 */
  strength: 1 | 2 | 3 | 4 | 5;
  /** 是否承認 bull 該條部分 valid */
  partialValidity?: string;
}

export interface BearThesis {
  schemaVersion: AgentSchemaVersion;
  agent: 'bear';
  runId: string;
  date: string;
  symbol: string;
  overview: string;
  /** 額外空方論點（不一定對應 bull claim — 純粹擔憂）*/
  additionalConcerns: Array<{ concern: string; evidence: EvidenceRef[]; strength: 1 | 2 | 3 | 4 | 5 }>;
  /** 一對一反駁 bull — rebuttals.length === bullThesis.length（contract 守）*/
  rebuttals: BearRebuttal[];
  /** 整體空方強度 — sum(rebuttals.strength) + sum(additionalConcerns.strength) */
  totalStrength: number;
}

export interface DebateQuestion {
  schemaVersion: AgentSchemaVersion;
  /** 'bull' or 'bear'（同 question type 兩用，by phase 分）*/
  agent: 'bull' | 'bear';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** A-E 完整 answers — 給 LLM 引用 dataPoint 用 */
  analystAnswers: {
    technical:   TechnicalAnswer | null;
    news:        NewsAnswer | null;
    chip:        ChipAnswer | null;
    fundamental: FundamentalAnswer | null;
    risk:        RiskAnswer | null;
  };
  /** Bear question 才有：bull 已寫的 answer，給 bear 一對一反駁 */
  bullAnswer?: BullThesis;
}

// ────────────────────────────────────────────────────────────────────────────
// Decision Agent (Agent H) — P4 投資委員會主席
//
// 規則式整合，非加權平均（§0）：
//   - Technical fail → action='skip'（無條件最高優先）
//   - Technical pass + Risk red → 'skip'
//   - Technical pass + Risk green + (Bull − Bear ≥ 2) → 'buy'
//   - Technical pass + Risk yellow → 'watch'（降部位）
//   - Technical pass + |Bull − Bear| < 2 → 'watch'
//   - Technical watch (其他面向 verdict 任意) → 'watch'
//   - 其他 → 'watch'
// ────────────────────────────────────────────────────────────────────────────

export type FinalAction = 'buy' | 'watch' | 'skip';

/** decisionPath 是規則表中命中的那一條 — contract 必須對應實際 verdicts */
export type DecisionPath =
  | 'technical_fail'
  | 'risk_red'
  | 'buy_signal'
  | 'risk_yellow_watch'
  | 'debate_neutral_watch'
  | 'technical_watch'
  | 'default_watch';

export interface DecisionQuestion {
  schemaVersion: AgentSchemaVersion;
  agent: 'decision';
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** A-G 全部 answers */
  inputs: {
    technical:   TechnicalAnswer | null;
    news:        NewsAnswer | null;
    chip:        ChipAnswer | null;
    fundamental: FundamentalAnswer | null;
    risk:        RiskAnswer | null;
    bull:        BullThesis | null;
    bear:        BearThesis | null;
  };
  /** decision 規則表（給 LLM 對照）*/
  decisionRulesRef: string;
}

export interface FinalDecision {
  schemaVersion: AgentSchemaVersion;
  agent: 'decision';
  runId: string;
  date: string;
  symbol: string;

  /** 最終操作建議 */
  action: FinalAction;

  /** 哪條規則命中（contract 驗證 path 與 verdicts 一致）*/
  decisionPath: DecisionPath;

  /** 4+1 個面向 verdict 並列展示（§0 — 不混合加權，只是並列）*/
  verdictsByAgent: {
    technical:   'pass' | 'watch' | 'fail' | null;
    news:        'pass' | 'watch' | 'fail' | null;
    chip:        'pass' | 'watch' | 'fail' | null;
    fundamental: 'pass' | 'watch' | 'fail' | null;
    risk:        RiskVerdict | null;
  };

  /** Bull / Bear 強度（純並列，不平均）*/
  bullScore: number;
  bearScore: number;

  /** 從 Technical Agent dataPoint 取 — 不可自創 */
  entryPrice?: number;
  /** 從 Risk Agent suggestedStopLoss 取 */
  stopLoss?: number;
  target1?: number;
  target2?: number;

  /** Risk green=1.0 / yellow=0.5 / red=0 */
  sizeHint: number;

  /** 明確列出 agent 意見衝突（不可隱藏；可空陣列）*/
  conflicts: string[];

  /** 一句話 summary */
  overview: string;
  verdictReason: string;

  /**
   * 總結評分區塊（v1 新加，optional 向下相容）
   *
   * 由程式從 4 個 analyst.scoreBlock + risk.verdict 算出（lib/agents/scoring.assignGrade）
   * LLM 不能改 grade — orchestrator persist 前強制覆蓋
   */
  gradeBlock?: GradeBlock;

  /** 4 面向分數快取（給 UI / API list 直接讀，不用再 join 4 個檔）*/
  scoresByAgent?: Partial<Record<ScoredAgentId, { score: number; light: string; confidence: string }>>;

  /** 主要利多（由 LLM 從 4 個 analyst keyFactors 摘錄）*/
  keyBullPoints?: string[];

  /** 主要風險（由 LLM 從 4 個 analyst risks + Risk Agent 摘錄）*/
  keyRiskPoints?: string[];

  /** 若 grade=C「觀察名單」，下一個要確認的條件（由 LLM 根據最弱面寫）*/
  nextConditionToWatch?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// 每 agent 的 dataPoint category 白名單（contract isolation 驗證用）
// ────────────────────────────────────────────────────────────────────────────

export const ALLOWED_CATEGORIES_BY_AGENT: Record<
  'technical' | 'news' | 'chip' | 'fundamental',
  ReadonlyArray<DataCategory>
> = {
  technical:   ['technical'],
  news:        ['news'],
  chip:        ['chip'],
  fundamental: ['fundamental', 'valuation', 'industry'],
};

/** 該日 Top-N 索引（data/agents/decisions/{date}/_index.json）— P4 才寫 */
export interface DailyAgentDigest {
  schemaVersion: AgentSchemaVersion;
  date: string;
  topSymbols: string[];
  // TODO P4：補完整結構
}

/** 持股當日狀態 — P5 */
export interface PortfolioState { schemaVersion: AgentSchemaVersion; date: string; /* TODO P5 */ }

/** d1-d20 回測 — P5 */
export interface BacktestReport { schemaVersion: AgentSchemaVersion; date: string; /* TODO P5 */ }
