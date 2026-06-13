/**
 * Analysis storage（zhu-style，無 Anthropic SDK）。
 *
 * 流程：
 *   1. 程式 cron 寫 question 到 /tmp/rockstock-youtube/{date}-question.json
 *   2. 使用者在 Claude Code 對話裡讀 question.json 做分析
 *   3. Claude（在對話裡）寫結構化 answer 到 data/youtube/analysis/{date}.json
 *   4. 前端 /youtube 讀 data/youtube/analysis/{date}.json 顯示
 *
 * 設計目標：question 是 ephemeral（/tmp 隨時可重產生），answer 持久化於 repo 的 data/。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { loadStockMaster } from './stockMaster';
import type { StockLookupResult, StockMasterFile } from './stockMaster';
import { validateAnalysisNames } from './validateAnalysisNames';

const IS_VERCEL = !!process.env.VERCEL;
const BLOB_PREFIX = 'youtube';
const FS_ROOT = path.join(process.cwd(), 'data', 'youtube');

export type StockSentiment =
  | 'bullish' | 'bearish' | 'neutral' | 'watchlist'
  | 'risk_warning' | 'mentioned_only';

/** mention 的證據來源（keyframe 管線 2026-06-12 加；舊分析無此欄 = 'speech' 視之） */
export type MentionSourceType = 'speech' | 'slide' | 'speech+slide';

/** 推薦強度分級（節目語境用詞；老師績效追蹤的 cohort 依據，見 recoEvents.ts） */
export type RecommendationType =
  | '明確買進' | '看多' | '觀察' | '等回檔' | '小心追高' | '偏空' | '只介紹';

/** Claude 分析後寫回的單筆股票 mention（已通過 stockMaster 對照） */
export interface AnalyzedStockMention {
  /** raw_query 是 Claude 從逐字稿認出的原文（名稱/代號） */
  raw_query: string;
  matched: StockLookupResult | null;
  llm_confidence: number;       // Claude 的自評信心（提取本身有沒有正確）
  combined_confidence: number;  // llm_confidence × matched.confidence
  sentiment: StockSentiment;
  context: string;              // 原話片段
  reason: string;               // 看多/看空理由
  source_id: string;            // 來自哪個 channel
  video_id: string;             // 來自哪支影片
  /**
   * 講這檔股票的分析師（主持人 + 來賓）。從 video.analysts 帶下來。
   * 理財達人秀類節目有來賓輪替，這欄讓「哪檔股票是誰說的」可被追蹤。
   * 例：["李兆華", "朱家泓"] / ["蔡萬得"] / ["錢線百分百"]（無明確分析師時的 fallback）。
   */
  analysts?: string[];

  // ── keyframe 管線新欄（2026-06-12；全部 optional，舊 analysis 檔向下相容）──
  /** 證據來源：純口述 / 純簡報截圖 / 兩者皆有。新分析必填；舊檔缺 = 'speech' */
  source_type?: MentionSourceType;
  /** 影片內提及秒數（slide 取 keyframe ts；speech 取 cue start；皆有取較早者） */
  mention_time?: number;
  /** 佐證截圖 repo 相對路徑（data/youtube/keyframes/...），無則省略 */
  screenshot_ref?: string;
  /** 推薦強度分級；舊檔缺 → recoEvents 由 sentiment fallback 映射 */
  recommendation_type?: RecommendationType;
  /** 提及當下講的價位（簡報/口述；無則省略） */
  mentioned_price?: number;
  /** 目標價（簡報/口述明確給的才填，不可推算） */
  target_price?: number;
  /** 停損價（同上） */
  stop_loss?: number;
}

/** MVP 5: 每檔股票的多因子評分 + A/B/C/D 分級 */
export type StockRating = 'A' | 'B' | 'C' | 'D';

export interface FactorScores {
  /** 0-100，權重 25 — K線/均線/趨勢/量價（YouTube 節目「對技術面的看法」評分，非 Signal 層真實 K 棒指標） */
  technical: number;
  /**
   * 0-100，權重 18 — 節目「對籌碼面的看法」評分。
   * ⚠ 與 Signal 層 `chipScore`（L4 真實籌碼資料計分）**不同**，
   *   這是 YouTube 主持人觀點 + 多節目共識的綜合分。
   */
  chip_narrative: number;
  /** 0-100，權重 15 — EPS/營收/毛利率/ROE（節目觀點） */
  fundamental: number;
  /** 0-100，權重 12 — 公司公告/新聞/題材延續性 */
  news: number;
  /** 0-100，權重 10 — 節目跨來源熱度（mention_count + 共識方向） */
  mention_heat: number;
  /** 0-100，權重 10 — 同產業強弱位階 + 族群輪動受惠度 */
  industry: number;
  /** 0-100，權重 5 — 大盤環境契合度（多頭加分、空頭減分） */
  macro: number;
  /** 0-100，權重 3 — 本益比/PB/殖利率/同業比較 */
  valuation: number;
  /** 0-100，權重 2 — 外資長期持股趨勢 / 內部人交易 */
  governance: number;

