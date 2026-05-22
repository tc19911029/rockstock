/**
 * Build daily question payload for Claude (zhu-style)。
 *
 * 寫到 /tmp/rockstock-youtube/{date}-question.json，
 * 由使用者開 Claude Code 對話 / skill 讀取分析。
 *
 * 設計：所有 available transcript 全文 + 影片 metadata + master 對照表抽樣 + skip 統計，
 *      讓 Claude 一次看完整天所有節目，產出跨節目共識分析。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { YouTubeVideo } from './types';
import type { TranscriptRecord } from './transcriptStorage';
import type { StockMasterFile } from './stockMaster';
import type { DimensionResult, MacroData, StockDataBundle } from './stockDataLoader';

export const QUESTION_DIR = path.join(tmpdir(), 'rockstock-youtube');

export interface QuestionVideo {
  video_id: string;
  source_id: string;
  source_display_name: string;
  title: string;
  url: string;
  duration_sec: number | null;
  published_at: string | null;
  program_date: string | null;
  video_confidence_score: number;
  transcript_quality_score: number;
  transcript_lang: string | null;
  transcript_char_count: number;
  transcript_cue_count: number;
  /** 全文逐字稿（已 dedup rolling captions） */
  transcript_text: string;
}

export interface QuestionPayload {
  schema_version: 1;
  date: string;                 // YYYY-MM-DD Asia/Taipei
  generated_at: string;
  instructions: string;          // 給 Claude 看的分析指引（嵌在 payload 內，方便 skill 跳過）
  output_path: string;           // Claude 應寫 answer 到這裡（data/youtube/analysis/{date}.json）
  /** 今日 should_analyze=true 影片數 (含 unavailable transcript 那些) */
  total_analyzable_videos: number;
  /** 今日 transcript_status=available 影片數（=videos.length） */
  videos_with_transcript: number;
  /** 今日跳過的影片數（依 reason 統計） */
  skip_summary: Record<string, number>;
  /** 每個來源的 transcript 可得性快照（讓 Claude 知道哪幾家無字幕） */
  source_transcript_availability: Array<{
    source_id: string;
    display_name: string;
    expected_cadence: string;
    analyzable_today: number;
    transcript_available: number;
  }>;
  videos: QuestionVideo[];
  /** 抽樣 stock master entries（避免整份 26K 筆塞給 Claude）— 包含 ALIAS_MAP 全部 + TWSE 前 1000 */
  stock_master_hint: Array<{
    code: string;
    name: string;
    market: 'TWSE' | 'TPEx';
    aliases: string[];
  }>;
  /**
   * 為 prelookup 命中的股票預先抓 6 大面向資料 (技術/籌碼/基本面/消息/估值/大盤索引)。
   * 缺 industry + governance (尚無 API)。每筆附 source URL + freshness。
   * 讓 skill 對照「主持人說的」vs「實際數據」做更精準分析。
   */
  stock_data_bundles: StockDataBundle[];
  /** 大盤資金面快照（一日一抓）。讓 skill 評估「節目大盤觀點」vs「實際數據」 */
  macro: DimensionResult<MacroData> | null;
  /** 直接挑出今日影片標題提到的代號 / 名稱所對應 master entries（讓 Claude 有現成 lookup） */
  prelookup: Array<{
    raw_query: string;
    matched_code: string | null;
    matched_name: string | null;
    confidence: number;
  }>;
}

export interface BuildQuestionInput {
  date: string;
  videos: YouTubeVideo[];                       // 今日全部影片 (含 skip)
  transcripts: Map<string, TranscriptRecord>;   // video_id → transcript
  sources: Array<{ source_id: string; display_name: string; expected_cadence: string }>;
  master: StockMasterFile;
  prelookups: Array<{ raw_query: string; matched_code: string | null; matched_name: string | null; confidence: number }>;
  /** 預先抓的 6 大面向資料（caller 從 stockDataLoader.loadStockBundles 拿） */
  stockDataBundles?: StockDataBundle[];
  /** 大盤 macro 資料 (caller 從 loadMacro 拿) */
  macro?: DimensionResult<MacroData> | null;
}

