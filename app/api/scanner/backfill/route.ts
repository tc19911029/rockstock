import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { runScanPipeline } from '@/lib/scanner/ScanPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  direction: z.enum(['long', 'short']).default('long'),
  mtf: z.enum(['daily', 'mtf', 'both']).default('both'),
  force: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  // 2026-05-08：加同源/cron token 守門，防匿名 curl 觸發 5 分鐘 compute attack
  const { checkSameOriginOrCron } = await import('@/lib/api/sameOriginAuth');
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, date, direction, mtf, force } = parsed.data;

  if (!isTradingDay(date, market as 'TW' | 'CN')) {
    return apiOk({ skipped: true, reason: 'non-trading day (weekend)', date });
  }

  // 2026-06-12：pre-market 守門 — date 是「今天」但該市場盤後封存時間未到就跑
  // post_close，會存 0 檔空紀錄，讓 /health「最近掃描」整個早上誤顯示今日 (0 檔)
  //（首頁 scan panel 凌晨自動 backfill 即觸發）。未來日期一律擋。
  const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
  const now = new Date();
  const todayMkt = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  if (date > todayMkt) {
    return apiOk({ skipped: true, reason: 'future date', date });
  }
  if (date === todayMkt) {
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const cutoff = market === 'TW' ? '14:30' : '15:30';
    if (hm < cutoff) {
      return apiOk({ skipped: true, reason: `today post_close not sealed yet (before ${cutoff} ${tz})`, date });
    }
  }

  try {
    const result = await runScanPipeline({
      market: market as 'TW' | 'CN',
      date,
      sessionType: 'post_close',
      directions: [direction],
      mtfModes: mtf === 'both' ? ['daily', 'mtf'] : [mtf as 'daily' | 'mtf'],
      force,
    });

    return apiOk(result);
  } catch (err) {
    console.error('[scanner/backfill] error:', err);
    return apiError(String(err));
  }
}
