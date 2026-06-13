import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { assembleLhbDaily } from '@/lib/cn-agents/datasource/emDragonTigerDaily';
import { readLhbDaily, saveLhbDaily } from '@/lib/cn-agents/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

// 龍虎榜每日抓取（19:30 CST 榜單公布後 + 21:30 補抓空檔）：全榜 + 買賣五席位明細。
// 已存在且 detailFetched 且非 ?force=1 → skip（21:30 重跑不重抓）。
// ?date=YYYY-MM-DD 回補某日。CN 走本地 launchd，不進 vercel.json。
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
    const existing = force ? null : await readLhbDaily(date);
    if (existing && existing.detailFetched) {
      return apiOk({ skipped: true, reason: 'already fetched with detail', date, stocks: existing.stocks.length });
    }

    const file = await assembleLhbDaily(date, { withDetail: true });
    await saveLhbDaily(file);

    const seatTagDist: Record<string, number> = {};
    for (const s of file.stocks) {
      for (const side of ['buy', 'sell'] as const) {
        for (const t of s.seats[side]) seatTagDist[t.type] = (seatTagDist[t.type] ?? 0) + 1;
      }
    }

    return apiOk({ ok: true, date, stocks: file.stocks.length, detailFetched: file.detailFetched, seatTagDist });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : '龍虎榜抓取失敗', 500);
  }
}