const INSTRUCTIONS = `你是台灣股市分析師。下面 payload 是今天 YouTube 理財節目的全部 transcript + metadata。

你的任務（請按以下順序）：

1. 通讀每支影片 transcript_text，理解主持人 / 來賓今日對大盤、產業、個股的觀點。

2. 提取每支影片提到的台股：
   - name_or_code：主持人實際說的名稱或代號
   - sentiment：bullish / bearish / neutral / watchlist / risk_warning / mentioned_only
   - context：保留原話片段 ≤80 字
   - reason：主持人給的理由 ≤60 字
   - 用 stock_master_hint + prelookup 對照代號

3. 跨節目找共識：
   - high_consensus_stocks：≥2 個節目同向提到的股票（bullish 共識或 bearish 共識）
   - weak_signal_stocks：單一節目提到 或 多節目意見分歧的
   - 一定要附上 matched (從 stock_master_hint 對照) 與 combined_confidence (自評 × 對照信心)
   - combined_confidence < 0.6 的股票放 weak_signal_stocks（前端會視為低信號）

4. 大盤層次：
   - market_view：跨節目大盤主軸 ≤200 字
   - bullish_consensus：多數節目共同看好的題材 (3-6 個)
   - bearish_consensus：多數節目提醒的風險 (0-4 個)

5. 寫結構化 JSON 到 output_path（即 data/youtube/analysis/{date}.json），schema 參考 \`lib/youtube/analysisStorage.ts\` 的 DailyAnalysis interface。

注意：
- 只用 transcript_text 內的事實，不要自己編
- 多節目都沒提的東西不要列入 consensus
- 如果某支影片明顯非股市內容（例如純社會話題），跳過該支
- 寫完 answer 後也順便用人話 summary 跟使用者口述今日重點`;

export function buildQuestion(input: BuildQuestionInput): QuestionPayload {
  const sourceByCode = new Map(input.sources.map(s => [s.source_id, s]));
  const videosWithTranscript: QuestionVideo[] = [];

  // skip summary
  const skipSummary: Record<string, number> = {};
  for (const v of input.videos) {
    if (!v.should_analyze && v.skip_reason) {
      skipSummary[v.skip_reason] = (skipSummary[v.skip_reason] ?? 0) + 1;
    }
  }

  // analyzable + transcript-available videos
  const analyzable = input.videos.filter(v => v.should_analyze);
  for (const v of analyzable) {
    const t = input.transcripts.get(v.video_id);
    if (!t || t.status !== 'available') continue;
    const src = sourceByCode.get(v.source_id);
    videosWithTranscript.push({
      video_id: v.video_id,
      source_id: v.source_id,
      source_display_name: src?.display_name ?? v.source_id,
      title: v.title,
      url: v.url,
      duration_sec: v.duration_sec,
      published_at: v.published_at,
      program_date: v.program_date,
      video_confidence_score: v.video_confidence_score,
      transcript_quality_score: t.quality_score,
      transcript_lang: t.lang,
      transcript_char_count: t.char_count,
      transcript_cue_count: t.cue_count,
      transcript_text: t.text,
    });
  }

  // source availability
  const sourceAvail = input.sources.map(s => {
    const src_analyzable = analyzable.filter(v => v.source_id === s.source_id).length;
    const src_available = videosWithTranscript.filter(v => v.source_id === s.source_id).length;
    return {
      source_id: s.source_id,
      display_name: s.display_name,
      expected_cadence: s.expected_cadence,
      analyzable_today: src_analyzable,
      transcript_available: src_available,
    };
  });

  // master hint：取 ALIAS_MAP 對應 + TWSE top-1000 (by code asc，先給常見大盤)
  const masterHint = sampleMasterHint(input.master);

  return {
    schema_version: 1,
    date: input.date,
    generated_at: new Date().toISOString(),
    instructions: INSTRUCTIONS,
    output_path: `data/youtube/analysis/${input.date}.json`,
    total_analyzable_videos: analyzable.length,
    videos_with_transcript: videosWithTranscript.length,
    skip_summary: skipSummary,
    source_transcript_availability: sourceAvail,
    videos: videosWithTranscript,
    stock_master_hint: masterHint,
    stock_data_bundles: input.stockDataBundles ?? [],
    macro: input.macro ?? null,
    prelookup: input.prelookups,
  };
}

const MAX_MASTER_HINT_ENTRIES = 1200;

function sampleMasterHint(master: StockMasterFile): QuestionPayload['stock_master_hint'] {
  // 先收 alias 對應的（保證理財節目常聽到的都在裡面）
  const withAliases = master.entries.filter(e => e.aliases.length > 0);
  // 補 TWSE 主板（code asc，限額）
  const twseRest = master.entries
    .filter(e => e.market === 'TWSE' && e.aliases.length === 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const hint: QuestionPayload['stock_master_hint'] = [];
  for (const e of withAliases) {
    hint.push({ code: e.code, name: e.name, market: e.market, aliases: e.aliases });
  }
  for (const e of twseRest) {
    if (hint.length >= MAX_MASTER_HINT_ENTRIES) break;
    hint.push({ code: e.code, name: e.name, market: e.market, aliases: [] });
  }
  return hint;
}

/** 寫到 /tmp/rockstock-youtube/{date}-question.json */
export async function writeQuestionToTmp(payload: QuestionPayload): Promise<string> {
  await fs.mkdir(QUESTION_DIR, { recursive: true });
  const file = path.join(QUESTION_DIR, `${payload.date}-question.json`);
  await atomicFsPut(file, JSON.stringify(payload, null, 2));
  return file;
}
