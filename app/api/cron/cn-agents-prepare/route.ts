import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { fetchCnNewsDigest } from '@/lib/cn-agents/datasource/cnNewsFeed';
import { saveNewsDigest } from '@/lib/cn-agents/storage';
import { buildQuestion } from '@/lib/cn-agents/bridge/questionBuilder';
import { CN_AGENTS_SCHEMA_VERSION } from '@/lib/cn-agents/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

// 陸股情緒分析 question 準備（21:30 CST，cn-agents-eod + lhb 之後）：
// step1 抓今日新聞 digest（best-effort）→ step2 組 question.json 到 $TMPDIR 給 /cn-agents-analysis skill。
// ?date=YYYY-MM-DD 回補。
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
    // step1：新聞 digest（失敗不擋 question）
    let newsInfo: { source: string; items: number; policy: number } = { source: 'none', items: 0, policy: 0 };
    try {
      const digest = await fetchCnNewsDigest(date);
      const policyCount = digest.items.filter((i) => i.policyCandidate).length;
      await saveNewsDigest({
        schemaVersion: CN_AGENTS_SCHEMA_VERSION, date, fetchedAt: new Date().toISOString(),
        source: digest.source, items: digest.items, policyCount,
      });
      newsInfo = { source: digest.source, items: digest.items.length, policy: policyCount };
    } catch (e) {
      newsInfo = { source: 'error', items: 0, policy: 0 };
      void e;
    }
    // step2：question
    const q = await buildQuestion(date);
    return apiOk({ ok: true, date, news: newsInfo, question: { bytesKB: +(q.bytes / 1024).toFixed(1), truncated: q.truncated, candidates: q.candidateCount, path: q.path } });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'cn-agents prepare 失敗', 500);
  }
}
