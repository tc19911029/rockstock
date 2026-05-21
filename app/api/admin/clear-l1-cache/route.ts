/**
 * GET /api/admin/clear-l1-cache
 *
 * 清掉 dev server in-memory L1 cache，強制下次 readCandleFile 重讀磁碟。
 *
 * 用途：外部 process (如 scripts/repair-l1-from-yahoo.ts) 改完 L1 檔案後
 * 通知 dev server 失效快取，避免 dev server 繼續用 stale in-memory cache。
 *
 * 2026-05-21 加。
 */

import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { clearCache, getCacheStats } from '@/lib/datasource/L1CandleCache';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const before = getCacheStats();
  clearCache();
  const after = getCacheStats();
  return apiOk({
    cleared: true,
    before: before.entries,
    after: after.entries,
  });
}
