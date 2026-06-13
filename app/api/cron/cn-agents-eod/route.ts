import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runCnAgentsEod } from '@/lib/cn-agents/eodPipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;

// 陸股 AI Agent（自創因子，鏡像 cn-sanse 隔離先例）盤後 EOD 固化：
// 漲停池 → 寬度+情緒週期 → 板塊 → 人氣榜，四步獨立容錯（見 eodPipeline.ts 檔頭）。
// ?date=YYYY-MM-DD 回補某日（歷史日的即時快照步驟會自動 skip/degrade，不 mislabel）；
// ?force=1 跳過交易日檢查。CN 走本地 launchd，不進 vercel.json。
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
    const result = await runCnAgentsEod({ date, force });
    return apiOk({
      ok: result.steps.every((s) => s.ok),
      date: result.date,
      steps: result.steps.map((s) => ({
        step: s.step,
        ok: s.ok,
        ...(s.source ? { source: s.source } : {}),
        ...(s.note ? { note: s.note } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
      stage: result.cycle?.stage ?? null,
      stageLabel: result.cycle?.stageLabel ?? null,
      emotionScore: result.cycle?.emotionScore ?? null,
      strategyLabel: result.cycle?.strategyLabel ?? null,
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'cn-agents EOD pipeline 失敗', 500);
  }
}
