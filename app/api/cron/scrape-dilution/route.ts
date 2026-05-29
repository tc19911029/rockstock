/**
 * Cron：每日盤後抓 TWSE/TPEx 重大訊息，filter GDR/增資/CB 公告，
 * 落地 data/dilution/{stockId}.json
 *
 * 排程：19:30 CST（盤後揭露完畢，給 fundamentalAgent 第二天用）
 *
 * GET /api/cron/scrape-dilution
 *   ?dryRun=1   只 scan 不寫盤（debug 用）
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { scrapeMopsDilution } from '@/lib/datasource/MopsDilutionScraper';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

  try {
    const result = await scrapeMopsDilution({ dryRun });
    return apiOk({
      ok: true,
      ...result,
      sampleSymbols: Object.keys(result.bySymbol).slice(0, 10),
    });
  } catch (e) {
    return apiError(`scrape-dilution failed: ${e}`, 500);
  }
}
