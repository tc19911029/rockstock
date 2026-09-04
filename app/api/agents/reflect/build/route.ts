/**
 * POST /api/agents/reflect/build?from=&to=&market=
 *
 * 整理區間資料給 /agents-reflect skill 寫 markdown 報告。
 *
 * §0 紅線：
 *   - 純資料整理，不生成「修改 agent 邏輯」的指令
 *   - 寫的 question.json 給 skill 讀，skill 寫 markdown
 *   - skill 寫的 markdown **不會** 被任何 prepare 讀
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { checkSensitiveMutationAuth } from '@/lib/api/sameOriginAuth';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import { agentsListChildDirs } from '@/lib/agents/persistStorage';
import { listBacktestDates, loadBacktest } from '@/lib/agents/backtest/storage';
import { aggregateBacktestSummary } from '@/lib/agents/backtest/summary';
import { getMemoryPath } from '@/lib/agents/memory/storage';
import { MEMORY_KINDS, MEMORY_SCHEMA_VERSION, ReflectQuestion } from '@/lib/agents/memory/types';
import type { BacktestEntry } from '@/lib/agents/backtest/types';
import type { MarketId } from '@/lib/scanner/types';
import type { MemoryKind } from '@/lib/agents/memory/types';

export const runtime = 'nodejs';

const querySchema = z.object({
  market: z.enum(['TW', 'CN']).default('TW'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(req: NextRequest) {
  const denied = checkSensitiveMutationAuth(req);
  if (denied) return denied;

  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { market, from, to } = parsed.data;

  // 1. 載入區間所有 backtest
  const dates = await listBacktestDates(market as MarketId);
  const inRange = dates.filter(d => d >= from && d <= to);
  const reports = (await Promise.all(
    inRange.map(d => loadBacktest(market as MarketId, d)),
  )).filter((r): r is NonNullable<typeof r> => r !== null);

  const backtestSummary = aggregateBacktestSummary(reports, from, to);

  // 2. 每日 decision 索引
  const decisions: ReflectQuestion['decisions'] = await Promise.all(
    inRange.map(async (date) => {
      // dual-storage 列舉 runs/{date}/ 下的 symbol 目錄（Vercel Blob 用 prefix list 推導）
      const symbols = await agentsListChildDirs(`agents/runs/${date}`);
      const report = reports.find(r => r.date === date);
      const dist = {
        buy:   report?.entries.filter(e => e.action === 'buy').length ?? 0,
        watch: report?.entries.filter(e => e.action === 'watch').length ?? 0,
        skip:  report?.entries.filter(e => e.action === 'skip').length ?? 0,
      };
      return { date, symbols, actionDistribution: dist };
    }),
  );

  // 3. 找衝突 case（4 個 verdict 不一致的）
  const conflictCases: ReflectQuestion['conflictCases'] = [];
  for (const report of reports) {
    for (const e of report.entries) {
      if (isConflictCase(e)) {
        conflictCases.push({
          date: report.date,
          symbol: e.symbol,
          verdictsByAgent: e.verdictsByAgent as Record<string, string | null>,
          action: e.action,
          decisionPath: e.decisionPath,
          d5Return:  e.d5Return,
          d20Return: e.d20Return,
        });
      }
    }
  }
  conflictCases.sort((a, b) => `${a.date}|${a.symbol}`.localeCompare(`${b.date}|${b.symbol}`));

  // 4. 寫 question.json 到 /tmp
  const outputPaths = MEMORY_KINDS.reduce((acc, kind) => {
    if (kind !== 'weekly') {
      acc[kind] = getMemoryPath(kind);
    }
    return acc;
  }, {} as Record<MemoryKind, string>);
  // 加 weekly：用 to 日期所在 ISO 週
  outputPaths.weekly = getMemoryPath('weekly', isoWeek(to));

  const question: ReflectQuestion = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    from, to,
    market: market as MarketId,
    generatedAt: new Date().toISOString(),
    backtestSummary,
    decisions,
    conflictCases,
    outputPaths,
  };

  const tmpDir = '/tmp/rockstock-agents/reflect';
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${from}_to_${to}-question.json`);
  await atomicFsPut(tmpFile, JSON.stringify(question, null, 2));

  return apiOk({
    from, to, market,
    questionPath: tmpFile,
    decisionsCount: decisions.reduce((s, d) => s + d.symbols.length, 0),
    conflictCount: conflictCases.length,
    backtestDatesIncluded: inRange.length,
    outputPaths,
    nextStep: '請在 Claude Code 對話中執行 /agents-reflect 生成 markdown 報告',
  });
}

/**
 * 判斷是否為衝突 case：
 *   - 4 個面向 verdict 不一致（有 pass + fail）
 *   - 或 risk verdict 與其他 verdict 顯著不同
 */
function isConflictCase(e: BacktestEntry): boolean {
  const verdicts = [
    e.verdictsByAgent.technical,
    e.verdictsByAgent.news,
    e.verdictsByAgent.chip,
    e.verdictsByAgent.fundamental,
  ].filter(Boolean);
  if (verdicts.length < 2) return false;
  const hasPass = verdicts.some(v => v === 'pass');
  const hasFail = verdicts.some(v => v === 'fail');
  if (hasPass && hasFail) return true;
  // risk red 但其他都 pass → 也算衝突（已有 contract 守 action=skip，但值得分析）
  if (e.verdictsByAgent.risk === 'red' && hasPass) return true;
  return false;
}

/** YYYY-MM-DD → YYYY-Www（ISO 8601 週）*/
function isoWeek(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
