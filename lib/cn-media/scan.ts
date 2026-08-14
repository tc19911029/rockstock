import { fetchYicaiVideos } from './yicai';
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
  const allVideos: CnMediaVideo[] = [];
  const results: CnMediaScanResult[] = [];

  for (const source of sources) {
    const scannedAt = new Date().toISOString();
    try {
      if (source.platform !== 'yicai') {
        throw new Error(`unsupported active platform: ${source.platform}`);
      }
      const videos = await fetchYicaiVideos(source, targetDate);
      allVideos.push(...videos);
      results.push({
        source_id: source.source_id,
        display_name: source.display_name,
        scanned_at: scannedAt,
        target_date: targetDate,
        found_count: videos.length,
        error: null,
      });
    } catch (error) {
      results.push({
        source_id: source.source_id,
        display_name: source.display_name,
        scanned_at: scannedAt,
        target_date: targetDate,
        found_count: 0,
        error: (error as Error).message,
      });
    }
  }

  const videos = await saveCnMediaVideos(targetDate, allVideos);
  await saveCnMediaScanResults(targetDate, results);
  return { videos, results };
}
