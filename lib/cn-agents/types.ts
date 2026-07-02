/**
 * 陸股 AI 選股 Agent 系統 — 型別單一事實來源
 *
 * 隔離原則：本系統是自創因子集（情緒週期/漲停結構/龍虎榜評分），
 * 鏡像 lib/cn-sanse/ 的隔離先例，完全獨立於 lib/agents/（台股 8-agent）
 * 與書本六條件選股鏈路。資料一律存 data/cn-agents/{domain}/{date}.json。
 *
 * 設計依據：docs 外的規格書（18-agent 陸股情緒系統）+ plan
 * glistening-dreaming-hare（P1 = 大盤情緒 / 漲停結構 / 板塊強弱 / 人氣熱度）。
 */

import type { RedFlag } from '@/lib/redflags/types';

export const CN_AGENTS_SCHEMA_VERSION = 1;

/** 情緒週期狀態機規則版本 — 改 PHASE_PARAMS 或判定規則必升版（v2 = 2026-06-12 分位數校準，見 cycle.ts 檔頭） */
export const CYCLE_RULES_VERSION = 'v2';

// ────────────────────────────────────────────────────────────────────────────
// 板塊分類
// ────────────────────────────────────────────────────────────────────────────

/** A 股板別（決定漲停幅度語意：主板 10% / 創業科創 20% / 北交 30%） */
export type CnBoardKind = 'SH-main' | 'SZ-main' | 'ChiNext' | 'STAR' | 'BJ';

// ────────────────────────────────────────────────────────────────────────────
// 漲停池（data/cn-agents/limitup-pool/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export interface LimitUpEntry {
  /** 6 位裸碼，例 '600519' */
  symbol: string;
  name: string;
  board: CnBoardKind;
  /** 當日漲跌幅 % */
  pct: number;
  close: number;
  /** 成交額（元） */
  turnoverCny: number | null;
  /** 流通市值（元） */
  floatMvCny: number | null;
  /** 封單金額（元） */
  sealAmountCny: number | null;
  /** 首次封板時間 HH:MM:SS */
  firstSealTime: string | null;
  /** 最後封板時間 HH:MM:SS */
  lastSealTime: string | null;
  /** 炸板（開板）次數 */
  brokenTimes: number | null;
  /** 連板數（首板=1） */
  consecBoards: number;
  /** 幾天幾板，例 '5/3'（5 天 3 板）；EM hybc 欄 */
  boardsPattern: string | null;
  industry: string | null;
  /** 一字板（無法買進） */
  isOneWord: boolean;
  isST: boolean;
}

/** 炸板股（盤中觸停、收盤未封回） */
export interface BrokenEntry {
  symbol: string;
  name: string;
  board: CnBoardKind;
  pct: number;
  close: number;
  /** 開板次數 */
  brokenTimes: number | null;
  firstSealTime: string | null;
  industry: string | null;
  isST: boolean;
}

export interface LimitDownEntry {
  symbol: string;
  name: string;
  board: CnBoardKind;
  pct: number;
  close: number;
  /** 連續跌停天數（EM days 欄，可缺） */
  consecDownBoards: number | null;
  industry: string | null;
  isST: boolean;
}

/** 全市場寬度概況（漲跌家數 + 兩市量能） */
export interface MarketOverview {
  upCount: number;
  downCount: number;
  flatCount: number;
  /** 兩市成交額（元）= 上證 f6 + 深證 f6 */
  turnoverShSzCny: number | null;
  /** 上證指數當日漲跌 % */
  shIndexPct: number | null;
}

export interface PromotionStat {
  /** 昨日符合晉級資格家數 */
  eligible: number;
  /** 今日成功晉級家數 */
  promoted: number;
  /** promoted / eligible；eligible=0 → null */
  rate: number | null;
}

