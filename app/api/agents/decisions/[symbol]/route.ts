/**
 * GET /api/agents/decisions/[symbol]?date=YYYY-MM-DD
 *
 * 讀 data/agents/runs/{date}/{symbol}/ 下所有 agent 的 answer。
 *
 * P1：只有 technical.json + _meta.json + （可能）/tmp 區的 _phase.json
 * P2-P4：再加 chip / fundamental / news / risk / bull / bear / decision
 *
 * 路徑安全：date 必須符合 YYYY-MM-DD，symbol 限 alphanumeric.-_
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { readPhaseState } from '@/lib/agents/orchestrator';
import { agentsGet } from '@/lib/agents/persistStorage';
import { loadPool } from '@/lib/agents/candidates/poolStorage';
import type {
  AgentRunMeta,
  BearThesis,
  BullThesis,
  ChipAnswer,
  FinalDecision,
  FundamentalAnswer,
  NewsAnswer,
  RiskAnswer,
  TechnicalAnswer,
} from '@/lib/agents/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import type { MarketId } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const symbolSchema = z.string().regex(/^[A-Za-z0-9._-]+$/);

interface DecisionResponse {
  date: string;
  symbol: string;
  meta: AgentRunMeta | null;
  phase: Awaited<ReturnType<typeof readPhaseState>>;
  /** P3.5：該檔在 Pool 中的完整 attribution（為何進入候選池）*/
  candidate: Candidate | null;
  technical: TechnicalAnswer | null;
  news: NewsAnswer | null;
  chip: ChipAnswer | null;
  fundamental: FundamentalAnswer | null;
  risk: RiskAnswer | null;
  bull: BullThesis | null;
  bear: BearThesis | null;
  decision: FinalDecision | null;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ symbol: string }> },
) {
  const { symbol: rawSymbol } = await ctx.params;
  const symParse = symbolSchema.safeParse(rawSymbol);
  if (!symParse.success) return apiError('symbol 格式不合法', 400);
  const symbol = symParse.data;

  const qParse = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!qParse.success) return apiValidationError(qParse.error);
  const { date } = qParse.data;

  const k = (f: string) => `agents/runs/${date}/${symbol}/${f}`;
  const [meta, phase, technical, news, chip, fundamental, risk, bull, bear, decision] = await Promise.all([
    agentsGet<AgentRunMeta>(k('_meta.json')),
    readPhaseState(date, symbol),
    agentsGet<TechnicalAnswer>(k('technical.json')),
    agentsGet<NewsAnswer>(k('news.json')),
    agentsGet<ChipAnswer>(k('chip.json')),
    agentsGet<FundamentalAnswer>(k('fundamental.json')),
    agentsGet<RiskAnswer>(k('risk.json')),
    agentsGet<BullThesis>(k('bull.json')),
    agentsGet<BearThesis>(k('bear.json')),
    agentsGet<FinalDecision>(k('decision.json')),
  ]);

  // 從 Pool 撈該檔的 source attribution（meta 中拿 market）
  let candidate: Candidate | null = null;
  const market = (meta?.market ?? phase?.market) as MarketId | undefined;
  if (market) {
    const pool = await loadPool(market, date);
    candidate = pool?.candidates.find((c) => c.symbol === symbol) ?? null;
  }

  const payload: DecisionResponse = {
    date,
    symbol,
    meta,
    phase,
    candidate,
    technical,
    news,
    chip,
    fundamental,
    risk,
    bull,
    bear,
    decision,
  };

  return apiOk(payload);
}
