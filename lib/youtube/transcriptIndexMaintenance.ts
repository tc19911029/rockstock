import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import type { TranscriptIndex, TranscriptIndexEntry, TranscriptRecord } from './transcriptStorage';

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TranscriptIndexReconcileResult {
  scanned: number;
  before: number;
  after: number;
  added: number;
  updated: number;
  removed: number;
  wrote: boolean;
}

function indexEntry(record: TranscriptRecord): TranscriptIndexEntry {
  return {
    status: record.status,
    quality_score: record.quality_score,
    lang: record.lang,
    char_count: record.char_count,
    fetched_at: record.fetched_at,
    date: record.date,
  };
}

function sameEntry(left: TranscriptIndexEntry | undefined, right: TranscriptIndexEntry): boolean {
  return !!left
    && left.status === right.status
    && left.quality_score === right.quality_score
    && left.lang === right.lang
    && left.char_count === right.char_count
    && left.fetched_at === right.fetched_at
    && left.date === right.date;
}

/** Rebuild the local transcript index from the retained transcript files. */
export async function reconcileTranscriptIndex(
  youtubeRoot: string,
  options: { write?: boolean; now?: Date } = {},
): Promise<TranscriptIndexReconcileResult> {
  const indexPath = path.join(youtubeRoot, 'transcript-index.json');
  const current = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as TranscriptIndex;
  const rebuilt: Record<string, TranscriptIndexEntry> = {};
  let scanned = 0;

  const dateDirs = (await fs.readdir(path.join(youtubeRoot, 'transcripts')).catch(() => []))
    .filter(name => DATE_DIR_RE.test(name))
    .sort();
  for (const dateDir of dateDirs) {
    const directory = path.join(youtubeRoot, 'transcripts', dateDir);
    const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
    for (const file of files) {
      const record = JSON.parse(await fs.readFile(path.join(directory, file), 'utf-8')) as TranscriptRecord;
      const videoId = record.video_id || file.slice(0, -5);
      rebuilt[videoId] = indexEntry(record);
      scanned++;
    }
  }

  const currentById = current.byId ?? {};
  const before = Object.keys(currentById).length;
  let added = 0;
  let updated = 0;
  for (const [videoId, entry] of Object.entries(rebuilt)) {
    if (!(videoId in currentById)) added++;
    else if (!sameEntry(currentById[videoId], entry)) updated++;
  }
  const removed = Object.keys(currentById).filter(videoId => !(videoId in rebuilt)).length;
  const write = options.write ?? true;
  if (write && (added > 0 || updated > 0 || removed > 0)) {
    const next: TranscriptIndex = {
      byId: rebuilt,
      updated_at: (options.now ?? new Date()).toISOString(),
    };
    await atomicFsPut(indexPath, JSON.stringify(next, null, 2));
  }

  return { scanned, before, after: Object.keys(rebuilt).length, added, updated, removed, wrote: write && (added > 0 || updated > 0 || removed > 0) };
}
