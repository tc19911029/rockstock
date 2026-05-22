/**
 * Fundamental Agent (Agent D) — 基本面 prefetch + question builder
 *
 * 紅線：
 *   - 只看月營收 / EPS / 毛利率 / 估值 / 產業
 *   - dataPoints category 必須是 'fundamental' | 'valuation' | 'industry'
 *   - 禁止評論價格走勢
 *
 * 資料來源：
 *   - /api/fundamentals/{symbol}?mode=full → eps/epsYoY/grossMargin/per/pbr/revenue*
 *   - candidateRow.industry（已從 L4 拿到）
 */

import { fetchJSON, internalUrl } from './_fetchHelper';
import {
  AGENT_SCHEMA_VERSION,
  FundamentalGroundTruth,
  FundamentalQuestion,
} from '@/lib/agents/types';
import type { MarketId } from '@/lib/scanner/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import { sliceSourcesForAgent } from '@/lib/agents/candidates/types';

// ────────────────────────────────────────────────────────────────────────────

export interface BuildFundamentalQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** 已從 candidateRow.name 取 */
  name: string;
  /** 已從 candidateRow.industry 取（可能 undefined）*/
  industry?: string;
  candidate?: Candidate;
}

export async function buildFundamentalQuestion(
  args: BuildFundamentalQuestionArgs,
): Promise<FundamentalQuestion> {
  const { runId, date, symbol, market, name, industry, candidate } = args;
  const fetchErrors: string[] = [];

  const fundamentalsRaw = await fetchJSON(
    internalUrl(`/api/fundamentals/${encodeURIComponent(symbol)}?mode=full`),
  ).catch((e) => { fetchErrors.push(`fundamentals: ${e}`); return null; });

  const fundamentals = normaliseFundamentals(fundamentalsRaw);
  if (!fundamentals) fetchErrors.push('fundamentals api returned null');

  const groundTruth: FundamentalGroundTruth = {
    symbol,
    name: name || null,
    fundamentals,
    industry: industry ?? null,
    fetchErrors,
  };

  const question: FundamentalQuestion = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'fundamental',
    runId,
    date,
    symbol,
    market,
    groundTruth,
  };
  if (candidate) {
    question.entryContext = {
      sources: sliceSourcesForAgent(candidate.sources, 'fundamental') as Pick<
        Candidate['sources'], 'fundamental'
      >,
      sourceCount: candidate.sourceCount,
    };
  }
  return question;
}

// ────────────────────────────────────────────────────────────────────────────

function normaliseFundamentals(raw: unknown): FundamentalGroundTruth['fundamentals'] {
  if (!raw || typeof raw !== 'object') return null;
  // apiOk 包成 { ok: true, data: {...} }
  const wrapper = raw as { data?: unknown };
  const data = wrapper.data && typeof wrapper.data === 'object' ? wrapper.data : raw;
  const r = data as Record<string, unknown>;

  const numOrNull = (k: string): number | null => {
    const v = r[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  return {
    eps:            numOrNull('eps'),
    epsYoY:         numOrNull('epsYoY'),
    grossMargin:    numOrNull('grossMargin'),
    netMargin:      numOrNull('netMargin'),
    per:            numOrNull('per'),
    pbr:            numOrNull('pbr'),
    dividendYield:  numOrNull('dividendYield'),
    revenueLatest:  numOrNull('revenueLatest'),
    revenueMoM:     numOrNull('revenueMoM'),
    revenueYoY:     numOrNull('revenueYoY'),
  };
}
