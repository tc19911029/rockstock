/**
 * GET /api/agents/decisions?date=YYYY-MM-DD
 *
 * 列出該日 data/agents/runs/{date}/ 下所有 run（每檔 symbol 一筆）。
 *
 * 每筆含：
 *   - symbol
 *   - meta (runId, market, startedAt)
 *   - technical answer 的精簡欄位（verdict, overview, verdictReason）— 若已完成
 *   - status: 'pending' | 'completed'
 *
 * P2 範圍：只看 Technical Agent。其他 agent 加進來時擴 type。
 */

import { NextRequest } from 'next/server';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { readPhaseState } from '@/lib/agents/orchestrator';
import { loadStockMaster, lookupStock } from '@/lib/youtube/stockMaster';
import type {
  AgentRunMeta,
  ChipAnswer,
  FinalAction,
  FinalDecision,
  FundamentalAnswer,
  NewsAnswer,
  RiskAnswer,
  TechnicalAnswer,
} from '@/lib/agents/types';

type Verdict = 'pass' | 'watch' | 'fail';
interface VerdictSummary { verdict: Verdict; overview: string }

function summarise<T extends { verdict?: Verdict; overview?: string } | null>(
  ans: T,
): VerdictSummary | null {
  if (!ans || typeof ans !== 'object') return null;
  if (!ans.verdict || !ans.overview) return null;
  return { verdict: ans.verdict, overview: ans.overview };
}

export const runtime = 'nodejs';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

interface RunListItem {
  symbol: string;
  /** 從 stockMaster lookup 得來的中文簡稱（找不到時 null）*/
  name: string | null;
  /** 整體狀態：pending = 還沒到 Phase 4 / completed = decision.json 存在 */
  status: 'pending' | 'completed';
  /** P1+P2：每階段獨立狀態（解決 list 與 dashboard completed 定義不一致）*/
  phaseStatus: {
    phase1Done: boolean;  // 4 個 analyst answer 都有
    phase2Done: boolean;  // risk answer 有
    phase3Done: boolean;  // bull + bear 都有
    phase4Done: boolean;  // decision 有
  };
  runId: string | null;
  market: string | null;
  startedAt: string | null;
  /** 4 個面向 Agent 的 verdict 並列展示（§0 隔離 — 不混合加權）*/
  verdicts: {
    technical:   VerdictSummary | null;
    news:        VerdictSummary | null;
    chip:        VerdictSummary | null;
    fundamental: VerdictSummary | null;
  };
  /** P4：Risk 風控等級 + Decision 最終 action */
  risk: { verdict: 'green' | 'yellow' | 'red'; overview: string } | null;
  decision: {
    action: FinalAction;
    decisionPath: string;
    overview: string;
    bullScore: number;
    bearScore: number;
    sizeHint: number;
  } | null;
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { date } = parsed.data;

  const baseDir = path.join(process.cwd(), 'data', 'agents', 'runs', date);

  let symbols: string[] = [];
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    symbols = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // 過濾路徑安全（同 orchestrator）
      .filter((n) => /^[A-Za-z0-9._-]+$/.test(n));
  } catch {
    return apiOk({ date, runs: [], count: 0 });
  }

  // stockMaster lookup（symbol 2359.TW → 查 "2359"）— 失敗時 name=null，不影響其他欄位
  let master: Awaited<ReturnType<typeof loadStockMaster>> | null = null;
  try {
    master = await loadStockMaster();
  } catch (err) {
    console.warn('[decisions] stockMaster load failed:', err);
  }

  const runs: RunListItem[] = await Promise.all(
    symbols.map(async (symbol): Promise<RunListItem> => {
      const runDir = path.join(baseDir, symbol);
      const [meta, technical, news, chip, fundamental, risk, bull, bear, decision, phase] = await Promise.all([
        readJsonIfExists<AgentRunMeta>(path.join(runDir, '_meta.json')),
        readJsonIfExists<TechnicalAnswer>(path.join(runDir, 'technical.json')),
        readJsonIfExists<NewsAnswer>(path.join(runDir, 'news.json')),
        readJsonIfExists<ChipAnswer>(path.join(runDir, 'chip.json')),
        readJsonIfExists<FundamentalAnswer>(path.join(runDir, 'fundamental.json')),
        readJsonIfExists<RiskAnswer>(path.join(runDir, 'risk.json')),
        readJsonIfExists<unknown>(path.join(runDir, 'bull.json')),
        readJsonIfExists<unknown>(path.join(runDir, 'bear.json')),
        readJsonIfExists<FinalDecision>(path.join(runDir, 'decision.json')),
        readPhaseState(date, symbol),
      ]);
      // Phase 4 完成（有 decision）才算 fully completed
      const completed = !!decision;
      const phaseStatus = {
        phase1Done: !!(technical && news && chip && fundamental),
        phase2Done: !!risk,
        phase3Done: !!(bull && bear),
        phase4Done: !!decision,
      };
      const lookupKey = symbol.replace(/\.(TW|TWO)$/i, '');
      const name = master ? lookupStock(lookupKey, master)?.name ?? null : null;
      return {
        symbol,
        name,
        status: completed ? 'completed' : 'pending',
        phaseStatus,
        runId: meta?.runId ?? phase?.runId ?? null,
        market: meta?.market ?? phase?.market ?? null,
        startedAt: meta?.startedAt ?? phase?.startedAt ?? null,
        verdicts: {
          technical:   summarise(technical),
          news:        summarise(news),
          chip:        summarise(chip),
          fundamental: summarise(fundamental),
        },
        risk: risk ? { verdict: risk.verdict, overview: risk.overview } : null,
        decision: decision ? {
          action: decision.action,
          decisionPath: decision.decisionPath,
          overview: decision.overview,
          bullScore: decision.bullScore,
          bearScore: decision.bearScore,
          sizeHint: decision.sizeHint,
        } : null,
      };
    }),
  );

  // 已完成排前面；同 status 內依 decision action (buy→watch→skip) 再 technical verdict 再 symbol 排
  const actionRank: Record<string, number> = { buy: 0, watch: 1, skip: 2 };
  const verdictRank: Record<string, number> = { pass: 0, watch: 1, fail: 2 };
  runs.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'completed' ? -1 : 1;
    const aa = a.decision?.action ?? 'watch';
    const ba = b.decision?.action ?? 'watch';
    if (aa !== ba) return (actionRank[aa] ?? 99) - (actionRank[ba] ?? 99);
    const av = a.verdicts.technical?.verdict ?? 'watch';
    const bv = b.verdicts.technical?.verdict ?? 'watch';
    if (av !== bv) return (verdictRank[av] ?? 99) - (verdictRank[bv] ?? 99);
    return a.symbol.localeCompare(b.symbol);
  });

  return apiOk({ date, runs, count: runs.length });
}
