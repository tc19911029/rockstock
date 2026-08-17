/**
 * POST /api/agents/portfolio/prepare-holding?symbol=&date=
 *      /api/agents/portfolio/prepare-holding?date=&all=1     ← 批量：對 holdings.json 內所有持股
 *
 * 持股版 prepare — bypass L4 session pool 檢查（因為持股不一定在當日掃描池內）。
 * 流程：
 *   1. 嘗試從近 14 天的 scan session 找該檔的 candidateRow（給 technical agent 用）
 *   2. 找不到就 skip technical，只跑 news + chip + fundamental（仿 portfolio-review）
 *   3. 寫 question.json 到 /tmp/rockstock-agents/{date}/{symbol}/
 *   4. 用戶在 Claude Code 對話內輸入 /multi-agent-decide {symbol}
 */

import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { checkSameOriginOrCron } from '@/lib/api/sameOriginAuth';
import { loadScanSession, listScanDates } from '@/lib/storage/scanStorage';
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
import type { MarketId, StockScanResult } from '@/lib/scanner/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbol: z.string().min(1).optional(),
  all: z.enum(['1', 'true']).optional(),
});

interface HoldingEntry {
  symbol: string;
  name?: string;
  market?: MarketId;
  entryPrice?: number;
  entryDate?: string;
  status?: 'open' | 'closed';
}

interface PrepareResult {
  symbol: string;
  ok: boolean;
  agentsPrepped: string[];
  skippedTechnical: boolean;
  candidateRowSource: 'today' | 'recent' | 'fallback' | null;
  error?: string;
}

async function loadHoldings(): Promise<HoldingEntry[]> {
  const filePath = path.join(process.cwd(), 'data', 'agents', 'portfolio', 'holdings.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.holdings)) return parsed.holdings;
    return [];
  } catch {
    return [];
  }
}

/**
 * 從近 14 天的 scan session 找該檔 candidateRow。找不到回 null。
 */
async function findRecentCandidateRow(
  market: MarketId,
  symbol: string,
  date: string,
  strategyId: string,
): Promise<{ row: StockScanResult; source: 'today' | 'recent'; foundAt: string } | null> {
  // 先試 today
  try {
    const session = await loadScanSession(market, date, 'long', 'daily', strategyId);
    const row = session?.results.find((r) => r.symbol === symbol);
    if (row) return { row, source: 'today', foundAt: date };
  } catch { /* ignore */ }

  // Fallback：近 14 天
  try {
    const dates = await listScanDates(market, 'long', 'daily', strategyId);
    const recentDates = dates
      .map((d) => d.date)
      .filter((d) => d < date)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, 14);

    for (const d of recentDates) {
      try {
        const session = await loadScanSession(market, d, 'long', 'daily', strategyId);
        const row = session?.results.find((r) => r.symbol === symbol);
        if (row) return { row, source: 'recent', foundAt: d };
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  return null;
}

async function prepareSingle(
  symbol: string,
  date: string,
  holding: HoldingEntry | null,
): Promise<PrepareResult> {
  const market: MarketId = holding?.market ?? (symbol.match(/^\d{6}(\.SS|\.SZ)?$/) ? 'CN' : 'TW');
  const name = holding?.name ?? symbol;

  const agentsPrepped: string[] = [];
  let candidateInfo: Awaited<ReturnType<typeof findRecentCandidateRow>> = null;

  try {
    const runId = makeRunId(date, symbol, new Date().toISOString());
    const strategy = await getActiveStrategyServer();
    candidateInfo = await findRecentCandidateRow(market, symbol, date, strategy.id);

    // Technical — 只有找到 candidateRow 才跑
    if (candidateInfo) {
      const session = await loadScanSession(market, candidateInfo.foundAt, 'long', 'daily', strategy.id);
      if (session) {
        const technicalQ = buildTechnicalQuestion({
          runId, date, symbol, session, candidateRow: candidateInfo.row, strategy,
        });
        await writeTechnicalQuestion(technicalQ);
        agentsPrepped.push('technical');
      }
    }

    // News / Chip / Fundamental — 不需要 candidateRow，always 跑
    const [newsQ, chipQ, fundamentalQ] = await Promise.all([
      buildNewsQuestion({
        runId, date, symbol, market, name,
      }),
      buildChipQuestion({
        runId, date, symbol, market,
      }),
      buildFundamentalQuestion({
        runId, date, symbol, market, name,
        industry: candidateInfo?.row.industry,
      }),
    ]);

    await Promise.all([
      writeNewsQuestion(newsQ),
      writeChipQuestion(chipQ),
      writeFundamentalQuestion(fundamentalQ),
    ]);
    agentsPrepped.push('news', 'chip', 'fundamental');

    const phase = makeInitialPhaseState({ runId, date, symbol, market, strategyId: strategy.id });
    await writePhaseState(date, symbol, phase);

    await writeRunMeta({
      schemaVersion: AGENT_SCHEMA_VERSION,
      runId, date, symbol, market,
      strategyId: strategy.id,
      startedAt: phase.startedAt,
    });

    return {
      symbol,
      ok: true,
      agentsPrepped,
      skippedTechnical: !candidateInfo,
      candidateRowSource: candidateInfo?.source ?? null,
    };
  } catch (e) {
    return {
      symbol,
      ok: false,
      agentsPrepped,
      skippedTechnical: !candidateInfo,
      candidateRowSource: candidateInfo?.source ?? null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function POST(req: NextRequest) {
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { date, symbol, all } = parsed.data;

  if (!symbol && !all) {
    return apiError('必須指定 symbol 或加 all=1', 400);
  }

  const holdings = await loadHoldings();

  // 批量模式
  if (all) {
    const openHoldings = holdings.filter((h) => h.status !== 'closed');
    if (openHoldings.length === 0) {
      return apiOk({ mode: 'all', totalHoldings: 0, results: [] });
    }

    const results: PrepareResult[] = [];
    for (const h of openHoldings) {
      const bare = h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const r = await prepareSingle(bare, date, h);
      results.push(r);
    }

    const okCount = results.filter((r) => r.ok).length;
    return apiOk({
      mode: 'all',
      totalHoldings: openHoldings.length,
      okCount,
      results,
      nextStep:
        `已對 ${okCount} 檔持股寫好 question.json。` +
        `請在 Claude Code 對話中輸入 /multi-agent-decide 跑全部，或 /multi-agent-decide {symbol} 跑單檔。`,
    });
  }

  // 單檔模式 — 接受 3661 / 3661.TW / 603986.SS 等格式，存檔用裸代號
  const bareSymbol = symbol!.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const holding = holdings.find((h) =>
    h.symbol === symbol || h.symbol === bareSymbol || h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '') === bareSymbol,
  ) ?? null;
  const result = await prepareSingle(bareSymbol, date, holding);

  if (!result.ok) return apiError(`prepare-holding 失敗：${result.error}`, 500);

  const { tmpDir, persistDir } = getRunPaths(date, symbol!);
  return apiOk({
    mode: 'single',
    ...result,
    tmpDir,
    persistDir,
    nextStep:
      `已寫 ${result.agentsPrepped.length} 個 question.json` +
      (result.skippedTechnical ? '（已 skip technical — 近 14 天無 scan session 紀錄）' : '') +
      `。請在 Claude Code 對話中輸入 /multi-agent-decide ${symbol} 觸發 4-phase 分析。`,
  });
}
