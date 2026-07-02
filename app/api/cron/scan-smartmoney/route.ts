/**
 * 盤後 cron：掃描「跌 + 大戶逆勢買超」並存檔。
 * 排程 18:00 CST（法人 15:45、主力分點 17:30 都更新完之後）。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { runScan } from '@/lib/smartmoney/scan';
import { writeDay } from '@/lib/smartmoney/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  try {
    const day = await runScan();
    if (!day.date || day.date === '0') {
      return apiOk({ skipped: true, reason: '無有效資料日' });
    }
    await writeDay(day);
    return apiOk({ date: day.date, universe: day.universe, hits: day.hits.length });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'scan-smartmoney 失敗', 500);
  }
}
