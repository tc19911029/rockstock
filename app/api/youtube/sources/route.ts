/**
 * GET  /api/youtube/sources         — 列出所有來源
 * PATCH /api/youtube/sources        — 編輯來源（active flag、display_name 等），需要 admin auth
 *
 * MVP 1 只實作 GET；PATCH 用於後續手動 toggle active。
 */

import { NextRequest } from 'next/server';
import { checkAdminAuth } from '@/lib/api/adminAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { loadSources, saveSources } from '@/lib/youtube/videoStorage';
import type { YouTubeSource } from '@/lib/youtube/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sources = await loadSources();
    return apiOk({ sources });
  } catch (err) {
    return apiError(`loadSources failed: ${(err as Error).message}`, 500);
  }
}

export async function PATCH(req: NextRequest) {
  const denied = checkAdminAuth(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }

  if (!body || typeof body !== 'object' || !('source_id' in body)) {
    return apiError('source_id required', 400);
  }
  const patch = body as Partial<YouTubeSource> & { source_id: string };

  try {
    const sources = await loadSources();
    const idx = sources.findIndex(s => s.source_id === patch.source_id);
    if (idx < 0) return apiError(`source_id not found: ${patch.source_id}`, 404);

    // 只允許更新有限欄位
    const allowed: (keyof YouTubeSource)[] = ['active', 'display_name', 'expected_cadence', 'url'];
    for (const key of allowed) {
      if (key in patch && patch[key] !== undefined) {
        // @ts-expect-error narrowed by allowed list
        sources[idx][key] = patch[key];
      }
    }
    await saveSources(sources);
    return apiOk({ source: sources[idx] });
  } catch (err) {
    return apiError(`saveSources failed: ${(err as Error).message}`, 500);
  }
}
