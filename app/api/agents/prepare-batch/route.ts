/**
 * POST /api/agents/prepare-batch?date=&market=&top=N&minSourceCount=2
 *
 * P3.5：從 Candidates Pool 取候選（**取代** 原本的 L4 daily 單一來源）
 *
 * 行為：
 *   1. 讀 data/agents/pool/{market}/{date}.json
 *   2. 過濾 sourceCount >= minSourceCount
 *   3. 取 top N（pool 已按 sourceCount + strengthSignals 排序）
 *   4. 對每檔跑 4 個 agent question prefetch
 *      - 沒 technical source 的 candidate 在 P3.5 跳過（標 failed）
 *      - 有 technical source 的：從第一條 track 撈 candidateRow
 *
 * 改動：
 *   - 不再讀 loadScanSession 單一 session
 *   - candidate.sources 會切片塞進每個 agent question（§0 隔離）
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { checkSensitiveMutationAuth } from '@/lib/api/sameOriginAuth';
import { loadScanSession } from '@/lib/storage/scanStorage';
import { loadPool } from '@/lib/agents/candidates/poolStorage';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import { buildTechnicalQuestion } from '@/lib/agents/agents/technicalAgent';
import { buildNewsQuestion } from '@/lib/agents/agents/newsAgent';
import { buildChipQuestion } from '@/lib/agents/agents/chipAgent';
import { buildFundamentalQuestion } from '@/lib/agents/agents/fundamentalAgent';
import {
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
import type { Candidate } from '@/lib/agents/candidates/types';
import type { MarketId, MtfMode, StockScanResult, ScanSession } from '@/lib/scanner/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  top: z.coerce.number().int().min(1).max(50).default(10),
  minSourceCount: z.coerce.number().int().min(1).max(4).default(1),
});

interface PreparedItem {
  symbol: string;
  name: string;
  runId: string;
  sourceCount: number;
  sources: string[];
  questionPaths: {
    technical: string;
    news: string;
    chip: string;
    fundamental: string;
  };
}

interface FailedItem {
  symbol: string;
  error: string;
}

export async function POST(req: NextRequest) {
  const denied = checkSensitiveMutationAuth(req);
  if (denied) return denied;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, date, top, minSourceCount } = parsed.data;
  const strategy = await getActiveStrategyServer();

  // ── 1. 讀 Pool ──
  const pool = await loadPool(market as MarketId, date, strategy.id);
  if (!pool) {
    return apiError(
      `Pool not found for ${market}/${date}. ` +
      `先 POST /api/agents/pool/build?date=${date} 建立 pool。`,
      404,
    );
  }

  const eligible = pool.candidates
    .filter((c) => c.sourceCount >= minSourceCount)
    .slice(0, top);

  if (eligible.length === 0) {
    return apiOk({
      date, prepared: [], failed: [],
      message: `Pool 中無 sourceCount >= ${minSourceCount} 的候選`,
    });
  }

  const prepared: PreparedItem[] = [];
  const failed: FailedItem[] = [];

  // session cache：避免對每檔都重新 loadScanSession 同一軌
  const sessionCache = new Map<string, ScanSession | null>();

  for (const candidate of eligible) {
    try {
      // ── 2. 撈 candidateRow（沒 technical source 就跳過該檔）──
      const found = await resolveCandidateRow(candidate, market as MarketId, date, sessionCache, strategy.id);
      if (!found) {
        failed.push({
          symbol: candidate.symbol,
          error: 'no technical source — P3.5 暫不支援純消息/籌碼/基本面 candidate',
        });
        continue;
      }
      const { row: candidateRow, session } = found;

      const runId = makeRunId(date, candidate.symbol, session.scanTime);

      // ── 3. 4 個 agent question 並行 prefetch ──
      const technicalQ = buildTechnicalQuestion({
        runId, date, symbol: candidate.symbol,
        session, candidateRow, strategy, candidate,
      });
      const [newsQ, chipQ, fundamentalQ] = await Promise.all([
        buildNewsQuestion({
          runId, date, symbol: candidate.symbol,
          market: candidateRow.market, name: candidateRow.name,
          candidate,
        }),
        buildChipQuestion({
          runId, date, symbol: candidate.symbol,
          market: candidateRow.market,
          candidate,
        }),
        buildFundamentalQuestion({
          runId, date, symbol: candidate.symbol,
          market: candidateRow.market, name: candidateRow.name,
          industry: candidateRow.industry ?? candidate.industry,
          candidate,
        }),
      ]);

      const [tQPath, nQPath, cQPath, fQPath] = await Promise.all([
        writeTechnicalQuestion(technicalQ),
        writeNewsQuestion(newsQ),
        writeChipQuestion(chipQ),
        writeFundamentalQuestion(fundamentalQ),
      ]);

      const phase = makeInitialPhaseState({
        runId, date, symbol: candidate.symbol,
        market: candidateRow.market,
        strategyId: strategy.id,
      });
      await writePhaseState(date, candidate.symbol, phase);
      await writeRunMeta({
        schemaVersion: AGENT_SCHEMA_VERSION,
        runId, date, symbol: candidate.symbol,
        market: candidateRow.market,
        strategyId: strategy.id,
        startedAt: phase.startedAt,
      });
      prepared.push({
        symbol: candidate.symbol,
        name: candidate.name,
        runId,
        sourceCount: candidate.sourceCount,
        sources: Object.keys(candidate.sources),
        questionPaths: {
          technical: tQPath,
          news: nQPath,
          chip: cQPath,
          fundamental: fQPath,
        },
      });
    } catch (err) {
      failed.push({
        symbol: candidate.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return apiOk({
    date,
    poolTotal: pool.candidates.length,
    eligibleCount: eligible.length,
    minSourceCount,
    prepared,
    failed,
    nextStep:
      `已準備 ${prepared.length} 檔，請在 Claude Code 對話中執行 /multi-agent-decide ` +
      `（skill 會跑完所有 pending question）`,
  });
}

/**
 * 從 candidate.sources.technical.tracks 找第一條有該 symbol 的 session
 *
 * 帶 sessionCache 避免對同一軌重複 load
 */
async function resolveCandidateRow(
  candidate: Candidate,
  market: MarketId,
  date: string,
  cache: Map<string, ScanSession | null>,
  strategyId: string,
): Promise<{ row: StockScanResult; session: ScanSession } | null> {
  const tech = candidate.sources.technical;
  if (!tech || tech.tracks.length === 0) return null;

  for (const track of tech.tracks) {
    const cacheKey = `${market}|${track}|${date}|${strategyId}`;
    let session = cache.get(cacheKey);
    if (session === undefined) {
      session = await loadScanSession(market, date, 'long', track as MtfMode, strategyId);
      cache.set(cacheKey, session);
    }
    if (!session) continue;
    const row = session.results.find((r) => r.symbol === candidate.symbol);
    if (row) return { row, session };
  }
  return null;
}
