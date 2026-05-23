/**
 * /api/portfolio/close-trade — 平倉
 *
 * POST { symbol, exitPrice, exitDate?, exitReason, exitNote?, notes? }
 *
 * 行為：
 *   1. 從 holdings.json 找 open holding by symbol
 *   2. buildClosedTrade + appendTrade（trades.json + closed/{YYYY-MM}.json）
 *   3. 從 holdings.json 移除（搬家不重複）
 *   4. 回傳 trade
 *
 * 不變式：
 *   - 先寫 trades 才動 holdings（trades 是事實源，永久；holdings 失敗可重試）
 *   - 同 tradeId 不可重複（appendTrade 內 dedup）
 *   - 不可平倉「不存在」或「已 closed」的持股
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { atomicFsPut } from '@/lib/storage/atomicFsPut';
import {
  appendTrade,
  type TradeExitReason,
} from '@/lib/portfolio/tradeRecorder';
import {
  PORTFOLIO_SCHEMA_VERSION,
  type PortfolioFile,
} from '@/lib/agents/portfolio/types';

export const runtime = 'nodejs';

const closeSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
  exitPrice: z.coerce.number().positive(),
  exitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  exitReason: z.enum([
    'target_hit', 'stop_loss', 'discipline_break', 'risk_red',
    'hold_days_max', 'manual', 'swap', 'other',
  ]),
  exitNote: z.string().optional(),
  notes: z.string().optional(),
});

function todayCstDate(): string {
  const tw = new Date(Date.now() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

const HOLDINGS_FILE = path.join(process.cwd(), 'data', 'agents', 'portfolio', 'holdings.json');

async function loadRawHoldings(): Promise<PortfolioFile> {
  try {
    const raw = await fs.readFile(HOLDINGS_FILE, 'utf-8');
    return JSON.parse(raw) as PortfolioFile;
  } catch {
    return { schemaVersion: PORTFOLIO_SCHEMA_VERSION, holdings: [], updatedAt: new Date().toISOString() };
  }
}

async function saveRawHoldings(file: PortfolioFile): Promise<void> {
  await fs.mkdir(path.dirname(HOLDINGS_FILE), { recursive: true });
  file.updatedAt = new Date().toISOString();
  await atomicFsPut(HOLDINGS_FILE, JSON.stringify(file, null, 2));
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return apiError('invalid JSON body', 400); }
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);
  const input = parsed.data;
  const exitDate = input.exitDate ?? todayCstDate();

  // 1. 找 holding
  const file = await loadRawHoldings();
  const idx = file.holdings.findIndex(h => h.symbol === input.symbol && h.status === 'open');
  if (idx < 0) return apiError(`open holding ${input.symbol} 不存在`, 404);
  const holding = file.holdings[idx];

  // 2. append trade
  let trade;
  try {
    trade = await appendTrade({
      symbol: holding.symbol,
      name: holding.name,
      market: holding.market,
      industry: holding.industry,
      entryDate: holding.entryDate,
      entryPrice: holding.entryPrice,
      shares: holding.shares,
      entryDecisionRunId: holding.entryDecisionRunId,
      stopLoss: holding.stopLoss,
      target1: holding.target1,
      target2: holding.target2,
      exitDate,
      exitPrice: input.exitPrice,
      exitReason: input.exitReason as TradeExitReason,
      exitNote: input.exitNote,
      notes: input.notes,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return apiError(`appendTrade 失敗：${msg}`, 422);
  }

  // 3. 從 holdings 移除
  file.holdings.splice(idx, 1);
  await saveRawHoldings(file);

  return apiOk({ trade });
}