  /** @deprecated use `chip_narrative`. Kept for backwards-compat with old analysis files. */
  chip?: number;
}

export interface StockScoring {
  stock_code: string;
  stock_name: string;
  /** 各維度 0-100 分數 */
  factor_scores: FactorScores;
  /** 加權後 0-100 總分 */
  composite_score: number;
  /** A: ≥75, B: 60-74, C: 45-59, D: <45 */
  rating: StockRating;
  /** 推介結論一句話：優先觀察 / 等回測 / 等突破 / 不追高 / 暫時排除 */
  action: string;
  /** 風險旗標 */
  risk_flags: string[];
  /** 評分依據摘要 */
  reasoning: string;
}

export interface DailyAnalysis {
  date: string;                 // YYYY-MM-DD Asia/Taipei
  generated_at: string;         // ISO，Claude 寫入時
  /** true=手動填的示範資料，不是真實 LLM 分析。前端應提示用戶 */
  is_placeholder?: boolean;
  /** 跨節目大盤共識 */
  market_view: string;
  /** 多數節目共同看好的方向 */
  bullish_consensus: string[];
  /** 多數節目提醒的風險 */
  bearish_consensus: string[];
  /** ≥2 節目共同點到、且 sentiment 同向的股票（最有信號的） */
  high_consensus_stocks: AnalyzedStockMention[];
  /** 其他被提到、但信號弱（單一節目或意見分歧）的股票 */
  weak_signal_stocks: AnalyzedStockMention[];
  /** MVP 5: 每檔被提到股票的多因子評分（可選 — 舊 analysis 沒這欄） */
  stock_scoring?: StockScoring[];
  /** 統計 */
  stats: {
    videos_analyzed: number;
    unique_stocks_total: number;
    high_consensus_count: number;
    weak_signal_count: number;
    /** rating 分佈（MVP 5 後加） */
    rating_distribution?: { A: number; B: number; C: number; D: number };
  };
}

/**
 * 計算加權總分 (規格 §37 完整 9 維權重)。
 *
 * 權重表（總和 = 100）：
 *   tech 25, chip 18, fundamental 15, news 12, mention_heat 10,
 *   industry 10, macro 5, valuation 3, governance 2
 */
export const FACTOR_WEIGHTS = {
  technical: 25, chip_narrative: 18, fundamental: 15,
  news: 12, mention_heat: 10, industry: 10,
  macro: 5, valuation: 3, governance: 2,
} as const;

export function computeCompositeScore(s: FactorScores): number {
  // fallback `s.chip` 為了向後相容舊 analysis 檔案（pre-rename）
  const chipNarrative = s.chip_narrative ?? s.chip ?? 0;
  const weighted =
    s.technical * FACTOR_WEIGHTS.technical +
    chipNarrative * FACTOR_WEIGHTS.chip_narrative +
    s.fundamental * FACTOR_WEIGHTS.fundamental +
    s.news * FACTOR_WEIGHTS.news +
    s.mention_heat * FACTOR_WEIGHTS.mention_heat +
    s.industry * FACTOR_WEIGHTS.industry +
    s.macro * FACTOR_WEIGHTS.macro +
    s.valuation * FACTOR_WEIGHTS.valuation +
    s.governance * FACTOR_WEIGHTS.governance;
  return Math.round((weighted / 100) * 10) / 10;  // 1 decimal
}

export function ratingFromScore(score: number): StockRating {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  return 'D';
}

/**
 * 跨影片彙整：以 stock_code 為 key 顯示今日多少節目提到、整體情緒、各影片 context。
 * 此結構是 /youtube 前端「今日提到的股票」表的資料來源，從 DailyAnalysis 衍生。
 */
export interface DailyStockMention {
  stock_code: string;
  stock_name: string;
  mentioned_in: Array<{
    video_id: string;
    source_id: string;
    sentiment: StockSentiment;
    context: string;
    reason: string;
    combined_confidence: number;
    /** 這集講這檔股票的分析師（從 video.analysts 帶下來） */
    analysts?: string[];
    /** keyframe 管線新欄（optional 透傳） */
    source_type?: MentionSourceType;
    mention_time?: number;
    screenshot_ref?: string;
    recommendation_type?: RecommendationType;
    target_price?: number;
    stop_loss?: number;
  }>;
  mention_count: number;
  bullish_count: number;
  bearish_count: number;
  best_confidence: number;
  /** MVP 5: 多因子評分（若 analysis 有對此股評分則填，否則 undefined） */
  scoring?: {
    rating: StockRating;
    composite_score: number;
    factor_scores: FactorScores;
    action: string;
    risk_flags: string[];
    reasoning: string;
  };
}

export interface DailyStockMentions {
  date: string;
  generated_at: string;
  total_videos_processed: number;
  total_unique_stocks: number;
  stocks: DailyStockMention[];
}

// ── path helpers ─────────────────────────────────────────────────────────────

function blobPath(key: string): string { return `${BLOB_PREFIX}/${key}`; }
function fsPath(key: string): string { return path.join(FS_ROOT, key); }

async function blobPut(key: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(blobPath(key), data, {
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json',
  });
}

