// ============================================================
// 題材熱度 × 三色策略 交叉選股 — 型別「單一事實來源」。
//
// 隔離原則：本系統是「自創顯示/研究因子的交叉」（題材熱度 × 三色），
// 鏡像 lib/cn-sanse/、lib/cn-agents/ 的隔離先例。完全獨立於書本選股鏈
// （lib/selection/applyPanelFilter、lib/scanner/*、store/backtestStore），
// 不違反鐵則 #5。所有產出存 data/theme-sanse/{market}/{domain}/{date}.json。
//
// market 參數化：台股(TW) + 陸股(CN) 共用同一套程式。三色狀態/具名策略/combo
// grade/前瞻報酬一律 import 既有單一事實，不重新定義。
// ============================================================

import type { RecoBaseline } from '@/lib/backtest/eventBaseline';
import type { RecoReturns } from '@/lib/backtest/eventReturns';
import type { ComboGrade, MainStage, TradeVerdict } from '@/lib/cn-sanse/conditions';
import type { StrategyId } from '@/lib/cn-sanse/namedStrategies';

export const THEME_SANSE_SCHEMA_VERSION = 1;

export type TsMarket = 'TW' | 'CN';
export type Cohort = 'cross' | 'theme' | 'sanse';

/** 各 market 算超額用的指數（computeEventReturns 注入）。 */
export const INDEX_SYMBOL_BY_MARKET: Record<TsMarket, string> = { TW: '^TWII', CN: '000001.SS' };

// ────────────────────────────────────────────────────────────────────────────
// 三色狀態（衍生自 ConditionReport.mainStage；對映使用者要的「剛啟動/剛轉強/偏高」）
// ────────────────────────────────────────────────────────────────────────────

/** null = 未達主力階段（不該出現在 cross/sanse cohort，passesSanse 會擋掉）。 */
export type SanseState = MainStage | null;

export const SANSE_STATE_LABEL: Record<MainStage, string> = {
  ignite: '剛啟動',
  develop: '剛轉強',
  full: '偏高',
};

/** 三色狀態 → 燈號（閱讀障礙友善；🟡早 🟣中 🔴高）。 */
export const SANSE_STATE_LIGHT: Record<MainStage, string> = {
  ignite: '🟡',
  develop: '🟣',
  full: '🔴',
};

// ────────────────────────────────────────────────────────────────────────────
// 熱門題材（TW/CN 同型別）
// ────────────────────────────────────────────────────────────────────────────

/** 熱度合成的各分項權重 — 單一事實。各分項缺值不計（只對「有值的權重」重正規化）。 */
export const HEAT_WEIGHTS = {
  avgRet: 0.25,        // 漲幅排名
  limitUp: 0.2,        // 漲停家數
  consecBoard: 0.1,    // 最高連板
  volume: 0.15,        // 成交量放大
  inflow: 0.15,        // 資金流入
  popularity: 0.08,    // 人氣榜
  lhbNet: 0.07,        // 龍虎榜淨買
} as const;
export type HeatSignalKey = keyof typeof HEAT_WEIGHTS;

/** 熱度各分項原始值（缺 = null；scoring 時做當日 rank-percentile 正規化）。 */
export interface HotThemeWhy {
  avgRet: number | null;        // 題材平均漲幅 %（TW: avgD5；CN: 漲停股平均 pct / 板塊 pct）
  limitUpCount: number | null;  // 漲停家數
  maxConsecBoard: number | null;// 最高連板
  volExpansion: number | null;  // 成交量放大（TW: avgVolRatio；CN: 板塊成交額）
  mainNetInflow: number | null; // 資金流入（TW: instNet5 張；CN: 板塊 mainNetCny 元）
  popularity: number | null;    // 人氣（CN hotness rankChange 聚合；TW null）
  lhbNetBuy: number | null;     // 龍虎榜淨買（CN lhb netAmt 聚合；TW null）
  breadth: number | null;       // 上漲家數比 0-1（資訊欄，不計分）
}

