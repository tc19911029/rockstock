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
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { readPhaseState } from '@/lib/agents/orchestrator';
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

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

  const runDir = path.join(process.cwd(), 'data', 'agents', 'runs', date, symbol);

  const [meta, phase, technical, news, chip, fundamental, risk, bull, bear, decision] = await Promise.all([
    readJsonIfExists<AgentRunMeta>(path.join(runDir, '_meta.json')),
    readPhaseState(date, symbol),
    readJsonIfExists<TechnicalAnswer>(path.join(runDir, 'technical.json')),
    readJsonIfExists<NewsAnswer>(path.join(runDir, 'news.json')),
    readJsonIfExists<ChipAnswer>(path.join(runDir, 'chip.json')),
    readJsonIfExists<FundamentalAnswer>(path.join(runDir, 'fundamental.json')),
    readJsonIfExists<RiskAnswer>(path.join(runDir, 'risk.json')),
    readJsonIfExists<BullThesis>(path.join(runDir, 'bull.json')),
    readJsonIfExists<BearThesis>(path.join(runDir, 'bear.json')),
    readJsonIfExists<FinalDecision>(path.join(runDir, 'decision.json')),
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
