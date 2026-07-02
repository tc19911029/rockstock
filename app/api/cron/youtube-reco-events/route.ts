/**
 * POST /api/cron/youtube-reco-events
 *
 * 老師推薦事件 cron：
 *   (a) 從 analysis/{date}.json 抽推薦事件（analysis 重跑時自動重抽、保留已結算 baseline）
 *   (b) 結算「所有日期」還 pending 的基準價（隔日 L1 封存後補結）
 *
 * 觸發點：
 *   - nightly analysis 落地後（youtube-nightly-analysis.sh step）
 *   - 每交易日 15:30 CST launchd（com.rockstock.youtube-reco-settle）— 主要為了 (b)
 *
 * Query:
 *   ?date=YYYY-MM-DD   指定抽取日期（預設今日）
 *   ?force=1           analysis generated_at 沒變也重抽
 *   ?dry_run=1         只算不寫
 */

import { NextRequest } from 'next/server';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { apiError, apiOk } from '@/lib/api/response';
import { todayYmdTaipei } from '@/lib/youtube/classify';
import { extractAndSettleForDate, settleAllPendingDates } from '@/lib/youtube/recoPipeline';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) { return handle(req); }
export async function GET(req: NextRequest) { return handle(req); }

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const date = url.searchParams.get('date') || todayYmdTaipei(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return apiError('date must be YYYY-MM-DD', 400);
  }
  const force = url.searchParams.get('force') === '1';
  const dryRun = url.searchParams.get('dry_run') === '1';

  try {
    // (a) 抽取：sweep date 往回 3 天（nightly 漏跑/analysis 補寫時，隔日 15:30 cron 自動補抽）
    const extractByDate: Record<string, unknown> = {};
    for (let back = 0; back < 3; back++) {
      const d = addDays(date, -back);
      const r = await extractAndSettleForDate(d, { force: back === 0 ? force : false, dryRun });
      if (r) {
        extractByDate[d] = {
          extracted: r.isNew,
          events: r.file.events.length,
          scored: r.file.events.filter(e => e.cohort === 'scored' && e.baseline.status === 'filled').length,
          settle: r.stats,
          skipped: r.file.skipped,
        };
      }
    }

    // (b) 補結所有日期的 pending（昨日提及、今日 K 剛封存的事件在這裡結）
    const settled = await settleAllPendingDates({ dryRun });

    return apiOk({
      date,
      dry_run: dryRun,
      extract_by_date: extractByDate,
      pending_settled_by_date: settled,
    });
  } catch (err) {
    return apiError(`reco-events failed: ${(err as Error).message}`, 500);
  }
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  // 以台北時區輸出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
}
