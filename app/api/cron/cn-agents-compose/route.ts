import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { composeDaily } from '@/lib/cn-agents/compose';

export const runtime = 'nodejs';
export const maxDuration = 120;

// 每日總決策合成（22:45 + 次日 07:40 CST if-missing）：合程式硬分 + skill 語意分 →
// daily/{date}.json + master_decision 事件。analysis 缺席照樣產出（degraded 重加權）。
// ?date=YYYY-MM-DD 回補。冪等。
export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const force = req.nextUrl.searchParams.get('force') === '1';
  const date = dateParam ?? getLastTradingDay('CN');
  if (!force && !isTradingDay(date, 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    const r = await composeDaily(date);
    return apiOk({ ok: true, ...r });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'cn-agents compose 失敗', 500);
  }
}
