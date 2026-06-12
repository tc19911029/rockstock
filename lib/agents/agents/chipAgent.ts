/**
 * Chip Agent (Agent C) — 籌碼面 prefetch + question builder
 *
 * 紅線：
 *   - 只看籌碼資料（三大法人 / 融資融券 / 借券 / 大戶 / 當沖）
 *   - dataPoints 必須全部 category='chip'
 *   - 不解讀技術型態、不評論基本面
 *
 * 資料來源：
 *   - /api/chip?symbol=... → 綜合籌碼評分 + 各項數字
 *   - /api/institutional/{ticker}?mode=summary → 法人連續買賣超
 */

import { fetchJSON, internalUrl, bareTicker } from './_fetchHelper';
import {
  AGENT_SCHEMA_VERSION,
  ChipGroundTruth,
  ChipQuestion,
} from '@/lib/agents/types';
import { CHIP_JUDGMENT_RULES } from '@/lib/agents/judgmentRules';
import type { MarketId } from '@/lib/scanner/types';
import type { Candidate } from '@/lib/agents/candidates/types';
import { sliceSourcesForAgent } from '@/lib/agents/candidates/types';

// ────────────────────────────────────────────────────────────────────────────

export interface BuildChipQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  candidate?: Candidate;
}

export async function buildChipQuestion(args: BuildChipQuestionArgs): Promise<ChipQuestion> {
  const { runId, date, symbol, market, candidate } = args;
  const fetchErrors: string[] = [];

  const [chipRaw, instRaw] = await Promise.all([
    fetchJSON(internalUrl(`/api/chip?symbol=${encodeURIComponent(symbol)}`))
      .catch((e) => { fetchErrors.push(`chip: ${e}`); return null; }),
    fetchInstitutional(symbol)
      .catch((e) => { fetchErrors.push(`institutional: ${e}`); return null; }),
  ]);

  const chip = normaliseChipResponse(chipRaw);
  if (!chip) fetchErrors.push('chip api returned null');

  const groundTruth: ChipGroundTruth = {
    symbol,
    chip,
    institutionalHistory: instRaw ?? null,
    fetchErrors,
  };

  const question: ChipQuestion = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'chip',
    runId,
    date,
    symbol,
    market,
    groundTruth,
    judgmentRulesRef: CHIP_JUDGMENT_RULES,
  };
  if (candidate) {
    question.entryContext = {
      sources: sliceSourcesForAgent(candidate.sources, 'chip') as Pick<Candidate['sources'], 'chip'>,
      sourceCount: candidate.sourceCount,
    };
  }
  return question;
}

// ────────────────────────────────────────────────────────────────────────────

async function fetchInstitutional(symbol: string): Promise<unknown> {
  const ticker = bareTicker(symbol);
  return fetchJSON(internalUrl(`/api/institutional/${encodeURIComponent(ticker)}?mode=summary`));
}

function normaliseChipResponse(raw: unknown): ChipGroundTruth['chip'] {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const numOrNull = (k: string): number | null => {
    const v = r[k];
    return typeof v === 'number' ? v : null;
  };
  const strOrNull = (k: string): string | null => {
    const v = r[k];
    return typeof v === 'string' && v ? v : null;
  };

  return {
    chipScore:           numOrNull('chipScore'),
    chipGrade:           strOrNull('chipGrade'),
    chipSignal:          strOrNull('chipSignal'),
    chipDetail:          strOrNull('chipDetail'),
    foreignBuy:          numOrNull('foreignBuy'),
    trustBuy:            numOrNull('trustBuy'),
    dealerBuy:           numOrNull('dealerBuy'),
    totalInstitutional:  numOrNull('totalInstitutional'),
    marginBalance:       numOrNull('marginBalance'),
    marginNet:           numOrNull('marginNet'),
    shortBalance:        numOrNull('shortBalance'),
    shortNet:            numOrNull('shortNet'),
    marginUtilRate:      numOrNull('marginUtilRate'),
    dayTradeVolume:      numOrNull('dayTradeVolume'),
    dayTradeRatio:       numOrNull('dayTradeRatio'),
    largeTraderBuy:      numOrNull('largeTraderBuy'),
    largeTraderSell:     numOrNull('largeTraderSell'),
    largeTraderNet:      numOrNull('largeTraderNet'),
    lendingBalance:      numOrNull('lendingBalance'),
    lendingNet:          numOrNull('lendingNet'),
    largeHolderPct:      numOrNull('largeHolderPct'),
    largeHolderChange:   numOrNull('largeHolderChange'),
  };
}
