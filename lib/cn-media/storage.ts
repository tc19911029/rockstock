import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { defaultCnMediaSources } from './sourceRegistry';
import type {
  CnMediaScanResult,
  CnMediaSource,
  CnMediaTranscript,
  CnMediaVideo,
} from './types';

const ROOT = path.join(process.cwd(), 'data', 'cn-media');

async function getJson<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, key), 'utf-8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function putJson<T>(key: string, value: T): Promise<void> {
  const target = path.join(ROOT, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicFsPut(target, JSON.stringify(value, null, 2));
}

export async function loadCnMediaSources(): Promise<CnMediaSource[]> {
  const existing = await getJson<CnMediaSource[]>('sources.json');
  if (existing?.length) return existing;
  const sources = defaultCnMediaSources();
  await putJson('sources.json', sources);
  return sources;
}

export async function loadCnMediaVideos(date: string): Promise<CnMediaVideo[]> {
  return (await getJson<CnMediaVideo[]>(`videos/${date}.json`)) ?? [];
}

export async function saveCnMediaVideos(date: string, incoming: CnMediaVideo[]): Promise<CnMediaVideo[]> {
  const existing = await loadCnMediaVideos(date);
  const byId = new Map(existing.map(video => [video.video_id, video]));
  for (const video of incoming) {
    const previous = byId.get(video.video_id);
    byId.set(video.video_id, previous
      ? { ...previous, ...video, discovered_at: previous.discovered_at }
      : video);
  }
  const videos = [...byId.values()].sort((a, b) => b.published_at.localeCompare(a.published_at));
  await putJson(`videos/${date}.json`, videos);
  return videos;
}

export async function saveCnMediaScanResults(date: string, results: CnMediaScanResult[]): Promise<void> {
  await putJson(`scan-logs/${date}.json`, results);
}

export async function loadCnMediaScanResults(date: string): Promise<CnMediaScanResult[]> {
  return (await getJson<CnMediaScanResult[]>(`scan-logs/${date}.json`)) ?? [];
}

export async function saveCnMediaTranscript(record: CnMediaTranscript): Promise<void> {
  await putJson(`transcripts/${record.date}/${record.video_id}.json`, record);
}

export async function loadCnMediaTranscript(date: string, videoId: string): Promise<CnMediaTranscript | null> {
  return await getJson<CnMediaTranscript>(`transcripts/${date}/${videoId}.json`);
}

export async function loadCnMediaAnalysis<T>(date: string): Promise<T | null> {
  return await getJson<T>(`analysis/${date}.json`);
}
