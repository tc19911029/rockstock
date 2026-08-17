/**
 * POST /api/agents/prepare?date=&symbol=&market=&direction=&mtf=
 *
 * 行為：
 *   1. 從 L4 載入該日 session（依 mtf 模式）
 *   2. 從 session.results 找出 candidateRow（symbol 相符）
 *   3. 取 active strategy
 *   4. 呼叫 buildTechnicalQuestion → 寫 /tmp/rockstock-agents/{date}/{symbol}/technical-question.json
 *   5. 寫 _phase.json（currentPhase=1）+ _meta.json
 *   6. 回傳 question 路徑 + 提示使用者執行 /multi-agent-decide
 *
 * P1 範圍：只準備 Technical Agent；其他 phase 之後加。
 *
 * 不打 LLM SDK；不阻塞執行 skill（skill 由使用者主動觸發）。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadScanSession } from '@/lib/storage/scanStorage';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import { buildTechnicalQuestion } from '@/lib/agents/agents/technicalAgent';
import { buildNewsQuestion } from '@/lib/agents/agents/newsAgent';
import { buildChipQuestion } from '@/lib/agents/agents/chipAgent';
import { buildFundamentalQuestion } from '@/lib/agents/agents/fundamentalAgent';
import {
  getRunPaths,
  makeInitialPhaseState,
  makeRunId,
  writeChipQuestion,
  writeFundamentalQuestion,
  writeNewsQuestion,
  writePhaseState,
  writeRunMeta,
  writeTechnicalQuestion,
} from '@/lib/agents/orchestrator';
import { AGENT_SCHEMA_VERSION } from '@/lib/agents/types';
import type { MarketId, MtfMode, ScanDirection, StockScanResult } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  direction: z.enum(['long', 'short']).default('long'),
  // P1 只支援 daily / mtf / 13 字母軌；其餘擴充再加
  mtf: z.enum([
    'daily', 'mtf',
    'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R',
  ]).default('daily'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbol: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, direction, mtf, date, symbol } = parsed.data;
  const strategy = await getActiveStrategyServer();

  // ── 1. 從 L4 載入 session ──
  const session = await loadScanSession(
    market as MarketId,
    date,
    direction as ScanDirection,
    mtf as MtfMode,
    strategy.id,
  );
  if (!session) {
    return apiError(`L4 session not found: ${market}/${direction}/${mtf}/${date}`, 404);
  }

  // ── 2. 找 candidateRow ──
  const candidateRow: StockScanResult | undefined = session.results.find(
    (r) => r.symbol === symbol,
  );
  if (!candidateRow) {
    return apiError(
      `symbol ${symbol} not in L4 session (resultCount=${session.resultCount}). ` +
      `Agent 只能評估掃描器選出的候選，無法評估池子外的股票。`,
      404,
    );
  }

  // ── 3. 建構 4 個 Agent question 並行 prefetch ──
  const runId = makeRunId(date, symbol, session.scanTime);

  const technicalQ = buildTechnicalQuestion({
    runId, date, symbol, session, candidateRow, strategy,
  });

  const [newsQ, chipQ, fundamentalQ] = await Promise.all([
    buildNewsQuestion({
      runId, date, symbol,
      market: candidateRow.market,
      name: candidateRow.name,
    }),
    buildChipQuestion({
      runId, date, symbol,
      market: candidateRow.market,
    }),
    buildFundamentalQuestion({
      runId, date, symbol,
      market: candidateRow.market,
      name: candidateRow.name,
      industry: candidateRow.industry,
    }),
  ]);

  // ── 5. 寫檔 ──
  const [tQPath, nQPath, cQPath, fQPath] = await Promise.all([
    writeTechnicalQuestion(technicalQ),
    writeNewsQuestion(newsQ),
    writeChipQuestion(chipQ),
    writeFundamentalQuestion(fundamentalQ),
  ]);

  const phase = makeInitialPhaseState({
    runId, date, symbol,
    market: candidateRow.market,
  });
  await writePhaseState(date, symbol, phase);

  await writeRunMeta({
    schemaVersion: AGENT_SCHEMA_VERSION,
    runId, date, symbol,
    market: candidateRow.market,
    strategyId: strategy.id,
    startedAt: phase.startedAt,
  });

  const { tmpDir, persistDir } = getRunPaths(date, symbol);

  return apiOk({
    runId,
    tmpDir,
    persistDir,
    questionPaths: {
      technical: tQPath,
      news: nQPath,
      chip: cQPath,
      fundamental: fQPath,
    },
    nextStep:
      `請在 Claude Code 對話中執行 /multi-agent-decide 完成 Phase 1 ` +
      `（Technical / News / Chip / Fundamental 4 Agent 並行）`,
    candidateRow: {
      symbol: candidateRow.symbol,
      name: candidateRow.name,
      market: candidateRow.market,
      price: candidateRow.price,
      industry: candidateRow.industry,
      sixConditionsScore: candidateRow.sixConditionsScore,
      matchedMethods: candidateRow.matchedMethods,
      trendState: candidateRow.trendState,
    },
  });
}
