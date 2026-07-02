/**
 * 關鍵幀持久化 — metadata 走 dual-storage（同 analysisStorage），圖片 FS-only。
 *
 * 路徑：
 *   metadata  data/youtube/keyframes/{date}/{video_id}.json（dual-storage）
 *   kept webp data/youtube/keyframes/{date}/{video_id}/f{ts}.webp（FS-only，永久保留）
 *   raw jpg   data/youtube/keyframes-raw/{date}/{video_id}/*.jpg（FS-only，10 天清理）
 *   index     data/youtube/keyframe-index.json（skip 判斷 + prepare-analysis join）
 *
 * 教訓沿用（transcript-index 2026-05-22）：每處理完一支立即寫 index，不等迴圈結束。
 */

import path from 'node:path';
import { getJson, putJson } from './analysisStorage';

export type KeyframeStatus = 'ok' | 'failed' | 'no_video' | 'ocr_unavailable' | 'skipped_too_long';

export interface KeyframeMeta {
  /** 影片內秒數 */
  ts: number;
  /**
   * repo 相對路徑 data/youtube/keyframes/{date}/{vid}/f0000754.webp。
   * null = 該幀只留 OCR 文字沒存圖（純關鍵字命中，控制永久儲存量；
   * 有代號/股名命中的幀才存 webp）。
   */
  file: string | null;
  dhash: string;
  /** 完整 OCR 文字（payload 端再截斷） */
  ocr_text: string;
  ocr_confidence: number;
  /** ["code:2330","name:台積電","kw:目標價","cn_code:600519"] */
  hit_reasons: string[];
  /** 通過 stock-master 驗證的台股代號 */
  hit_codes: string[];
  hit_names: string[];
  /** top-N 圖片挑選分數（scoreFrame） */
  score: number;
}

export interface KeyframeRecord {
  video_id: string;
  source_id: string;
  date: string;
  extracted_at: string;       // ISO
  status: KeyframeStatus;
  /** 實際下載到的視訊高度（OCR 品質追蹤；720p 不夠清晰時升 1080 用） */
  video_height: number | null;
  scene_threshold: number;
  frames_extracted: number;   // ffmpeg 場景幀數
  frames_after_dedup: number;
  frames_kept: number;        // = frames.length
  error: string | null;
  timings: { download_ms: number; extract_ms: number; ocr_ms: number };
  frames: KeyframeMeta[];
}

export interface KeyframeIndexEntry {
  date: string;
  status: KeyframeStatus;
  frames_kept: number;
  extracted_at: string;
}

export interface KeyframeIndex {
  byId: Record<string, KeyframeIndexEntry>;
  updated_at: string;
}

const INDEX_KEY = 'keyframe-index.json';

function recordKey(date: string, videoId: string): string {
  return `keyframes/${date}/${videoId}.json`;
}

/** kept webp 的 repo 相對目錄（圖片由 keyframes.ts 經 python 直接寫 FS） */
export function keyframeImageDir(date: string, videoId: string): string {
  return path.join('data', 'youtube', 'keyframes', date, videoId);
}

export function keyframeRawDir(date: string, videoId: string): string {
  return path.join('data', 'youtube', 'keyframes-raw', date, videoId);
}

export async function loadKeyframeRecord(date: string, videoId: string): Promise<KeyframeRecord | null> {
  return await getJson<KeyframeRecord>(recordKey(date, videoId));
}

export async function saveKeyframeRecord(record: KeyframeRecord): Promise<void> {
  await putJson(recordKey(record.date, record.video_id), record);
}

export async function loadKeyframeIndex(): Promise<KeyframeIndex> {
  const idx = await getJson<KeyframeIndex>(INDEX_KEY);
  return idx ?? { byId: {}, updated_at: new Date(0).toISOString() };
}

/** 單支處理完立即 upsert（不可等整批結束才寫 — transcript-index 教訓） */
export async function upsertKeyframeIndex(videoId: string, entry: KeyframeIndexEntry): Promise<void> {
  const idx = await loadKeyframeIndex();
  idx.byId[videoId] = entry;
  idx.updated_at = new Date().toISOString();
  await putJson(INDEX_KEY, idx);
}

/** cleanup 用：把已刪日期的 entries 從 index 剪掉 */
export async function pruneKeyframeIndex(removedDates: Set<string>): Promise<number> {
  const idx = await loadKeyframeIndex();
  let pruned = 0;
  for (const [vid, entry] of Object.entries(idx.byId)) {
    if (removedDates.has(entry.date)) {
      delete idx.byId[vid];
      pruned += 1;
    }
  }
  if (pruned > 0) {
    idx.updated_at = new Date().toISOString();
    await putJson(INDEX_KEY, idx);
  }
  return pruned;
}
