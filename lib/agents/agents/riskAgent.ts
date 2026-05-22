/**
 * Risk Agent (Agent E) — 風控
 *
 * 紅線（§0）：
 *   - 只挑毛病，不找買進理由
 *   - 不可給 'pass' verdict — 只給 green/yellow/red 風險等級
 *   - dataPoint 不歸 Risk（風控無 dataPoint category；接受所有 category 引用 A-D 的）
 *
 * 紅燈規則（hardBlocker → verdict='red'）：
 *   - 觸發任一淘汰法 (eliminationReasons 非空)
 *   - 觸發戒律 8（空頭紅 K 反彈）
 *   - 即將發生重大事件（除權息 T-3 內、法說會 T-1 內）
 *
 * 黃燈規則（softWarning → verdict='yellow'）：
 *   - trendPosition='接近壓力區'
 *   - mtfWeeklyPass=false 但日線多頭
 *   - 融資過熱（marginUtilRate > 25%）
 *   - 漲多回檔風險（changePercent > 7% 且接近壓力）
 */

import { fetchJSON, internalUrl } from './_fetchHelper';
import { readChipAnswer, readFundamentalAnswer, readNewsAnswer, readTechnicalAnswer } from '@/lib/agents/orchestrator';
import {
  AGENT_SCHEMA_VERSION,
  RiskGroundTruth,
  RiskQuestion,
} from '@/lib/agents/types';
import type { MarketId, StockScanResult } from '@/lib/scanner/types';

export interface BuildRiskQuestionArgs {
  runId: string;
  date: string;
  symbol: string;
  market: MarketId;
  /** 從 L4 取的 candidateRow（同 Technical Agent 來源）*/
  candidateRow: StockScanResult;
}

export async function buildRiskQuestion(args: BuildRiskQuestionArgs): Promise<RiskQuestion> {
  const { runId, date, symbol, market, candidateRow } = args;
  const fetchErrors: string[] = [];

  // 讀已完成的 4 個 analyst answer（Risk 必須在 Phase 1 後跑）
  const [tech, news, chip, fundamental, marketTrendRaw] = await Promise.all([
    readTechnicalAnswer(date, symbol),
    readNewsAnswer(date, symbol),
    readChipAnswer(date, symbol),
    readFundamentalAnswer(date, symbol),
    fetchJSON(internalUrl(`/api/scanner/market-trend?market=${market}&date=${date}`))
      .catch((e) => { fetchErrors.push(`market-trend: ${e}`); return null; }),
  ]);

  const marketRegime = extractTrend(marketTrendRaw);

  const groundTruth: RiskGroundTruth = {
    symbol,
    candidateRow,
    analystVerdicts: {
      technical:   tech   ? { verdict: tech.verdict,   overview: tech.overview }   : null,
      news:        news   ? { verdict: news.verdict,   overview: news.overview }   : null,
      chip:        chip   ? { verdict: chip.verdict,   overview: chip.overview }   : null,
      fundamental: fundamental ? { verdict: fundamental.verdict, overview: fundamental.overview } : null,
    },
    marketRegime,
    fetchErrors,
  };

  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    agent: 'risk',
    runId,
    date,
    symbol,
    market,
    groundTruth,
  };
}

function extractTrend(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { trend?: string };
  return r.trend ?? null;
}
