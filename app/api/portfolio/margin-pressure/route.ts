/**
 * GET /api/portfolio/margin-pressure?date=&symbols=2330.TW,300285.SZ
 *
 * 批量回傳每檔持股的「融資成本 / 追繳價 / 斷頭價 / 距斷頭 %」（給 /portfolio 持股卡 inline 顯示）。
 *
 * 台股 → computeTwMarginPressure（融資增減張數 × 當日VWAP 回推）
 * 陸股 → computeCnMarginPressure（兩融餘額元 ÷ 當日均價 換股數）
 * 其他（基金 .OF、海外）→ null
 *
 * 單檔算失敗只回 null，不炸整批。純顯示層，不進選股 gate（鐵則 #5）。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiValidationError } from '@/lib/api/response';
import { computeTwMarginPressure, type MarginPressure } from '@/lib/chipcost/marginPressure';
import { computeCnMarginPressure } from '@/lib/chipcost/cnMarginPressure';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  symbols: z.string().min(1),
});

/** 陸股走外部 API，避免單檔卡住整批 */
const CN_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { date, symbols } = parsed.data;

  const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);

  const settled = await Promise.allSettled(
    symbolList.map(async (symbol): Promise<MarginPressure | null> => {
      if (/\.(TW|TWO)$/i.test(symbol)) {
        return computeTwMarginPressure(symbol, date);
      }
      if (/\.(SS|SZ|SH)$/i.test(symbol)) {
        return withTimeout(computeCnMarginPressure(symbol), CN_TIMEOUT_MS);
      }
      return null;   // 基金 .OF / 海外：無融資口徑
    }),
  );

  const pressures: Record<string, MarginPressure | null> = {};
  settled.forEach((r, i) => {
    pressures[symbolList[i]] = r.status === 'fulfilled' ? r.value : null;
  });

  return apiOk({ pressures });
}
