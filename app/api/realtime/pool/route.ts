/**
 * GET /api/realtime/pool
 *
 * UI 用：列出當下監控池（holdings + pool candidates）
 */

import { apiOk } from '@/lib/api/response';
import { getActiveSymbols } from '@/lib/realtime/monitorPool';

export const runtime = 'nodejs';

export async function GET() {
  const pool = await getActiveSymbols();
  return apiOk({ pool });
}
