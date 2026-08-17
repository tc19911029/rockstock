/**
 * Agents Daily Decide — 每日盤後 cron
 *
 * 17:00 CST (= 09:00 UTC) 自動跑：
 *   1. 建立當日 Candidates Pool（4 source extractors + merge）
 *   2. prepare-batch：對 top 10 候選寫 question.json（不打 LLM）
 *   3. 回傳 nextStep → 使用者在 Claude Code 執行 /multi-agent-decide
 *
 * GET /api/cron/agents-daily-decide?market=TW&top=10
 *
 * Vercel cron（vercel.json）：
 *   { "path": "/api/cron/agents-daily-decide?market=TW", "schedule": "0 9 * * 1-5" }
 *
 * 注意：question 寫到 /tmp（Vercel 可寫），persist 區 data/agents/runs/ 需本地 FS，
 * 建議搭配本地 launchd 跑 dev server，Vercel cron 主要用於觸發提醒。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { technicalSource } from '@/lib/agents/candidates/sources/technicalSource';
import { youtubeSource }   from '@/lib/agents/candidates/sources/youtubeSource';
import { chipSource }      from '@/lib/agents/candidates/sources/chipSource';
import { fundamentalSource } from '@/lib/agents/candidates/sources/fundamentalSource';
import { mergeCandidates } from '@/lib/agents/candidates/merger';
import { savePool, loadPool } from '@/lib/agents/candidates/poolStorage';
import { loadScanSession } from '@/lib/storage/scanStorage';
import { getActiveStrategyServer } from '@/lib/strategy/activeStrategyServer';
import { buildTechnicalQuestion } from '@/lib/agents/agents/technicalAgent';
import { buildNewsQuestion }      from '@/lib/agents/agents/newsAgent';
import { buildChipQuestion }      from '@/lib/agents/agents/chipAgent';
import { buildFundamentalQuestion } from '@/lib/agents/agents/fundamentalAgent';
import {
  makeInitialPhaseState, makeRunId, writePhaseState, writeRunMeta,
  writeTechnicalQuestion, writeNewsQuestion, writeChipQuestion, writeFundamentalQuestion,
} from '@/lib/agents/orchestrator';
import { AGENT_SCHEMA_VERSION } from '@/lib/agents/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import type { MarketId, MtfMode, ScanSession, StockScanResult } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

const querySchema = z.object({
  market:         z.enum(['TW', 'CN']).default('TW'),
  top:            z.coerce.number().int().min(1).max(50).default(10),
  minSourceCount: z.coerce.number().int().min(1).max(4).default(1),
  skipPoolBuild:  z.enum(['0', '1']).default('0'),
});

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, top, minSourceCount, skipPoolBuild } = parsed.data;

  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const startedAt = Date.now();
  const log: string[] = [];
  const strategy = await getActiveStrategyServer();

  // ── Step 1: 建立 Pool（4 source extractors + merge）──
  let poolTotal = 0;
  if (skipPoolBuild === '0') {
    try {
      const [techRes, ytRes, chipRes, fundRes] = await Promise.all([
        technicalSource.extract({ market: market as MarketId, date, strategyId: strategy.id }),
        youtubeSource.extract({ market: market as MarketId, date }),
        chipSource.extract({ market: market as MarketId, date, strategyId: strategy.id }),
        fundamentalSource.extract({ market: market as MarketId, date, strategyId: strategy.id }),
      ]);
      const pool = mergeCandidates({ market: market as MarketId, date, strategyId: strategy.id, results: [techRes, ytRes, chipRes, fundRes] });
      await savePool(pool);
      poolTotal = pool.candidates.length;
      log.push(`Pool 建立完成：${poolTotal} 檔（tech:${techRes.candidates.length} yt:${ytRes.candidates.length} chip:${chipRes.candidates.length} fund:${fundRes.candidates.length}）`);
    } catch (err) {
      log.push(`Pool 建立失敗：${err instanceof Error ? err.message : String(err)}`);
      return apiError(`Pool build failed: ${log.join('; ')}`, 500);
    }
  } else {
    const pool = await loadPool(market as MarketId, date, strategy.id);
    poolTotal = pool?.candidates.length ?? 0;
    log.push(`skipPoolBuild=1，使用既有 pool（${poolTotal} 檔）`);
  }

  // ── Step 2: prepare-batch top N ──
  const pool = await loadPool(market as MarketId, date, strategy.id);
  if (!pool) {
    return apiError(`Pool not found after build for ${market}/${date}`, 404);
  }

  const eligible = pool.candidates
    .filter((c) => c.sourceCount >= minSourceCount)
    .slice(0, top);

  if (eligible.length === 0) {
    return apiOk({ date, poolTotal, prepared: 0, failed: 0, log, nextStep: 'Pool 無候選' });
  }

  const sessionCache = new Map<string, ScanSession | null>();
  const prepared: string[] = [];
  const failed: string[] = [];

  for (const candidate of eligible) {
    try {
      const found = await resolveCandidateRow(candidate, market as MarketId, date, sessionCache, strategy.id);
      if (!found) {
        failed.push(`${candidate.symbol}: no technical source`);
        continue;
      }
      const { row, session } = found;
      const runId = makeRunId(date, candidate.symbol, session.scanTime);

      const technicalQ = buildTechnicalQuestion({
        runId, date, symbol: candidate.symbol, session, candidateRow: row, strategy, candidate,
      });
      const [newsQ, chipQ, fundamentalQ] = await Promise.all([
        buildNewsQuestion({ runId, date, symbol: candidate.symbol, market: row.market, name: row.name, candidate }),
        buildChipQuestion({ runId, date, symbol: candidate.symbol, market: row.market, candidate }),
        buildFundamentalQuestion({ runId, date, symbol: candidate.symbol, market: row.market, name: row.name, industry: row.industry ?? candidate.industry, candidate }),
      ]);

      await Promise.all([
        writeTechnicalQuestion(technicalQ),
        writeNewsQuestion(newsQ),
        writeChipQuestion(chipQ),
        writeFundamentalQuestion(fundamentalQ),
      ]);

      const phase = makeInitialPhaseState({ runId, date, symbol: candidate.symbol, market: row.market, strategyId: strategy.id });
      await writePhaseState(date, candidate.symbol, phase);
      await writeRunMeta({ schemaVersion: AGENT_SCHEMA_VERSION, runId, date, symbol: candidate.symbol, market: row.market, strategyId: strategy.id, startedAt: phase.startedAt });

      prepared.push(candidate.symbol);
    } catch (err) {
      failed.push(`${candidate.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const elapsed = Date.now() - startedAt;
  log.push(`prepare-batch 完成：${prepared.length} 準備好，${failed.length} 失敗（${elapsed}ms）`);

  return apiOk({
    date,
    market,
    poolTotal,
    eligibleCount: eligible.length,
    prepared: prepared.length,
    preparedSymbols: prepared,
    failed: failed.length,
    failedDetail: failed,
    elapsedMs: elapsed,
    log,
    nextStep: prepared.length > 0
      ? `已備妥 ${prepared.length} 檔 question.json，請在 Claude Code 對話執行 /multi-agent-decide`
      : '無可處理候選',
  });
}

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
    const key = `${market}|${track}|${date}|${strategyId}`;
    let session = cache.get(key);
    if (session === undefined) {
      session = await loadScanSession(market, date, 'long', track as MtfMode, strategyId);
      cache.set(key, session);
    }
    if (!session) continue;
    const row = session.results.find((r) => r.symbol === candidate.symbol);
    if (row) return { row, session };
  }
  return null;
}
