/**
 * GET /api/stock/concentration?symbol=2377.TW&recentN=10
 *
 * 主力籌碼集中度（跟看盤 app 對齊版）— 最近 recentN 天的 5日/20日集中度，
 * 用 FinMind 券商分點逐日明細算正式公式（見 lib/chips/chipConcentration.ts），lazy + 逐日快取。
 * 只台股；陸股無主力分點來源 → 回空。純顯示，不改任何選股 gate。
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { computeConcSeries } from '@/lib/chips/chipConcentration';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { getFinMindBranchSourceStatus } from '@/lib/datasource/FinMindBranchProvider';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schema = z.object({
  symbol: z.string().min(1),
  recentN: z.coerce.number().int().min(1).max(20).optional().default(10),
});

export async function GET(req: NextRequest) {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, recentN } = parsed.data;

  // 只支援台股（陸股/指數無主力分點）
  if (!/^\d{4,5}(\.(TW|TWO))?$/i.test(symbol)) return apiOk({ symbol, conc: [], sourceStatus: null });
  const code = symbol.replace(/\.(TW|TWO)$/i, '');

  // Sponsor／全分點權限停用時不要每次開籌碼頁再做數十次必敗請求；近似值由 broker 本地快照顯示。
  if (process.env.INSTSTEAL_NO_FINMIND === '1') {
    return apiOk({
      symbol,
      conc: [],
      sourceStatus: {
        kind: 'unavailable',
        message: 'FinMind 全分點正式值已停用；目前使用 Yahoo 每日前 15 大快照近似值',
        checkedAt: null,
      },
    });
  }

  try {
    const cf = (await readCandleFile(`${code}.TW`, 'TW')) ?? (await readCandleFile(`${code}.TWO`, 'TW'));
    if (!cf?.candles?.length) return apiOk({ symbol, conc: [], sourceStatus: getFinMindBranchSourceStatus() });
    const candles = cf.candles.map((c) => ({ date: c.date, volume: c.volume }));
    const conc = await computeConcSeries(code, candles, {
      periods: [5, 20],
      recentN,
      todayDate: getLastTradingDay('TW'),
    });
    return apiOk({ symbol, conc, sourceStatus: getFinMindBranchSourceStatus() });
  } catch (err) {
    console.warn('[concentration] error:', err instanceof Error ? err.message : err);
    return apiOk({ symbol, conc: [], sourceStatus: getFinMindBranchSourceStatus() });
  }
}