export interface LimitUpPoolStats {
  /** 非 ST 漲停家數（含一字） */
  limitUpCount: number;
  limitDownCount: number;
  /** 炸板（觸停未封回）家數 */
  brokenCount: number;
  /** 封板率 = limitUp / (limitUp + broken)；分母 0 → null */
  sealRate: number | null;
  /** 炸板率 = broken / (limitUp + broken) */
  brokenRate: number | null;
  oneWordCount: number;
  /** 創業板+科創板 20cm 漲停數 */
  cm20LimitUpCount: number;
  stLimitUpCount: number;
  /** 連板梯隊分佈（非 ST） */
  heightDist: Record<'1' | '2' | '3' | '4+', number>;
  /** 最高連板數 */
  maxHeight: number;
  maxHeightSymbols: string[];
  /** 二板以上家數 */
  board2PlusCount: number;
  /** 晉級率（跨日：寫入時讀前一交易日檔自算；昨檔缺 → null） */
  promotion: {
    d1to2: PromotionStat;
    d2to3: PromotionStat;
    d3plus: PromotionStat;
  } | null;
  /** 昨日漲停股今日平均漲跌 %（接力賺錢效應；昨檔缺 → null） */
  yesterdayLimitUpAvgPct: number | null;
  /** 昨日炸板股今日平均漲跌 %（虧錢效應） */
  yesterdayBrokenAvgPct: number | null;
}

export type CnAgentsDataSource = 'em-push2ex' | 'akshare' | 'candles-backfill';

export interface LimitUpPoolDay {
  schemaVersion: number;
  date: string;
  fetchedAt: string;
  source: CnAgentsDataSource;
  limitUp: LimitUpEntry[];
  limitDown: LimitDownEntry[];
  broken: BrokenEntry[];
  breadth: MarketOverview;
  stats: LimitUpPoolStats;
}

// ────────────────────────────────────────────────────────────────────────────
// 市場寬度日線（情緒狀態機輸入；data/cn-agents/breadth/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

/** 情緒週期狀態機的扁平輸入 — 由 LimitUpPoolDay 衍生（breadth.ts 組裝） */
export interface MarketBreadthDay {
  date: string;
  limitUpCount: number;
  limitDownCount: number;
  oneWordCount: number;
  zhabanCount: number;
  zhabanRate: number | null;
  maxBoardHeight: number;
  board2PlusCount: number;
  promotionRate1to2: number | null;
  /** 昨 2 板以上今晉級率 */
  promotionRateHigh: number | null;
  yestLimitUpAvgReturn: number | null;
  yestZhabanAvgReturn: number | null;
  upCount: number;
  downCount: number;
  /** 兩市成交額（元） */
  totalTurnover: number | null;
  /** 今日成交額 / 近 5 日均（含今日）；歷史不足 → null */
  turnoverRatio5d: number | null;
  shIndexChangePct: number | null;
}

// ────────────────────────────────────────────────────────────────────────────
// 情緒週期八階段
// ────────────────────────────────────────────────────────────────────────────

export type EmotionStage =
  | 'frozen'      // 冰點
  | 'repair'      // 修復
  | 'launch'      // 啟動
  | 'main_rise'   // 主升
  | 'climax'      // 高潮
  | 'divergence'  // 分歧
  | 'retreat'     // 退潮
  | 'crash';      // 殺跌

export const STAGE_LABELS: Record<EmotionStage, string> = {
  frozen: '冰點',
  repair: '修復',
  launch: '啟動',
  main_rise: '主升',
  climax: '高潮',
  divergence: '分歧',
  retreat: '退潮',
  crash: '殺跌',
};

/** 今日策略建議（打板/半路/低吸/波段/觀望） */
export type DailyTactic = 'daban' | 'banlu' | 'dixi' | 'swing' | 'observe';

export const TACTIC_LABELS: Record<DailyTactic, string> = {
  daban: '打板',
  banlu: '半路',
  dixi: '低吸',
  swing: '波段',
  observe: '觀望',
};

export interface EmotionCycleDay {
  date: string;
  stage: EmotionStage;
  stageLabel: string;
  /** 0-100 連續情緒分（固定錨點合成，可回測重現） */
  emotionScore: number;
  /** 今日策略建議（可多個，如 打板+半路） */
  strategies: DailyTactic[];
  strategyLabel: string;
  /** 倉位建議區間 [低, 高]，0-100 */
  positionPct: [number, number];
  reasons: string[];
  /** hysteresis 修正前的 raw 階段（除錯/回測分析用） */
  rawStage: EmotionStage;
}

