/**
 * GET /api/youtube/audit
 *
 * 跑 data integrity checks，回 issues + summary。
 * 用於前端「資料健康」區塊 + 未來 cron 自動 alert。
 */

import { apiError, apiOk } from '@/lib/api/response';
import { runAudit } from '@/lib/youtube/auditChecks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const report = await runAudit();
    return apiOk(report);
  } catch (err) {
    return apiError(`audit failed: ${(err as Error).message}`, 500);
  }
}
