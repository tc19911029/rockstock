/**
 * POST /api/agents/phase?date=&symbol=&phase=2|3a|3b|4
 *
 * 動態建構 Phase 2-4 的 question（這些 question 需要先讀 Phase 1+ 已完成的 answer）：
 *   - phase=2  → risk-question.json
 *   - phase=3a → bull-question.json
 *   - phase=3b → bear-question.json（會讀 bull-answer）
 *   - phase=4  → decision-question.json
 *
 * Skill 在每個 phase 寫完 answer 後呼叫此 API 產出下一階段 question。
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadScanSession } from '@/lib/storage/scanStorage';
import { buildRiskQuestion } from '@/lib/agents/agents/riskAgent';
import { buildDebateQuestion } from '@/lib/agents/agents/debateBuilder';
import { buildDecisionQuestion } from '@/lib/agents/agents/decisionBuilder';
import {
  writeBearQuestion,
  writeBullQuestion,
  writeDecisionQuestion,
  writeRiskQuestion,
  readPhaseState,
} from '@/lib/agents/orchestrator';
import type { MarketId } from '@/lib/scanner/types';
import type { AgentRunMeta } from '@/lib/agents/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
  phase: z.enum(['2', '3a', '3b', '4']),
});

export async function POST(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { date, symbol, phase } = parsed.data;

  // 從 _meta.json 取 market + runId
  const runDir = path.join(process.cwd(), 'data', 'agents', 'runs', date, symbol);
  const metaRaw = await fs.readFile(path.join(runDir, '_meta.json'), 'utf-8').catch(() => null);
  if (!metaRaw) return apiError(`run meta not found for ${date}/${symbol}`, 404);
  const meta = JSON.parse(metaRaw) as AgentRunMeta;
  const market = meta.market as MarketId;
  const runId = meta.runId;

  const phaseState = await readPhaseState(date, symbol);
  if (!phaseState) return apiError(`phase state not found`, 404);

  switch (phase) {
    case '2': {
      // Risk Agent 需要 candidateRow — 從 L4 撈
      const candidateRow = await findCandidateRow(market, date, symbol);
      if (!candidateRow) return apiError(`candidateRow not found in L4 for ${symbol}`, 404);
      const q = await buildRiskQuestion({ runId, date, symbol, market, candidateRow });
      const file = await writeRiskQuestion(q);
      return apiOk({ phase, questionPath: file });
    }
    case '3a': {
      const q = await buildDebateQuestion({ runId, date, symbol, market, side: 'bull' });
      const file = await writeBullQuestion(q);
      return apiOk({ phase, questionPath: file });
    }
    case '3b': {
      const q = await buildDebateQuestion({ runId, date, symbol, market, side: 'bear' });
      if (!q.bullAnswer) {
        return apiError('bull-answer not found — please complete phase 3a first', 409);
      }
      const file = await writeBearQuestion(q);
      return apiOk({ phase, questionPath: file });
    }
    case '4': {
      const q = await buildDecisionQuestion({ runId, date, symbol, market });
      const file = await writeDecisionQuestion(q);
      return apiOk({ phase, questionPath: file });
    }
  }
}

async function findCandidateRow(market: MarketId, date: string, symbol: string) {
  // 試 13 字母軌找到第一個含該 symbol 的 session
  const tracks = ['daily', 'mtf', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'] as const;
  for (const t of tracks) {
    const s = await loadScanSession(market, date, 'long', t);
    const row = s?.results.find((r) => r.symbol === symbol);
    if (row) return row;
  }
  return null;
}
