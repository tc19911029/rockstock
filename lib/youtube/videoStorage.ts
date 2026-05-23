/**
 * YouTube tracking — JSON-on-Blob storage layer (MVP 1)。
 *
 * Mirror lib/storage/scanStorage.ts 的 dual-storage 模式：
 *   - IS_VERCEL 時走 Vercel Blob（不在 Production 跑 cron，但 read API 仍可走 Blob）
 *   - 本地走 data/youtube/* 檔案
 *
 * Layout（兩端 prefix 對齊）：
 *   sources.json
 *   videos/{YYYY-MM-DD}.json
 *   scan-logs/{YYYY-MM-DD}.json
 *   video-index.json
 *   health.json
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { defaultSources } from './sourceRegistry';
import type {
  VideoIndex,
  YouTubeHealthSnapshot,
  YouTubeSource,
  YouTubeSourceScanLog,
  YouTubeVideo,
} from './types';

const IS_VERCEL = !!process.env.VERCEL;
const BLOB_PREFIX = 'youtube';
const FS_ROOT = path.join(process.cwd(), 'data', 'youtube');

// ── path helpers ─────────────────────────────────────────────────────────────

function blobPath(key: string): string {
  return `${BLOB_PREFIX}/${key}`;
}

function fsPath(key: string): string {
  return path.join(FS_ROOT, key);
}

// ── Blob helpers ─────────────────────────────────────────────────────────────

async function blobPut(key: string, data: string): Promise<void> {
  const { blobPutWithRetry } = await import('@/lib/storage/blobRetry');
  await blobPutWithRetry(blobPath(key), data, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
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
  } catch {
    return null;
  }
}

// ── FS helpers ───────────────────────────────────────────────────────────────

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

// ── unified put/get ──────────────────────────────────────────────────────────

async function putJson<T>(key: string, value: T): Promise<void> {
  const data = JSON.stringify(value, null, 2);
  if (IS_VERCEL) {
    await blobPut(key, data);
  } else {
    await fsPut(key, data);
  }
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = IS_VERCEL ? await blobGet(key) : await fsGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`[youtube/videoStorage] parse failed for ${key}:`, err);
    return null;
  }
}

// ── public API: sources ──────────────────────────────────────────────────────

const SOURCES_KEY = 'sources.json';

/** seed-or-load：第一次呼叫沒檔 → 寫入 default 並回傳 */
export async function loadSources(): Promise<YouTubeSource[]> {
  const existing = await getJson<YouTubeSource[]>(SOURCES_KEY);
  if (existing && Array.isArray(existing) && existing.length > 0) {
    return existing;
  }
  const seeded = defaultSources();
  await putJson(SOURCES_KEY, seeded);
  return seeded;
}

export async function saveSources(sources: YouTubeSource[]): Promise<void> {
  await putJson(SOURCES_KEY, sources);
}

// ── public API: videos (per-day) ─────────────────────────────────────────────

function videosKey(dateYmd: string): string {
  return `videos/${dateYmd}.json`;
}

export async function loadVideosForDate(dateYmd: string): Promise<YouTubeVideo[]> {
  return (await getJson<YouTubeVideo[]>(videosKey(dateYmd))) ?? [];
}

/** Upsert by video_id. Caller 已準備好整批當日 videos。 */
export async function saveVideosForDate(dateYmd: string, videos: YouTubeVideo[]): Promise<void> {
  await putJson(videosKey(dateYmd), videos);
}

