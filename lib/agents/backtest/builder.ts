/**
 * Backtest Builder — 對該日所有 FinalDecision 接 ForwardAnalyzer 算 d1-d20
 *
 * 流程：
 *   1. 列 data/agents/runs/{date}/ 下所有 symbol 目錄
 *   2. 對每檔讀 decision.json + technical.json (取 candidateRow.price)
 *   3. 並行呼叫 analyzeForwardBatch
 *   4. 計算 stopLoss/target 是否觸發（用 maxLoss/maxGain 推算）
 *   5. 寫 data/agents/backtest/{market}/{date}.json
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import {
  BACKTEST_SCHEMA_VERSION,
  BacktestEntry,
  BacktestReport,
} from './types';
import type { FinalDecision, TechnicalAnswer } from '@/lib/agents/types';
import type { AgentRunMeta } from '@/lib/agents/types';
import type { MarketId, StockForwardPerformance } from '@/lib/scanner/types';
import { resolveStockIdentity } from '@/lib/stocks/resolveStockIdentity';
import { UNRESOLVED_STOCK_NAME } from '@/lib/stocks/stockIdentity';

export interface BuildBacktestArgs {
  market: MarketId;
  date: string;
}

export async function buildBacktest(args: BuildBacktestArgs): Promise<BacktestReport> {
  const { market, date } = args;
  const runsDir = path.join(process.cwd(), 'data', 'agents', 'runs', date);

  // 1. 列 symbol 目錄
  let symbols: string[] = [];
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    symbols = entries
      .filter(e => e.isDirectory() && /^[A-Za-z0-9._-]+$/.test(e.name))
      .map(e => e.name);
  } catch {
    return emptyReport(market, date);
  }

  // 2. 讀每檔的 decision + technical + meta
  const targets: Array<{
    meta: AgentRunMeta;
    decision: FinalDecision;
    technical: TechnicalAnswer | null;
    entryPrice: number | null;
  }> = [];

  for (const sym of symbols) {
    const symDir = path.join(runsDir, sym);
    const [metaRaw, decisionRaw, techRaw] = await Promise.all([
      fs.readFile(path.join(symDir, '_meta.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(symDir, 'decision.json'), 'utf-8').catch(() => null),
      fs.readFile(path.join(symDir, 'technical.json'), 'utf-8').catch(() => null),
    ]);
    if (!metaRaw || !decisionRaw) continue;
    let meta: AgentRunMeta;
    let decision: FinalDecision;
    let technical: TechnicalAnswer | null = null;
    try {
      meta = JSON.parse(metaRaw);
      decision = JSON.parse(decisionRaw);
      if (techRaw) technical = JSON.parse(techRaw);
    } catch {
      continue;
    }
    if (meta.market !== market) continue;
    const entryPrice = decision.entryPrice ?? extractPriceFromTechnical(technical);
    targets.push({ meta, decision, technical, entryPrice });
  }

  if (targets.length === 0) return emptyReport(market, date);

  const identities = await Promise.all(targets.map(t => resolveStockIdentity({
    symbol: t.meta.symbol,
    marketHint: t.meta.market,
  })));
  const nameBySymbol = new Map(identities.map(identity => [
    identity.requestedSymbol,
    identity.name ?? UNRESOLVED_STOCK_NAME,
  ]));

  // 3. ForwardAnalyzer
  const batchInput = targets
    .filter(t => t.entryPrice != null)
    .map(t => ({
      symbol: t.meta.symbol,
      name: nameBySymbol.get(t.meta.symbol) ?? UNRESOLVED_STOCK_NAME,
      scanPrice: t.entryPrice!,
    }));

  let forwardResults: StockForwardPerformance[] = [];
  if (batchInput.length > 0) {
    try {
      const batch = await analyzeForwardBatch(batchInput, date);
      forwardResults = batch.results;
    } catch (err) {
      console.warn('[backtest] analyzeForwardBatch failed:', err);
    }
  }

  const forwardBySymbol = new Map(forwardResults.map(r => [r.symbol, r]));

  // 4. 組 entries
  const entries: BacktestEntry[] = targets.map(t => {
    const f = forwardBySymbol.get(t.meta.symbol);
    const stop = t.decision.stopLoss;
    const target1 = t.decision.target1;
    const target2 = t.decision.target2;
    const entryPrice = t.entryPrice;

    let stopTriggered: boolean | undefined;
    let t1Triggered: boolean | undefined;
    let t2Triggered: boolean | undefined;
    if (entryPrice != null && f) {
      if (stop != null && f.maxDrawdown != null) {
        const lowPrice = entryPrice * (1 + f.maxDrawdown / 100);
        stopTriggered = lowPrice <= stop;
      }
      // maxGain 用各 dN return 推（取最大 dReturn）
      const maxGain = Math.max(
        f.d1Return ?? -Infinity,
        f.d2Return ?? -Infinity,
        f.d3Return ?? -Infinity,
        f.d5Return ?? -Infinity,
        f.d10Return ?? -Infinity,
        f.d20Return ?? -Infinity,
      );
      if (target1 != null && maxGain !== -Infinity) {
        const highPrice = entryPrice * (1 + maxGain / 100);
        t1Triggered = highPrice >= target1;
      }
      if (target2 != null && maxGain !== -Infinity) {
        const highPrice = entryPrice * (1 + maxGain / 100);
        t2Triggered = highPrice >= target2;
      }
    }

    const maxGainPct = f ? maxFromDReturns(f) : null;
    const maxLossPct = f?.maxDrawdown ?? null;

    return {
      symbol: t.meta.symbol,
      name: nameBySymbol.get(t.meta.symbol) ?? UNRESOLVED_STOCK_NAME,
      market: t.meta.market,
      action: t.decision.action,
      decisionPath: t.decision.decisionPath,
      bullScore: t.decision.bullScore,
      bearScore: t.decision.bearScore,
      sizeHint: t.decision.sizeHint,
      verdictsByAgent: {
        technical:   t.decision.verdictsByAgent.technical,
        news:        t.decision.verdictsByAgent.news,
        chip:        t.decision.verdictsByAgent.chip,
        fundamental: t.decision.verdictsByAgent.fundamental,
        risk:        t.decision.verdictsByAgent.risk,
      },
      entryPrice: entryPrice ?? null,
      d1Return:  f?.d1Return  ?? null,
      d2Return:  f?.d2Return  ?? null,
      d3Return:  f?.d3Return  ?? null,
      d5Return:  f?.d5Return  ?? null,
      d10Return: f?.d10Return ?? null,
      d20Return: f?.d20Return ?? null,
      maxGain: maxGainPct,
      maxLoss: maxLossPct,
      stopLoss: stop ?? null,
      target1: target1 ?? null,
      target2: target2 ?? null,
      stopLossTriggered: stopTriggered,
      target1Triggered: t1Triggered,
      target2Triggered: t2Triggered,
    };
  });

  return {
    schemaVersion: BACKTEST_SCHEMA_VERSION,
    date,
    market,
    generatedAt: new Date().toISOString(),
    computedThrough: deriveComputedThrough(entries),
    entries,
  };
}

function maxFromDReturns(f: StockForwardPerformance): number | null {
  const vals = [f.d1Return, f.d2Return, f.d3Return, f.d5Return, f.d10Return, f.d20Return]
    .filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

function deriveComputedThrough(entries: BacktestEntry[]): string | null {
  // 若任一檔有 d20Return → through 是「決策日 + 20 個交易日」
  const hasD20 = entries.some(e => e.d20Return != null);
  const hasD10 = entries.some(e => e.d10Return != null);
  const hasD5  = entries.some(e => e.d5Return  != null);
  const hasD1  = entries.some(e => e.d1Return  != null);
  if (hasD20) return 'd20+';
  if (hasD10) return 'd10';
  if (hasD5) return 'd5';
  if (hasD1) return 'd1';
  return null;
}

function extractPriceFromTechnical(tech: TechnicalAnswer | null): number | null {
  if (!tech) return null;
  const priceDp = tech.dataPoints.find(dp => dp.label === 'price' || dp.label === '當日收盤');
  if (!priceDp) return null;
  const num = parseFloat(priceDp.value.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function emptyReport(market: MarketId, date: string): BacktestReport {
  return {
    schemaVersion: BACKTEST_SCHEMA_VERSION,
    date, market,
    generatedAt: new Date().toISOString(),
    computedThrough: null,
    entries: [],
  };
}