/** data/cn-agents/breadth/{date}.json 的完整內容 */
export interface BreadthDayFile {
  schemaVersion: number;
  date: string;
  generatedAt: string;
  cycleRulesVersion: string;
  breadth: MarketBreadthDay;
  cycle: EmotionCycleDay;
}

/** data/cn-agents/breadth/index.json — 近 N 日序列（前端 + 狀態機歷史一次讀） */
export interface BreadthIndexFile {
  schemaVersion: number;
  updatedAt: string;
  /** 升冪（舊→新），最多 BREADTH_INDEX_MAX_DAYS 筆 */
  days: Array<{ date: string; breadth: MarketBreadthDay; cycle: EmotionCycleDay }>;
}

export const BREADTH_INDEX_MAX_DAYS = 120;

// ────────────────────────────────────────────────────────────────────────────
// 板塊快照（data/cn-agents/boards/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export type BoardKind = 'industry' | 'concept';

export interface BoardEntry {
  /** EM 板塊代碼 BKxxxx */
  code: string;
  name: string;
  kind: BoardKind;
  pct: number;
  turnoverCny: number | null;
  /** 主力淨流入（元） */
  mainNetCny: number | null;
  upCount: number | null;
  downCount: number | null;
  leaderSymbol: string | null;
  leaderName: string | null;
  leaderPct: number | null;
  /** 板塊內漲停家數（行業版 join 漲停池 industry；概念版 P2 前 null） */
  limitUpCount: number | null;
  /** 當日漲幅名次（同 kind 內 1-based） */
  rank: number;
  /** 近 5 日累計漲幅 %（寫入時讀前 4 日檔自算；不足 → null） */
  pct5d: number | null;
}

export interface BoardsDay {
  schemaVersion: number;
  date: string;
  fetchedAt: string;
  source: CnAgentsDataSource;
  industries: BoardEntry[];
  concepts: BoardEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// 人氣熱度（data/cn-agents/hotness/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export interface HotRankEntry {
  symbol: string;
  name: string | null;
  /** 東財人氣榜名次 1-based */
  rank: number;
  rankYesterday: number | null;
  /** 正 = 上升（昨 50 → 今 10 = +40） */
  rankChange: number | null;
  /** 連續在榜（top100）天數，含今日 */
  daysInTop100: number;
}

