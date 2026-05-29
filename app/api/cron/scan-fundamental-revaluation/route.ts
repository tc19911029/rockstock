/**
 * 基本面補漲策略 cron route（2026-05-27）
 *
 * 用法：
 *   GET /api/cron/scan-fundamental-revaluation?market=TW&date=2026-05-27
 *   GET /api/cron/scan-fundamental-revaluation?market=CN&date=2026-05-27
 *   GET /api/cron/scan-fundamental-revaluation?market=TW&force=1
 *
 * 流程：
 *   1. 跑 runFundamentalRevaluation → 產 Phase 1 Top 100 + 排除名單
 *   2. saveSession → data/strategies/fundamental-revaluation/{market}/{date}.json
 *   3. writeQuestionPayload → /tmp/rockstock-fundamental/{date}-{market}-question.json
 *   4. writeDecideQueue → /tmp/rockstock-agents/queue/{date}/{symbol}/decide-question.json (Top 20)
 *
 * Top 20 自動排隊但不直接呼叫 multi-agent-decide skill — 使用者用 /multi-agent-decide --batch 觸發。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { runFundamentalRevaluation } from '@/lib/strategy/fundamentalRevaluation/runner';
import {
  saveSession,
  writeQuestionPayload,
  writeDecideQueue,
  type DecideQueueItem,
} from '@/lib/strategy/fundamentalRevaluation/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const marketParam = (req.nextUrl.searchParams.get('market') ?? 'TW').toUpperCase();
  if (marketParam !== 'TW' && marketParam !== 'CN') {
    return apiError(`invalid market: ${marketParam}`);
  }
  const market = marketParam as 'TW' | 'CN';

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay(market);

  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', date, market });
  }

  const topNParam = req.nextUrl.searchParams.get('topN');
  const topN = topNParam ? Math.max(50, Math.min(500, parseInt(topNParam, 10))) : undefined;

  try {
    console.info(`[cron/scan-fundamental-revaluation] start ${market} ${date}`);

    const session = await runFundamentalRevaluation({ market, date, topN });

    // 寫盤
    await saveSession(session);

    // /tmp question payload — Top 20 給 skill 用
    const top20 = session.top100.slice(0, 20);
    const questionFile = await writeQuestionPayload({
      market,
      date,
      strategyVersion: session.strategyVersion,
      top20,
      expectedOutput: 'fundamental-revaluation-deep@1.0.0',
      instruction: `對 Top 20 每檔輸出深度 scenario：保守/中性/樂觀的 Q2-Q4 假設、assumption_reason、confidence_level、validation_condition、一次性收益判斷、景氣高峰判斷、公司展望語意，evidence 規則同 youtube-analysis（source_url + raw_quote）`,
    });

    // multi-agent-decide queue — Top 20 自動排隊
    const queueItems: DecideQueueItem[] = top20.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      market: r.market,
      prioritySource: 'fundamental-revaluation' as const,
      rank: r.rank,
      total: r.breakdown.total,
      grade: r.breakdown.grade,
      baseFairPrice: r.baseFairPrice,
      todayPrice: r.todayPrice,
      bullPoints: r.bullPoints,
      riskPoints: r.riskPoints,
    }));
    const queue = await writeDecideQueue(date, queueItems);

    return apiOk({
      market,
      date,
      strategyVersion: session.strategyVersion,
      totalCandidates: session.totalCandidates,
      top100Count: session.top100.length,
      top20Count: top20.length,
      exclusions: {
        oneTimeGain: session.exclusionLists.oneTimeGainExcluded.length,
        deductedPoor: session.exclusionLists.deductedNetProfitPoor.length,
        valuationStretched: session.exclusionLists.valuationStretched.length,
        cyclicalPeak: session.exclusionLists.cyclicalPeak.length,
        insufficientData: session.exclusionLists.insufficientData.length,
      },
      questionFile,
      queueDir: queue.dir,
      queueCount: queue.count,
      computedAt: session.computedAt,
    });
  } catch (err) {
    console.error('[cron/scan-fundamental-revaluation] failed:', err);
    return apiError(String(err));
  }
}
