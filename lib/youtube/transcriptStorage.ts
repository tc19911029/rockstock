/**
 * Transcript storage — JSON-on-Blob/FS (mirror videoStorage pattern)。
 *
 * Layout:
 *   transcripts/{YYYY-MM-DD}/{video_id}.json   — 完整逐字稿 + metadata
 *   transcript-index.json                       — 全域索引（給前端 join 用）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { TranscriptCue } from './transcript';
import type { TranscriptStatus } from './transcriptQuality';

const IS_VERCEL = !!process.env.VERCEL;
const BLOB_PREFIX = 'youtube';
const FS_ROOT = path.join(process.cwd(), 'data', 'youtube');

export interface TranscriptRecord {
  video_id: string;
  source_id: string;
  date: string;                 // YYYY-MM-DD (Asia/Taipei)
  fetched_at: string;           // ISO
  status: TranscriptStatus;
  quality_score: number;
  lang: string | null;
  char_count: number;
  cue_count: number;
  vtt_bytes: number;
  /** 全文 join with \n。供下游 LLM 摘要 / 股票提取使用。 */
  text: string;
  /** 若需要做時間定位（例如「主持人在 23:00 提到台積電」），保留 cues。 */
  cues: TranscriptCue[];
  /** 抓取錯誤訊息（若有） */
  error: string | null;
  /** quality 子分數，便於 audit */
  quality: {
    lang_ok: boolean;
    length_ok: boolean;
    has_timestamps: boolean;
    stock_keyword_hits: number;
    rolling_dup_ratio: number;
  };
}

export interface TranscriptIndexEntry {
  status: TranscriptStatus;
  quality_score: number;
  lang: string | null;
  char_count: number;
  fetched_at: string;
  date: string;
}

export interface TranscriptIndex {
  byId: Record<string, TranscriptIndexEntry>;
  updated_at: string;
}

// ── path helpers ─────────────────────────────────────────────────────────────

function blobPath(key: string): string { return `${BLOB_PREFIX}/${key}`; }
function fsPath(key: string): string { return path.join(FS_ROOT, key); }

// ── unified put/get ──────────────────────────────────────────────────────────

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
  try {
    return await fs.readFile(fsPath(key), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function putJson<T>(key: string, value: T): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  if (IS_VERCEL) await blobPut(key, data); else await fsPut(key, data);
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(key) : await fsGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch (err) {
    console.error(`[transcriptStorage] parse failed ${key}:`, err);
    return null;
  }
}

// ── public: record ──────────────────────────────────────────────────────────

function recordKey(date: string, videoId: string): string {
  return `transcripts/${date}/${videoId}.json`;
}

export async function saveTranscript(rec: TranscriptRecord): Promise<void> {
  await putJson(recordKey(rec.date, rec.video_id), rec);
}

export async function loadTranscript(date: string, videoId: string): Promise<TranscriptRecord | null> {
  return await getJson<TranscriptRecord>(recordKey(date, videoId));
}

// ── public: index ────────────────────────────────────────────────────────────

const INDEX_KEY = 'transcript-index.json';

export async function loadTranscriptIndex(): Promise<TranscriptIndex> {
  return (await getJson<TranscriptIndex>(INDEX_KEY)) ?? {
    byId: {}, updated_at: new Date(0).toISOString(),
  };
}

export async function saveTranscriptIndex(idx: TranscriptIndex): Promise<void> {
  await putJson(INDEX_KEY, idx);
}

/** Upsert single index entry. Reads, mutates, writes — caller should batch. */
export async function upsertTranscriptIndexEntries(
  entries: Array<{ video_id: string; entry: TranscriptIndexEntry }>,
): Promise<void> {
  if (entries.length === 0) return;
  const idx = await loadTranscriptIndex();
  for (const { video_id, entry } of entries) {
    idx.byId[video_id] = entry;
  }
  idx.updated_at = new Date().toISOString();
  await saveTranscriptIndex(idx);
}