export interface HotnessDay {
  schemaVersion: number;
  date: string;
  fetchedAt: string;
  source: CnAgentsDataSource;
  emRank: HotRankEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// 龍虎榜（P2；data/cn-agents/lhb/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 席位類型 — registry 匹配貼標：
 *   hot_money（知名游資）/ institution（機構專用）/ retail_proxy（散戶通道，
 *   席位名含「拉萨」的東財導流營業部全中）/ quant（量化）/
 *   northbound（沪股通/深股通专用）/ unknown（沒中 registry）
 */
export type SeatType =
  | 'hot_money'
  | 'institution'
  | 'retail_proxy'
  | 'quant'
  | 'northbound'
  | 'unknown';

export const SEAT_TYPE_LABELS: Record<SeatType, string> = {
  hot_money: '游資',
  institution: '機構',
  retail_proxy: '散戶通道',
  quant: '量化',
  northbound: '北向通道',
  unknown: '一般',
};

export interface SeatTrade {
  /** EM OPERATEDEPT_CODE — 席位統計以此為主鍵（席位改名不斷檔） */
  deptCode: string;
  deptName: string;
  /** 買入金額（元） */
  buyAmt: number | null;
  sellAmt: number | null;
  netAmt: number | null;
  type: SeatType;
  /** registry 標籤（例「章盟主」「拉薩軍團」）；沒中 → null */
  label: string | null;
}

export interface LhbStockEntry {
  /** 6 位裸碼 */
  code: string;
  name: string;
  board: CnBoardKind;
  close: number | null;
  /** 當日漲跌幅 % */
  changeRate: number | null;
  /** 上榜原因（EXPLANATION）—(code, reason) 為複合鍵，同股可因多原因多次上榜 */
  reason: string;
  /** EM TRADE_ID（席位明細 join 用） */
  tradeId: string | null;
  /** 榜面淨買（元） */
  netAmt: number | null;
  buyAmt: number | null;
  sellAmt: number | null;
  /** 當日成交額（元） */
  accumAmount: number | null;
  /** 流通市值（元）— mainFlow 子分比例分母 */
  freeMarketCap: number | null;
  /** 換手率 % */
  turnoverRate: number | null;
  /** EM 榜面自帶前瞻報酬（事後才填值，seats-rebuild cron 回補 3 日前榜單） */
  fwd: { d1: number | null; d2: number | null; d5: number | null; d10: number | null };
  /** 買賣五席位明細（detailFetched=false 時為空陣列） */
  seats: { buy: SeatTrade[]; sell: SeatTrade[] };
  seatSummary: {
    hotMoneyBuyCount: number;
    institutionBuyCount: number;
    institutionSellCount: number;
    retailProxyBuyCount: number;
    quantBuyCount: number;
    northboundBuyCount: number;
    /** 買一佔買五合計比例 0-1（一家獨大判定）；買五全空 → null */
    buyOneDominance: number | null;
  };
}

export interface LhbDailyFile {
  schemaVersion: number;
  date: string;
  fetchedAt: string;
  /** 席位明細是否已抓（回填「全榜-only」模式 = false） */
  detailFetched: boolean;
  stocks: LhbStockEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// 席位 registry 與績效統計（data/cn-agents/seats/）
// ────────────────────────────────────────────────────────────────────────────

/** registry.json 一條：deptCode 精確匹配優先，否則 namePattern substring 匹配 */
export interface SeatRegistryEntry {
  deptCode?: string;
  namePattern?: string;
  label: string;
  type: SeatType;
  /** 風格備註：'daban' / 'swing' / 'dump_next_day' 等自由文字 */
  style?: string;
  note?: string;
}

export interface SeatRegistryFile {
  schemaVersion: number;
  updatedAt: string;
  seats: SeatRegistryEntry[];
}

/** stats.json 一條 — 每晚從 lhb/*.json 全量重建（非增量，避免 drift） */
export interface SeatStatsEntry {
  deptCode: string;
  deptName: string;
  label: string | null;
  type: SeatType;
  nEvents: number;
  nBuy: number;
  nSell: number;
  /** 買入後前瞻（EM fwd 欄）；樣本不足 → null */
  buyFwd: {
    avgD1: number | null;
    avgD5: number | null;
    avgD10: number | null;
    winD1: number | null;
    winD5: number | null;
  };
  /** 買入後隔日出現在同股賣方的比例（隔日砸盤率）÷ nBuy */
  nextDayDumpRate: number | null;
  topIndustries: Array<{ industry: string; n: number }>;
  lastSeen: string;
  /** 最近 10 筆參與紀錄 */
  recent: Array<{
    date: string;
    code: string;
    name: string;
    side: 'buy' | 'sell';
    netAmt: number | null;
    fwdD1: number | null;
  }>;
}

export interface SeatStatsFile {
  schemaVersion: number;
  builtAt: string;
  windowFrom: string;
  windowTo: string;
  seats: SeatStatsEntry[];
}

// ────────────────────────────────────────────────────────────────────────────
// 回測事件（P2；data/cn-agents/events/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

/** 事件來源：P2 先追硬分數，P3 總決策上線後並行對照 */
export type CnAgentSource = 'hard_score_v0' | 'master_decision';

/** A=可操作 / B=觀察 / C=避開（C 也入事件，驗證「避開」是否真的該避） */
export type CnTier = 'A' | 'B' | 'C';

/** 操作模式（v0 為規則簡化版；P3 tacticClassifier 上線後細化） */
export type CnRecoMode = 'daban' | 'banlu' | 'dixi' | 'swing' | 'watch';

export const RECO_MODE_LABELS: Record<CnRecoMode, string> = {
  daban: '打板',
  banlu: '半路',
  dixi: '低吸',
  swing: '波段',
  watch: '觀察',
};

// ────────────────────────────────────────────────────────────────────────────
// 新聞/政策快訊（P3；data/cn-agents/news/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export interface NewsItem {
  title: string;
  summary: string | null;
  /** 發布時間（來源原字串，可能含時分） */
  publishTime: string | null;
  url: string | null;
  /** 程式粗標：命中政策關鍵詞（央行/證監會/國常會/部委…）→ 給 skill 重點看 */
  policyCandidate: boolean;
}

export interface NewsDigestDay {
  schemaVersion: number;
  date: string;
  fetchedAt: string;
  source: 'em-7x24' | 'sina-7x24' | 'none';
  items: NewsItem[];
  policyCount: number;
}

// ────────────────────────────────────────────────────────────────────────────
// 題材/政策語意層（P3；skill 寫 data/cn-agents/analysis/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export type ThemeStage = 'fermenting' | 'main_rise' | 'divergence' | 'ebb';

export const THEME_STAGE_LABELS: Record<ThemeStage, string> = {
  fermenting: '發酵',
  main_rise: '主升',
  divergence: '分歧',
  ebb: '退潮',
};

export type PolicyLevel = 'national' | 'ministry' | 'local' | 'industry' | 'none';
export type PolicyDirection = 'positive' | 'negative';

export interface AnalysisTheme {
  id: string;
  name: string;
  stage: ThemeStage;
  /** 主線地位 0-100（skill 評：漲停家數佔比/持續天數/空間板高度/是否日報主線） */
  strength: number;
  /** 政策連結（無 → null） */
  policy_link: { event: string; level: PolicyLevel; direction: PolicyDirection } | null;
  leader_symbol: string | null;
  member_symbols: string[];
  logic_summary: string;
}

export interface AnalysisPolicyEvent {
  title: string;
  level: PolicyLevel;
  direction: PolicyDirection;
  affected_theme_ids: string[];
  note: string;
}

export type StockPosition = 'leader' | 'core' | 'follower' | 'misc';

export interface StockSemantics {
  /** 6 位裸碼，必須 ⊆ question.candidates（validateAnalysis 強制，防 skill 自創代號） */
  symbol: string;
  theme_id: string | null;
  position: StockPosition;
  /** 0-100；無題材歸屬可 null（compose 重加權） */
  policy_score: number | null;
  theme_score: number | null;
  sentiment_note: string;
  risk_note?: string;
}

export interface CnAnalysisFile {
  schemaVersion: number;
  date: string;
  generatedAt: string;
  themes: AnalysisTheme[];
  policy_events: AnalysisPolicyEvent[];
  stock_semantics: StockSemantics[];
  /** ≤200 字市場敘事 */
  market_narrative: string;
  report_written: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// 每日總決策（P3；compose 寫 data/cn-agents/daily/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export interface DailyCandidate {
  code: string;
  name: string;
  symbol: string;
  board: CnBoardKind;
  rank: number;
  totalScore: number;
  light: string;
  confidence: string;
  tier: CnTier;
  mode: CnRecoMode;
  /** 10 子分（缺值 null） */
  subScores: Record<string, number | null>;
  available: string[];
  missing: string[];
  themeId: string | null;
  position: StockPosition | null;
  reasons: string[];
  /**
   * 買進前紅旗（基本面/籌碼/治理避雷檢查；2026-06-13）。
   * 只標示不改 totalScore/tier（守升級規則：改分數要先回測）；
   * shouldAvoid 的會同時進 CnDailyFile.avoidList。缺資料 → 不亮旗（undefined）。
   */
  redFlags?: RedFlag[];
}

export interface CnDailyFile {
  schemaVersion: number;
  scoringVersion: string;
  cycleRulesVersion: string;
  date: string;
  generatedAt: string;
  /** skill analysis 是否就位（false = 政策/題材重加權產出） */
  analysisPresent: boolean;
  marketMood: {
    stage: EmotionStage;
    stageLabel: string;
    emotionScore: number;
    strategyLabel: string;
    positionPct: [number, number];
    narrative: string | null;
  };
  themes: AnalysisTheme[];
  candidates: DailyCandidate[];
  top10: string[];
  actionList: Array<{ symbol: string; name: string; tier: CnTier; mode: CnRecoMode; note: string }>;
  avoidList: Array<{ symbol: string; name: string; reason: string }>;
  reportMdKey: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// cron 健康紀錄（data/cn-agents/_health/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export interface CnAgentsStepHealth {
  step: string;
  ok: boolean;
  source?: CnAgentsDataSource;
  /** 'degraded' = 主源失敗走備援 */
  note?: string;
  error?: string;
  finishedAt: string;
}

export interface CnAgentsHealthDay {
  schemaVersion: number;
  date: string;
  steps: CnAgentsStepHealth[];
}
