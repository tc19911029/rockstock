/**
 * Daily cron：板塊（題材）強弱排名（2026-06-12 A2）
 * 盤後 17:10 CST（TW L1 14:30 eod-settle 已封）。
 * 讀 themeMap 成分股 L1 + inst 序列 → data/sectors/TW/{date}.json。
 *
 * 用法：GET /api/cron/compute-sector-strength[?date=YYYY-MM-DD]
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { buildSectorRanking, saveSectorRanking } from '@/lib/themes/sectorRanking';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');
  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    const file = await buildSectorRanking(date);
    const covered = file.themes.filter(t => t.avgD1 != null).length;
    // 全部題材都算不出報酬 = L1 還沒封或資料缺 → 不存檔（保留重跑機會）
    if (covered === 0) {
      return apiOk({ skipped: true, reason: 'no L1 data for any theme (not sealed yet?)', date });
    }
    await saveSectorRanking(file);
    return apiOk({
      date,
      themes: file.themes.length,
      themesWithData: covered,
      top3: file.themes.slice(0, 3).map(t => ({ theme: t.theme, avgD5: t.avgD5, stage: t.stage })),
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
