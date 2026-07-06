/**
 * /api/agents/portfolio — 持股 CRUD
 *
 * GET    list (or ?status=open|closed)
 * POST   新增/更新 holding（by symbol）
 * DELETE ?symbol= 關閉（標 closed）
 *
 * 出場優先用 close（保留 audit），真要硬刪才走 ?hard=1
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  closeHolding,
  deleteHolding,
  loadAllHoldings,
  upsertHolding,
} from '@/lib/agents/portfolio/storage';
import { resolveProfileId } from '@/lib/portfolio/profiles';
import { validateEntryPrice } from '@/lib/agents/portfolio/validateEntryPrice';
import { detectAveragingDown, mergeAveragedDownFlag } from '@/lib/portfolio/averagingDownGuard';
import { detectStopLossLowered, mergeStopLossLoweredFlag, type PositionSide } from '@/lib/portfolio/stopLossGuard';
import { todayYmdTaipei } from '@/lib/youtube/classify';

export const runtime = 'nodejs';

const upsertSchema = z.object({
  symbol: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1),
  market: z.enum(['TW', 'CN']),
  industry: z.string().optional(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entryPrice: z.coerce.number().positive(),
  shares: z.coerce.number().int().positive(),
  entryDecisionRunId: z.string().optional(),
  stopLoss: z.coerce.number().positive().optional(),
  target1: z.coerce.number().positive().optional(),
  target2: z.coerce.number().positive().optional(),
  notes: z.string().optional(),
  /** UI-only 富欄位 passthrough（entryKbar / triggerPrice / operationMode 等）*/
  ui: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['open', 'closed']).default('open'),
  /** 跳過 entryPrice 合理性驗證（極少數合理 case 如多筆平均成本）*/
  forcePrice: z.coerce.boolean().optional().default(false),
});

const closeSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
  closedPrice: z.coerce.number().positive(),
  closeReason: z.string().min(1),
});

const deleteSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9._-]+$/),
  hard: z.enum(['0', '1']).default('0'),
  closedPrice: z.coerce.number().positive().optional(),
  closeReason: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const market = url.searchParams.get('market'); // 可選：TW | CN（不帶 = 台股+陸股合併）
  const profileId = resolveProfileId(url.searchParams.get('profile'));
  let holdings = await loadAllHoldings(profileId);
  if (market === 'TW' || market === 'CN') {
    holdings = holdings.filter(h => h.market === market);
  }
  const filtered = status
    ? holdings.filter(h => h.status === status)
    : holdings;
  return apiOk({
    holdings: filtered,
    count: filtered.length,
    totalCount: holdings.length,
  });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return apiValidationError(parsed.error);

  const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
  const { forcePrice, ...holdingData } = parsed.data;

  // entryPrice 合理性檢查（除非 forcePrice=true 顯式略過）
  if (!forcePrice) {
    const check = await validateEntryPrice(
      holdingData.symbol,
      holdingData.market,
      holdingData.entryDate,
      holdingData.entryPrice,
    );
    if (!check.ok) {
      return apiError(check.reason ?? 'entryPrice validation failed', 422);
    }
  }

  // 課程 CH10-2（2026-07-04）：向下攤平紅旗 — upsert 咽喉單點偵測
  // （portfolioStore sync / import / 直接打 API 全走這裡）。只標旗不擋寫入。
  const all = await loadAllHoldings(profileId);
  const existing = all.find(h => h.symbol === holdingData.symbol && h.market === holdingData.market && h.status === 'open');
  if (existing) {
    const det = detectAveragingDown({
      existing: { entryPrice: existing.entryPrice, shares: existing.shares },
      incoming: { entryPrice: holdingData.entryPrice, shares: holdingData.shares },
    });
    const newFlag = det.flagged
      ? { date: todayYmdTaipei(new Date()), fromPrice: existing.entryPrice, toPrice: holdingData.entryPrice }
      : null;
    // 新旗 or 既有旗都要留（紅旗常駐到平倉，client 全量覆寫 ui 不得洗掉）
    const mergedUi = mergeAveragedDownFlag(holdingData.ui, existing.ui, newFlag);
    if (mergedUi !== holdingData.ui) holdingData.ui = mergedUi;

    // 課程 CH7-1（2026-07-06）：停損下修紅旗 — 同咽喉單點偵測（往「放鬆」方向改停損＝凹單）。
    // 做多往下、做空往上為放鬆；只標旗不擋寫入，紅旗常駐到平倉。串在攤平之後，兩旗共存於 disciplineFlags。
    const side: PositionSide = (existing.ui as Record<string, unknown> | undefined)?.positionSide === 'short' ? 'short' : 'long';
    const slDet = detectStopLossLowered({
      existing: { stopLoss: existing.stopLoss },
      incoming: { stopLoss: holdingData.stopLoss },
      positionSide: side,
    });
    const newSlFlag = slDet.flagged
      ? { date: todayYmdTaipei(new Date()), fromStop: existing.stopLoss!, toStop: holdingData.stopLoss!, side }
      : null;
    const mergedUi2 = mergeStopLossLoweredFlag(holdingData.ui, existing.ui, newSlFlag);
    if (mergedUi2 !== holdingData.ui) holdingData.ui = mergedUi2;
  }

  const holding = await upsertHolding(holdingData, profileId);
  return apiOk({ holding });
}

export async function DELETE(req: NextRequest) {
  const parsed = deleteSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const profileId = resolveProfileId(new URL(req.url).searchParams.get('profile'));
  const { symbol, hard, closedPrice, closeReason } = parsed.data;
  if (hard === '1') {
    const ok = await deleteHolding(symbol, profileId);
    if (!ok) return apiError(`holding ${symbol} not found`, 404);
    return apiOk({ deleted: true, mode: 'hard' });
  }
  if (closedPrice == null || !closeReason) {
    return apiError('close 模式需 closedPrice 與 closeReason；或加 ?hard=1 硬刪', 400);
  }
  const holding = await closeHolding(symbol, { closedPrice, closeReason }, profileId);
  if (!holding) return apiError(`open holding ${symbol} not found`, 404);
  return apiOk({ holding, mode: 'close' });
}