async function blobGet(key: string): Promise<string | null> {
  try {
    const { get } = await import('@vercel/blob');
    const result = await get(blobPath(key), { access: 'private' });
    if (!result || !result.stream) return null;
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } catch { return null; }
}

async function fsPut(key: string, data: string): Promise<void> {
  const target = fsPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicFsPut(target, data);
}

async function fsGet(key: string): Promise<string | null> {
  try { return await fs.readFile(fsPath(key), 'utf-8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** dual-storage put（Vercel→Blob / 本地→FS）。export 給 recoStorage 等同 prefix 模組重用。 */
export async function putJson<T>(key: string, value: T): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  if (IS_VERCEL) await blobPut(key, data); else await fsPut(key, data);
}

/** dual-storage get。export 給 recoStorage 等同 prefix 模組重用。 */
export async function getJson<T>(key: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(key) : await fsGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch (err) {
    console.error(`[analysisStorage] parse failed ${key}:`, err);
    return null;
  }
}

// ── public ───────────────────────────────────────────────────────────────────

function analysisKey(date: string): string {
  return `analysis/${date}.json`;
}

export async function loadDailyAnalysis(date: string): Promise<DailyAnalysis | null> {
  return await getJson<DailyAnalysis>(analysisKey(date));
}

export async function saveDailyAnalysis(analysis: DailyAnalysis): Promise<void> {
  // 寫入前驗證 code/name 對應 stock-master（防寫錯名持久化進 git，如 4958「臻鼎」應為「臻鼎-KY」）。
  // master 載入失敗（離線/限流）→ 略過驗證照常寫；只有「確定不符」才擋下並拋錯，與合約測試共用同一份規則。
  let master: StockMasterFile | null = null;
  try { master = await loadStockMaster(); } catch { master = null; }
  if (master) {
    const errs = validateAnalysisNames(analysis, master);
    if (errs.length > 0) {
      throw new Error(`analysis 名稱與 stock-master 不符（${errs.length} 筆，請修正代號/名稱後再存）：${errs.slice(0, 5).join('; ')}`);
    }
  }
  await putJson(analysisKey(analysis.date), analysis);
}

/** Derive 前端用的 stock-mentions 結構（從 DailyAnalysis 計算，不再單獨持久化） */
export function deriveStockMentions(a: DailyAnalysis): DailyStockMentions {
  const byCode = new Map<string, DailyStockMention>();
  const allMentions = [...a.high_consensus_stocks, ...a.weak_signal_stocks];

  for (const m of allMentions) {
    if (!m.matched) continue;
    if (m.combined_confidence < 0.6) continue;
    const code = m.matched.code;
    let agg = byCode.get(code);
    if (!agg) {
      agg = {
        stock_code: code,
        stock_name: m.matched.name,
        mentioned_in: [],
        mention_count: 0,
        bullish_count: 0,
        bearish_count: 0,
        best_confidence: 0,
      };
      byCode.set(code, agg);
    }
    agg.mentioned_in.push({
      video_id: m.video_id,
      source_id: m.source_id,
      sentiment: m.sentiment,
      context: m.context,
      reason: m.reason,
      combined_confidence: m.combined_confidence,
      analysts: m.analysts,
      source_type: m.source_type,
      mention_time: m.mention_time,
      screenshot_ref: m.screenshot_ref,
      recommendation_type: m.recommendation_type,
      target_price: m.target_price,
      stop_loss: m.stop_loss,
    });
    agg.mention_count += 1;
    if (m.sentiment === 'bullish') agg.bullish_count += 1;
    if (m.sentiment === 'bearish' || m.sentiment === 'risk_warning') agg.bearish_count += 1;
    if (m.combined_confidence > agg.best_confidence) agg.best_confidence = m.combined_confidence;
  }

  // MVP 5: merge in scoring if present
  if (a.stock_scoring) {
    const scoringByCode = new Map(a.stock_scoring.map(s => [s.stock_code, s]));
    for (const m of byCode.values()) {
      const sc = scoringByCode.get(m.stock_code);
      if (sc) {
        m.scoring = {
          rating: sc.rating,
          composite_score: sc.composite_score,
          factor_scores: sc.factor_scores,
          action: sc.action,
          risk_flags: sc.risk_flags,
          reasoning: sc.reasoning,
        };
      }
    }
  }

  const stocks = Array.from(byCode.values())
    .sort((x, y) => {
      // 優先 rating（A > B > C > D > 無 scoring），然後 mention_count，最後 confidence
      const ratingOrder: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };
      const xr = x.scoring ? ratingOrder[x.scoring.rating] ?? 0 : 0;
      const yr = y.scoring ? ratingOrder[y.scoring.rating] ?? 0 : 0;
      if (xr !== yr) return yr - xr;
      if (x.mention_count !== y.mention_count) return y.mention_count - x.mention_count;
      return y.best_confidence - x.best_confidence;
    });

  return {
    date: a.date,
    generated_at: a.generated_at,
    total_videos_processed: a.stats.videos_analyzed,
    total_unique_stocks: stocks.length,
    stocks,
  };
}
