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
import type { KeyframeRecord } from './keyframeStorage';
import { selectTopImages, transcriptWindow } from './keyframeScreen';

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
  /**
   * 這集的分析師名單（主持人 + 來賓，從標題解析）。
   * 例：["李兆華", "朱家泓"] for 理財達人秀 5/20 part1。
   * 解析失敗或單一主持的節目會退回 source_display_name 或 ["(未知)"]。
   * /youtube-analysis skill 提取 stock mention 時必須帶上這個欄位，
   * 這樣才能標清「這檔是哪位分析師說的」。
   */
  analysts: string[];
  video_confidence_score: number;
  transcript_quality_score: number;
  transcript_lang: string | null;
  transcript_char_count: number;
  transcript_cue_count: number;
  /** 全文逐字稿（已 dedup rolling captions） */
  transcript_text: string;
  /**
   * 簡報關鍵幀（keyframe 管線；只有 keyframe_enabled 來源有）。
   * OCR 文字比 Whisper 同音可靠 — hit_codes 中逐字稿沒出現的代號是最高價值資訊。
   */
  keyframes?: Array<{
    /** 影片內秒數 */
    ts: number;
    /** "HH:MM:SS"（給 skill 寫 mention_time / 回看影片用） */
    time_hms: string;
    /** OCR 文字（截斷 400 字） */
    ocr_text: string;
    hit_codes: string[];
    hit_reasons: string[];
    /** 截圖絕對路徑；只有 top-N 高分幀非 null（skill 可選擇性 Read，全晚 ≤15 次） */
    image_path: string | null;
    /** 幀時間 ±45s 的逐字稿（畫面出現時老師在說什麼）— 合併 speech+slide 用 */
    transcript_window: string;
  }>;
  keyframe_summary?: {
    status: string;
    extracted: number;
    kept: number;
    in_payload: number;
    with_image: number;
  };
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
  /** 關鍵幀紀錄（video_id → record；caller 從 keyframeStorage 拿，無則略） */
  keyframes?: Map<string, KeyframeRecord>;
}

const INSTRUCTIONS = `你是台灣股市分析師。下面 payload 是今天 YouTube 理財節目的全部 transcript + metadata。

你的任務（請按以下順序）：

1. 通讀每支影片 transcript_text，理解主持人 / 來賓今日對大盤、產業、個股的觀點。

2. 提取每支影片提到的台股：
   - name_or_code：主持人實際說的名稱或代號
   - sentiment：bullish / bearish / neutral / watchlist / risk_warning / mentioned_only
   - recommendation_type：明確買進 / 看多 / 觀察 / 等回檔 / 小心追高 / 偏空 / 只介紹
     （依老師原話強度分級；「可以買、進場」=明確買進；「已漲多小心」=小心追高 不是買進；
       「突破 XX 再買」=等回檔/觀察；只唸新聞標題或介紹題材=只介紹）
   - context：保留原話片段 ≤80 字
   - reason：主持人給的理由 ≤60 字
   - source_type：speech（只有口述）/ slide（只在簡報畫面）/ speech+slide（兩者皆有）
   - mention_time：影片內秒數（speech 用逐字稿位置估、slide 用 keyframe ts）
   - 簡報有明確價位才填 mentioned_price / target_price / stop_loss（不可推算）
   - 用 stock_master_hint + prelookup 對照代號

2.5 簡報關鍵幀（videos[].keyframes，只有部分節目有）：
   - keyframes[].ocr_text 是畫面 OCR，代號/價位比 Whisper 逐字稿可靠（無同音問題）；
     兩者矛盾時以 keyframe 為準
   - hit_codes 中「transcript_text 沒出現」的代號 = 老師沒唸出來的簡報股票清單，
     必須提取成 mention（source_type='slide'，screenshot_ref 填該幀 file 對應的
     data/youtube/keyframes/{date}/{video_id}/fNNNNNN.webp 相對路徑）
   - transcript_window 是該畫面出現時老師在說什麼 — 用它判斷 sentiment 與 reason；
     若 window 內老師有講到同檔股票 → source_type='speech+slide'
   - image_path 非 null 的幀可用 Read 工具看圖（OCR 不確定/表格亂掉才看）；
     ⚠ 全部影片合計最多 Read 15 張圖，先挑 hit_codes 多且 novel 的

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
      analysts: v.analysts && v.analysts.length > 0 ? v.analysts : ['(未知)'],
      video_confidence_score: v.video_confidence_score,
      transcript_quality_score: t.quality_score,
      transcript_lang: t.lang,
      transcript_char_count: t.char_count,
      transcript_cue_count: t.cue_count,
      transcript_text: t.text,
    });
  }

  // keyframes：top-N 圖片跨影片全域挑選（每影片 5、全日 40），OCR 文字每影片 ≤30 幀
  if (input.keyframes && input.keyframes.size > 0) {
    const selectable = videosWithTranscript.flatMap(v => {
      const rec = input.keyframes!.get(v.video_id);
      if (!rec || rec.status !== 'ok') return [];
      return rec.frames.map(f => ({ video_id: v.video_id, ts: f.ts, score: f.score }));
    });
    const withImage = selectTopImages(selectable, MAX_IMAGES_PER_VIDEO, MAX_IMAGES_GLOBAL);

    for (const v of videosWithTranscript) {
      const rec = input.keyframes.get(v.video_id);
      if (!rec) continue;
      const cues = input.transcripts.get(v.video_id)?.cues;
      const topFrames = [...rec.frames]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_FRAMES_PER_VIDEO)
        .sort((a, b) => a.ts - b.ts);
      v.keyframes = topFrames.map(f => ({
        ts: f.ts,
        time_hms: secToHms(f.ts),
        ocr_text: f.ocr_text.length > MAX_OCR_CHARS ? `${f.ocr_text.slice(0, MAX_OCR_CHARS)}…` : f.ocr_text,
        hit_codes: f.hit_codes,
        hit_reasons: f.hit_reasons,
        image_path: f.file && withImage.has(`${v.video_id}:${f.ts}`) ? path.join(process.cwd(), f.file) : null,
        transcript_window: transcriptWindow(cues, f.ts),
      }));
      v.keyframe_summary = {
        status: rec.status,
        extracted: rec.frames_extracted,
        kept: rec.frames_kept,
        in_payload: v.keyframes.length,
        with_image: v.keyframes.filter(k => k.image_path != null).length,
      };
    }
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
/** payload 預算（防 23:55 nightly 超時）：每影片 OCR 幀數 / 文字長 / 附圖數 */
const MAX_FRAMES_PER_VIDEO = 30;
const MAX_OCR_CHARS = 400;
const MAX_IMAGES_PER_VIDEO = 5;
const MAX_IMAGES_GLOBAL = 40;

function secToHms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map(x => String(x).padStart(2, '0')).join(':');
}

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
