/**
 * GET /api/cost-basis?symbol=3661&date=YYYY-MM-DD
 *
 * 回傳 CostBasisBundle：9 項成本／壓力價（外資/投信/自營/主力/融資/融券/券賣 成本
 * + 嘎空價 + 融資斷頭價）× 5/10/20/60d + 融資斷頭壓力分數 + 白話解讀 + 風險提示。
 *
 * 純顯示用，不進選股 gate（鐵則 #5）。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { getCostBasisBundle } from '@/lib/chipcost/aggregate';
import { isIndexSymbol } from '@/lib/utils/symbols';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  symbol: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function todayTaipei(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    symbol: url.searchParams.get('symbol') ?? '',
    date: url.searchParams.get('date') ?? undefined,
  });
  if (!parsed.success) return apiValidationError(parsed.error);

  const { symbol, date } = parsed.data;
  if (isIndexSymbol(symbol)) return apiError('指數無成本分析', 400);
  const asOfDate = date ?? todayTaipei();

  try {
    const data = await getCostBasisBundle(symbol, asOfDate);
    return apiOk({ costBasis: data });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500);
  }
}