/** Merge 入當日檔（upsert by video_id；重複的取新 last_seen_at） */
export async function mergeVideosForDate(
  dateYmd: string,
  incoming: YouTubeVideo[],
): Promise<{ saved: YouTubeVideo[]; newCount: number }> {
  const existing = await loadVideosForDate(dateYmd);
  const map = new Map<string, YouTubeVideo>(existing.map(v => [v.video_id, v]));
  let newCount = 0;
  for (const v of incoming) {
    const prev = map.get(v.video_id);
    if (prev) {
      // 保留 discovered_at（首次發現），更新 last_seen_at 與其他可能改變的欄位
      //
      // ⚠️ should_analyze / skip_reason 特別處理：
      // 多日 backfill 時，scan with targetDate=X 會把標題不是 X 的影片標成
      // wrong_date 寫進它們各自的 fileDate 檔。但這些檔可能已經被另一次
      // targetDate=fileDate 的 scan 正確標成 should_analyze=true。
      // 不要讓 wrong_date 覆寫已存在的 true（true is sticky）。
      const stickyShould = prev.should_analyze && !v.should_analyze && v.skip_reason === 'wrong_date'
        ? { should_analyze: prev.should_analyze, skip_reason: prev.skip_reason }
        : { should_analyze: v.should_analyze, skip_reason: v.skip_reason };
      map.set(v.video_id, {
        ...prev,
        last_seen_at: v.last_seen_at,
        // 標題/時長/狀態可能 yt-dlp 補回更精確的數值，覆蓋之
        title: v.title,
        duration_sec: v.duration_sec,
        published_at: v.published_at ?? prev.published_at,
        video_type: v.video_type,
        ...stickyShould,
        video_confidence_score: v.video_confidence_score,
        program_date: v.program_date ?? prev.program_date,
        analysts: v.analysts && v.analysts.length > 0 ? v.analysts : (prev.analysts ?? ['(未知)']),
        raw: { ...prev.raw, ...v.raw },
      });
    } else {
      map.set(v.video_id, v);
      newCount += 1;
    }
  }
  const merged = Array.from(map.values()).sort(
    (a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''),
  );
  await saveVideosForDate(dateYmd, merged);
  return { saved: merged, newCount };
}

// ── public API: scan logs (per-day) ──────────────────────────────────────────

function scanLogsKey(dateYmd: string): string {
  return `scan-logs/${dateYmd}.json`;
}

export async function loadScanLogsForDate(dateYmd: string): Promise<YouTubeSourceScanLog[]> {
  return (await getJson<YouTubeSourceScanLog[]>(scanLogsKey(dateYmd))) ?? [];
}

export async function saveScanLogsForDate(
  dateYmd: string,
  logs: YouTubeSourceScanLog[],
): Promise<void> {
  await putJson(scanLogsKey(dateYmd), logs);
}

/** Upsert by source_id within the day. */
export async function upsertScanLog(
  dateYmd: string,
  log: YouTubeSourceScanLog,
): Promise<void> {
  const existing = await loadScanLogsForDate(dateYmd);
  const idx = existing.findIndex(l => l.source_id === log.source_id);
  if (idx >= 0) {
    existing[idx] = log;
  } else {
    existing.push(log);
  }
  await saveScanLogsForDate(dateYmd, existing);
}

// ── public API: global video index ───────────────────────────────────────────

const VIDEO_INDEX_KEY = 'video-index.json';

export async function loadVideoIndex(): Promise<VideoIndex> {
  return (await getJson<VideoIndex>(VIDEO_INDEX_KEY)) ?? {
    byId: {},
    updated_at: new Date(0).toISOString(),
  };
}

export async function saveVideoIndex(index: VideoIndex): Promise<void> {
  await putJson(VIDEO_INDEX_KEY, index);
}

// ── public API: health ───────────────────────────────────────────────────────

const HEALTH_KEY = 'health.json';

export async function loadHealth(): Promise<YouTubeHealthSnapshot | null> {
  return await getJson<YouTubeHealthSnapshot>(HEALTH_KEY);
}

export async function saveHealth(snapshot: YouTubeHealthSnapshot): Promise<void> {
  await putJson(HEALTH_KEY, snapshot);
}

// ── helpers for callers ──────────────────────────────────────────────────────

/** 倒推 N 天的 scan log（含今日）— 用於計算 consecutive_empty_days。 */
export async function loadRecentScanLogs(
  todayYmd: string,
  days: number,
): Promise<Map<string, YouTubeSourceScanLog[]>> {
  const out = new Map<string, YouTubeSourceScanLog[]>();
  const today = new Date(`${todayYmd}T00:00:00.000Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() - i * 86400_000);
    const ymd = d.toISOString().slice(0, 10);
    out.set(ymd, await loadScanLogsForDate(ymd));
  }
  return out;
}
