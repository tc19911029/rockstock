/**
 * Portfolio Mini-Agent Review API
 *
 *   POST /api/agents/portfolio/review/prepare?date= → 寫 portfolio-review-question.json 給 skill
 *   GET  /api/agents/portfolio/review?date=         → 讀當日 review answer
 *
 * NOTE：實際 review 在 portfolio-review skill 內由 Claude Code 寫，
 *       這支 POST 只負責整理當日 context 給 skill 讀
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { checkSameOriginOrCron } from '@/lib/api/sameOriginAuth';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { loadScanSession } from '@/lib/storage/scanStorage';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import {
  loadAllHoldings,
  loadReview,
} from '@/lib/agents/portfolio/storage';
import {
  PORTFOLIO_SCHEMA_VERSION,
  PortfolioReviewQuestion,
} from '@/lib/agents/portfolio/types';
import { fetchJSON, internalUrl, bareTicker } from '@/lib/agents/agents/_fetchHelper';
import type { MarketId } from '@/lib/scanner/types';
import { profileDir, resolveProfileId } from '@/lib/portfolio/profiles';

export const runtime = 'nodejs';

const dateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(req: NextRequest) {
  const parsed = dateSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
  const review = await loadReview(parsed.data.date, profileId);
  return apiOk({
    date: parsed.data.date,
    exists: !!review,
    review,
  });
}

export async function POST(req: NextRequest) {
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  const parsed = dateSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { date } = parsed.data;
  const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));

  const holdings = (await loadAllHoldings(profileId)).filter(h => h.status === 'open');
  if (holdings.length === 0) {
    return apiOk({ message: '無持股需要 review', holdings: 0 });
  }
  const strategy = await getActiveStrategyServer();

  // 報價不能依賴「剛好入選 L4」：未入選候選池的持股也必須有現價才能執行停損規則。
  const quoteRaw = await fetchJSON(internalUrl(
    `/api/portfolio/quotes?symbols=${encodeURIComponent(holdings.map(h => h.symbol).join(','))}`,
  )).catch(() => null) as {
    quotes?: Array<{ symbol: string; price: number; stale?: boolean }>;
    data?: { quotes?: Array<{ symbol: string; price: number; stale?: boolean }> };
  } | null;
  const quotes = quoteRaw?.quotes ?? quoteRaw?.data?.quotes ?? [];
  const normalizedSymbol = (value: string) => value.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  // 對每檔並行拉 context（L4 candidateRow + chip + news）
  const sessionCache = new Map<string, Awaited<ReturnType<typeof loadScanSession>>>();
  const items: PortfolioReviewQuestion['holdings'] = await Promise.all(
    holdings.map(async (h) => {
      const market = h.market;
      // 從 L4 daily 撈該檔 candidateRow
      const cacheKey = `${market}|daily|${date}`;
      let session = sessionCache.get(cacheKey);
      if (session === undefined) {
        session = await loadScanSession(market, date, 'long', 'daily', strategy.id);
        sessionCache.set(cacheKey, session);
      }
      const candidateRow = session?.results.find(r => normalizedSymbol(r.symbol) === normalizedSymbol(h.symbol));

      const [chip, news] = await Promise.all([
        fetchJSON(internalUrl(`/api/chip?symbol=${encodeURIComponent(h.symbol)}`)).catch(() => null),
        market === 'TW' && /^\d{4,6}$/.test(bareTicker(h.symbol))
          ? fetchJSON(internalUrl(`/api/news/${bareTicker(h.symbol)}`)).catch(() => null)
          : null,
      ]);

      const directQuote = quotes.find(q => normalizedSymbol(q.symbol) === normalizedSymbol(h.symbol));
      // 停損/減碼決策不可吃 delayed quote；缺新價時明確留 null，交由 review 標資料不足。
      const currentPrice = directQuote && !directQuote.stale ? directQuote.price : null;

      return {
        symbol: h.symbol,
        name: h.name,
        market: market as MarketId,
        entryDate: h.entryDate,
        entryPrice: h.entryPrice,
        shares: h.shares,
        stopLoss: h.stopLoss,
        target1: h.target1,
        target2: h.target2,
        strategyContext: {
          triggerSignal: h.ui?.triggerSignal,
          operationMode: h.ui?.operationMode,
          managementStrategy: h.ui?.managementStrategy,
        },
        context: {
          currentPrice,
          candidateRow,
          chip,
          news,
        },
      };
    }),
  );

  const outputPath = profileDir(profileId)
    ? path.join(profileDir(profileId)!, 'reviews', `${date}.json`)
    : path.join(process.cwd(), 'data', 'agents', 'portfolio', 'reviews', `${date}.json`);

  const question: PortfolioReviewQuestion = {
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    date,
    holdings: items,
    outputPath,
  };

  // 寫到 /tmp（同 multi-agent-decide 範式）
  const tmpDir = `/tmp/rockstock-agents/portfolio-review`;
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, profileId === 'me' ? `${date}-question.json` : `${date}-${profileId}-question.json`);
  await atomicFsPut(tmpFile, JSON.stringify(question, null, 2));

  return apiOk({
    date,
    holdings: items.length,
    questionPath: tmpFile,
    outputPath,
    nextStep: `請在 Claude Code 對話中執行 /portfolio-review 完成持股 mini-agent 評估`,
  });
}