export type HotThemeKind = 'tw_theme' | 'cn_industry' | 'cn_concept' | 'cn_analysis';
export type HotThemeSource = 'tw_sector' | 'cn_live' | 'cn_limitup_bt';

export interface HotThemeMember {
  code: string;                 // 裸碼（TW 4 位 / CN 6 位）
  name: string;
  /** 全代號（走圖/結算用）；TW = {code}.TW|.TWO、CN = {code}.SS|.SZ|.BJ */
  symbol: string;
  /** 個股熱度 proxy（theme-only cohort 排序用）；TW: d5/d1、CN: 連板數；無 → null */
  score: number | null;
}

export interface HotTheme {
  id: string;                   // TW: 題材中文名；CN-analysis: analysis id；CN-industry: 'industry:<名>'；CN-concept: 'BKxxxx'
  name: string;
  kind: HotThemeKind;
  heatScore: number;            // 0-100 合成（同 market+date 內可比）
  heatRank: number;             // 1-based（heatScore desc）
  why: HotThemeWhy;
  /** 成分（依 score desc 排序；CN-analysis 可能無 score）。 */
  members: HotThemeMember[];
  memberCount: number;
  /** 龍頭裸碼（CN 用於判斷龍頭是否在創業/科創 → 三色掃不到的覆蓋揭露）；無 → null。 */
  leaderCode: string | null;
  /** 顯示用階段（TW 六階段 / CN 題材階段）；無 → null。 */
  stageLabel?: string | null;
  /** 「為什麼熱」催化敘事（CN analysis logic_summary / 政策事件）；無 → null。 */
  catalyst?: string | null;
  source: HotThemeSource;
  /** true = 由重建/近似來源產生（CN 回測用 limitup 重建）；TW sector / CN live = false。 */
  degraded: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// 交叉選股（crossSelect 純函式輸出）
// ────────────────────────────────────────────────────────────────────────────

export interface ThemeRef {
  themeId: string;
  themeName: string;
  heatRank: number;
}

/** 三色覆蓋揭露：CN 三色掃描排除創業板/科創，熱門概念龍頭常在那邊 → 主板成員才有訊號。 */
export type ThemeSanseCoverage = 'full' | 'main_board_only';

/** 交叉候選：同時 ∈ 熱門題材 且 過三色 gate。 */
export interface CrossCandidate {
  code: string;
  symbol: string;
  name: string;
  themes: ThemeRef[];           // 命中的熱門題材（取 top 集合內者）
  bestThemeRank: number;        // 所屬熱門題材中最熱的名次
  namedStrategies: StrategyId[];
  sanseState: SanseState;       // 剛啟動/剛轉強/偏高
  comboGrade: ComboGrade;
  verdict: TradeVerdict;        // buy=可追高 / wait=等回踩 / sell|conflict 已被 gate 擋掉
  verdictReason: string;
  verdictReversal: boolean;     // 底反該買🔥（OOS 最高把握）
  reason: string;               // 白話推薦理由
  riskNote: string;             // 白話風險提醒
  themeSanseCoverage: ThemeSanseCoverage;
}

/** theme-only 對照：熱門題材成分（不要求三色）。 */
export interface ThemeCandidate {
  code: string;
  symbol: string;
  name: string;
  theme: string;
  themeHeatRank: number;
  score: number | null;         // 個股熱度 proxy
  reason: string;
}

/** sanse-only 對照：過三色 gate（不論題材）。 */
export interface SanseCandidate {
  code: string;
  symbol: string;
  name: string;
  industry: string;
  namedStrategies: StrategyId[];
  sanseState: SanseState;
  comboGrade: ComboGrade;
  verdict: TradeVerdict;
  reason: string;
}

export interface CohortSelection {
  cross: CrossCandidate[];
  theme: ThemeCandidate[];
  sanse: SanseCandidate[];
}

/** 可調門檻（單一事實；每日 build 與回測腳本共用，禁 hard-code 散落）。 */
export interface CrossThresholds {
  topThemes: number;                 // 取前 N 熱門題材
  minComboRank: number;              // combo.rank ≥（prime=4）才算過三色
  excludeVerdicts: TradeVerdict[];   // 三色 gate 排除的一眼結論
  themeOnlyTopPerTheme: number;      // theme-only 每題材取前 N 強股
}

export const DEFAULT_CROSS_THRESHOLDS: CrossThresholds = {
  topThemes: 8,
  minComboRank: 4,                   // 'prime'（COMBO_RANK.prime = 4）
  excludeVerdicts: ['sell', 'conflict'],
  themeOnlyTopPerTheme: 5,
};

// ────────────────────────────────────────────────────────────────────────────
// 事件（回測；data/theme-sanse/{market}/events/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

/** 同股可在 cross/theme/sanse 各記一筆（複合主鍵含 cohort）。報酬不持久化，讀時 derive。 */
export interface ThemeSanseEvent {
  id: string;                   // `${market}:${date}:${cohort}:${code}`
  market: TsMarket;
  date: string;
  cohort: Cohort;
  code: string;
  symbol: string;
  name: string;
  // 凍結的註記（選出當下，不隨重算漂移）
  themeIds: string[];
  themeNames: string[];
  bestThemeRank: number | null;
  namedStrategies: StrategyId[];
  sanseState: SanseState;
  comboGrade: ComboGrade | null;
  verdict: TradeVerdict | null;
  verdictReversal: boolean;
  reason: string;
  /** 結算前 null；settle 後凍結（隔日開盤進場；一字 no_fill；停牌 skip）。 */
  baseline: RecoBaseline | null;
}

export interface ThemeSanseEventsFile {
  schemaVersion: number;
  market: TsMarket;
  date: string;
  generatedAt: string;
  thresholds: CrossThresholds;       // 凍結當日門檻（回測重現用）
  events: ThemeSanseEvent[];
}

// ────────────────────────────────────────────────────────────────────────────
// 每日快照（UI；data/theme-sanse/{market}/daily/{date}.json）
// ────────────────────────────────────────────────────────────────────────────

export interface DailyHotTheme {
  id: string;
  name: string;
  heatRank: number;
  whyHot: string;               // 白話「為什麼熱」
  whyHotLights: string[];       // 🔴🟣🟡 + 觸發點 chip
  memberCount: number;
  sanseHitCount: number;        // 該題材內過三色的檔數（cross 命中）
  stage?: string;               // 顯示用階段（TW 六階段 / CN 題材階段）
  degraded: boolean;
}

/** UI 候選列（報酬讀時注入，不持久化）。 */
export interface DailyCrossCandidate extends CrossCandidate {
  performance?: RecoReturns | null;
}

export interface ThemeSanseDaily {
  schemaVersion: number;
  market: TsMarket;
  date: string;
  generatedAt: string;
  hotThemes: DailyHotTheme[];
  crossCandidates: DailyCrossCandidate[];
  conclusion: string;           // 白話結論（程式模板，不打 LLM）
  conclusionLights: { red: string[]; purple: string[]; yellow: string[] };
  /** 未來選配 skill（/theme-sanse-narrate）增強用；v1 為 null。 */
  conclusionOverride: string | null;
  readiness: { themeHeat: boolean; sanseScan: boolean };
  coverage: { hotThemeCount: number; crossCount: number; sanseUniverse: number };
}

// re-export 既有單一事實，方便本模組內 import 一處
export type { ComboGrade, MainStage, TradeVerdict } from '@/lib/cn-sanse/conditions';
export type { StrategyId } from '@/lib/cn-sanse/namedStrategies';
export type { RecoBaseline } from '@/lib/backtest/eventBaseline';
export type { RecoReturns } from '@/lib/backtest/eventReturns';
