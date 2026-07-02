/**
 * 推薦事件持久化 — data/youtube/recommendations/{date}.json（dual-storage：本地 FS + Vercel Blob）。
 *
 * 只存「事件身份 + 凍結基準價」；前瞻報酬讀取時從 L1 即時 derive（見 recoPerformance.ts）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getJson, putJson } from './analysisStorage';
import type { RecoEventsFile } from './recoTypes';

const FS_ROOT = path.join(process.cwd(), 'data', 'youtube');

function recoKey(date: string): string {
  return `recommendations/${date}.json`;
}

export async function loadRecoEvents(date: string): Promise<RecoEventsFile | null> {
  return await getJson<RecoEventsFile>(recoKey(date));
}

export async function saveRecoEvents(file: RecoEventsFile): Promise<void> {
  await putJson(recoKey(file.date), file);
}

/** 列出本地已存在的事件日（升序）。Vercel 上不可用（本功能跑本機 launchd，UI 讀同機）。 */
export async function listRecoDates(): Promise<string[]> {
  try {
    const dir = path.join(FS_ROOT, 'recommendations');
    const files = await fs.readdir(dir);
    return files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * 載入 (end-days, end] 視窗內全部事件檔。
 * @param end YYYY-MM-DD（含）
 * @param days 視窗天數（日曆日）
 */
export async function loadRecoEventsInRange(end: string, days: number): Promise<RecoEventsFile[]> {
  const endDate = new Date(`${end}T00:00:00+08:00`);
  const startDate = new Date(endDate.getTime() - days * 86400_000);
  const start = startDate.toISOString().slice(0, 10);

  const dates = (await listRecoDates()).filter(d => d > start && d <= end);
  const files: RecoEventsFile[] = [];
  for (const d of dates) {
    const f = await loadRecoEvents(d);
    if (f) files.push(f);
  }
  return files;
}
