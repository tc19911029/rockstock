import { fetchYicaiVideos } from './yicai';
import { fetchBilibiliVideos } from './bilibili';
import {
  loadCnMediaSources,
  saveCnMediaScanResults,
  saveCnMediaVideos,
} from './storage';
import type { CnMediaScanResult, CnMediaVideo } from './types';

export async function scanCnMedia(targetDate: string): Promise<{
  videos: CnMediaVideo[];
  results: CnMediaScanResult[];
}> {
  const sources = (await loadCnMediaSources()).filter(source => source.active);
  const scanned = await mapConcurrent(sources, 3, async source => {
    const scannedAt = new Date().toISOString();
    try {
      const videos = source.platform === 'yicai'
        ? await fetchYicaiVideos(source, targetDate)
        : source.platform === 'bilibili'
          ? await fetchBilibiliVideos(source, targetDate)
          : (() => { throw new Error(`unsupported active platform: ${source.platform}`); })();
      return {
        videos,
        result: {
          source_id: source.source_id,
          display_name: source.display_name,
          scanned_at: scannedAt,
          target_date: targetDate,
          found_count: videos.length,
          error: null,
        } satisfies CnMediaScanResult,
      };
    } catch (error) {
      return {
        videos: [] as CnMediaVideo[],
        result: {
          source_id: source.source_id,
          display_name: source.display_name,
          scanned_at: scannedAt,
          target_date: targetDate,
          found_count: 0,
          error: (error as Error).message,
        } satisfies CnMediaScanResult,
      };
    }
  });

  const allVideos = scanned.flatMap(item => item.videos);
  const results = scanned.map(item => item.result);
  const videos = await saveCnMediaVideos(targetDate, allVideos);
  await saveCnMediaScanResults(targetDate, results);
  return { videos, results };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
