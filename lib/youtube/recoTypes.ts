/**
 * 老師推薦績效追蹤 — 型別定義（pure，client / script / route 皆可 import）。
 *
 * 資料流：
 *   analysis/{date}.json → extractRecoEvents() → recommendations/{date}.json（事件 + 凍結基準價）
 *   → API 讀取時從 L1 K 線即時算 d1..d60 報酬（報酬不持久化，永遠可重derive）
 *
 * 設計決議（2026-06-12 計畫核准）：
 *   - 事件 key = (date, teacher, stock_code)：同老師同股同日跨影片合併為一筆；
 *     之後日子再推 = 新事件（rolling 會混橫斷期，不做）。
 *   - 基準價 = 提及日 D 的次一交易日開盤（盤後節目的可執行價），結算一次後凍結。
 *   - 舊 analysis（無 recommendation_type 欄）用 sentiment fallback 映射。
 */

import type { StockSentiment } from './analysisStorage';
import type { SelStats } from '@/lib/backtest/leaderboardTypes';
import type { BaselineStatus, RecoBaseline } from '@/lib/backtest/eventBaseline';
import type { RecoHorizon, RecoReturns } from '@/lib/backtest/eventReturns';

// ── baseline / returns 型別 2026-06-13 上移到 lib/backtest/（陸股回測共用），此處 re-export 保持既有 import 路徑 ──
export type { BaselineStatus, RecoBaseline, RecoHorizon, RecoReturns };
export { RECO_HORIZONS, RECO_HORIZON_OFFSET, RECO_MFE_BARS } from '@/lib/backtest/eventReturns';

/** 推薦強度分級（節目語境用詞）。新分析由 skill 原生輸出；舊檔由 sentiment 映射。 */
export type RecommendationType =
  | '明確買進' | '看多' | '觀察' | '等回檔' | '小心追高' | '偏空' | '只介紹';

/**
 * 統計分組：
 *   scored  = 明確買進/看多 → 主勝率統計
 *   watch   = 觀察/等回檔   → 觀察池另列（不進主勝率）
 *   bearish = 偏空          → win 定義為「下跌」，另列
 *   excluded= 小心追高/只介紹 → 只計覆蓋率，不算績效
 */
export type RecoCohort = 'scored' | 'watch' | 'bearish' | 'excluded';

export interface RecoEventVideoRef {
  video_id: string;
  source_id: string;
  sentiment: StockSentiment;
  recommendation_type: RecommendationType;
  /** native = skill 原生輸出；sentiment_fallback = 舊 analysis 由 sentiment 映射 */
  type_source: 'native' | 'sentiment_fallback';
  context: string;
  reason: string;
  combined_confidence: number;
  /** 老師喊的目標價/停損價/當下價（簡報 OCR 或口述明確給的才有；多數 mention 無） */
  target_price?: number;
  stop_loss?: number;
  mentioned_price?: number;
}

export interface RecoEvent {
  /** `${date}:${teacher}:${stock_code}` */
  id: string;
  /** 提及/分析日 YYYY-MM-DD */
  date: string;
  /** 清洗後的老師名；無具名老師時為 `節目:${display_name}` */
  teacher: string;
  teacher_kind: 'person' | 'program_fallback';
  stock_code: string;
  stock_name: string;
  /** '2330.TW' | '8069.TWO' — 結算時凍結（TPEx→.TWO，載不到換另一後綴重試一次） */
  symbol: string;
  market: 'TWSE' | 'TPEx';
  /** 合併後最強的推薦型態 */
  recommendation_type: RecommendationType;
  cohort: RecoCohort;
  /** 同日同人對同股多空衝突 → true，排除統計 */
  conflict?: boolean;
  /** 老師喊的目標價/停損價（合併時取第一個有值的）；無則省略 */
  target_price?: number;
  stop_loss?: number;
  videos: RecoEventVideoRef[];
  baseline: RecoBaseline;
}

export interface RecoEventsFile {
  date: string;
  generated_at: string;
  /** 對應 analysis 檔的 generated_at — 分析重跑時據此判斷要重抽 */
  source_analysis_generated_at: string;
  events: RecoEvent[];
  skipped: {
    low_confidence: number;
    unmatched: number;
    placeholder: boolean;
  };
}

// ── 報酬（derive，不持久化）— RecoHorizon/RecoReturns/常數見 lib/backtest/eventReturns.ts ──

export interface RecoEventWithReturns extends RecoEvent {
  returns: RecoReturns | null;  // baseline 非 filled → null
}

// ── 排行榜列 ─────────────────────────────────────────────────────────────────

export interface RecoHorizonStats extends SelStats {
  /** mean(個股報酬 − 同期 ^TWII 報酬)；樣本不足 → null */
  excessAvgPct: number | null;
}

export interface TeacherRow {
  teacher: string;
  programs: Array<{ source_id: string; display_name: string }>;
  /** 全 cohort 事件數（覆蓋率） */
  total_events: number;
  /** cohort=scored 且 baseline=filled（進主統計的樣本） */
  scored_events: number;
  watch_events: number;
  bearish_events: number;
  /** 隔日一字鎖死買不到 */
  unfillable: number;
  no_data: number;
  /** d60 還沒走完的 scored 事件數 */
  open_events: number;
  byHorizon: Record<RecoHorizon, RecoHorizonStats>;
  /** D20 賺賠比 = avg(贏家) / |avg(輸家)|；無輸家或樣本 <3 → null */
  payoffRatio: number | null;
  /** scored 事件 60 根 MFE/MAE 均值 */
  mfeAvgPct: number | null;
  maeAvgPct: number | null;
  /** 最佳一筆 scored 事件（D20 為準；資料太新 D20 未到期時退 D5） */
  bestPick: { date: string; stock_code: string; stock_name: string; d20: number | null; d5: number | null } | null;
  /** 最雷一筆 scored 事件（同口徑取最差，揭露老師的雷） */
  worstPick: { date: string; stock_code: string; stock_name: string; d20: number | null; d5: number | null } | null;
  /** 最近 5 筆事件（drill-down 預覽） */
  recentEvents: RecoEventWithReturns[];
}

/** 節目彙總列 — 事件按 (stock, date) 去重避免同節目多老師重複計 */
export interface ProgramRow {
  source_id: string;
  display_name: string;
  teachers: string[];
  total_events: number;
  scored_events: number;
  unfillable: number;
  open_events: number;
  byHorizon: Record<RecoHorizon, RecoHorizonStats>;
  payoffRatio: number | null;
  mfeAvgPct: number | null;
  maeAvgPct: number | null;
  bestPick: { date: string; stock_code: string; stock_name: string; d20: number | null; d5: number | null } | null;
  worstPick: { date: string; stock_code: string; stock_name: string; d20: number | null; d5: number | null } | null;
}

/** 股票彙總列 — 共識股 / 最多節目提到 / 共識地雷股 共用 */
export interface StockAggRow {
  stock_code: string;
  stock_name: string;
  teacherCount: number;        // 幾位不同老師推
  programCount: number;        // 幾個不同節目提到
  totalMentions: number;       // 總事件數（=被推幾次）
  teachers: string[];
  programs: string[];          // 節目 display_name
  firstDate: string;           // 第一次被推日
  lastDate: string;            // 最近被推日
  themes: string[];            // 所屬題材
  byHorizon: Record<RecoHorizon, RecoHorizonStats>;  // 這檔被推後 D1~D20 平均
  mfeAvgPct: number | null;
  maeAvgPct: number | null;
  avgHold: number | null;      // 持有至今平均（地雷股排序用）
}

/** 單筆極值事件 — 推薦後漲/跌最多 */
export interface ExtremeEvent {
  horizon: RecoHorizon;
  stock_code: string;
  stock_name: string;
  teacher: string;
  programs: string[];
  date: string;                // 推薦日
  entry_open: number | null;
  ret: number;                 // 該 horizon 漲跌幅 %
  themes: string[];
}

export interface TeacherLeaderboardResponse {
  window: {
    start: string; end: string; days: number; eventDates: number;
    /** 時光機 as-of 日：有值代表「站在這天回看」，報酬只算到這天為止（無前視偏誤） */
    asOf?: string;
  };
  /** 視窗內資料覆蓋統計（UI「抓了多少」說明用） */
  coverage: {
    totalEvents: number;       // 全部推薦事件
    scoredEvents: number;      // 進評分統計（明確買進/看多 且已結算進場價）
    uniqueVideos: number;      // 集數
    uniquePrograms: number;    // 節目數
    namedTeachers: number;     // 具名老師數
  };
  /** 進場價基準說明（UI 顯示） */
  entryBaseline: 'next-open';
  generatedAt: string;
  /** teacher_kind='person' 的老師列 */
  teachers: TeacherRow[];
  /** 含 program_fallback 事件的節目列 */
  programs: ProgramRow[];
  /** 共識地雷股：≥2 位老師同推、但持有至今平均最差的股票（集體誤判警示） */
  worstStocks: StockAggRow[];
  /** 共識股：被最多「不同老師」推的股票 */
  consensusStocks: StockAggRow[];
  /** 被最多「不同節目」提到的股票 */
  topByProgram: StockAggRow[];
  /** 推薦後漲最多（每個橫斷 top N） */
  gainers: Record<RecoHorizon, ExtremeEvent[]>;
  /** 推薦後跌最多（每個橫斷 top N） */
  losers: Record<RecoHorizon, ExtremeEvent[]>;
  meta: {
    /** 正式榜門檻：scored_events ≥ 此數才進正式榜，否則潛力觀察榜 */
    minScored: number;
    /** 官方 OpenAPI 優先；短暫故障時揭露所用官方快照日期。 */
    officialIndustry: { source: 'openapi' | 'persisted_snapshot'; asOf: string | null };
    survivorshipNote: string;
  };
}
