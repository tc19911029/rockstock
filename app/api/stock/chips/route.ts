/**
 * GET /api/stock/chips?symbol=2330.TW&days=120
 *
 * 走圖籌碼面 API（lazy fetch + L1 cache）
 *
 * 流程：
 *   1. 讀 L1 per-stock 檔
 *   2. 若 L1 落後或不存在，去 FinMind 抓一次（180 天區間）
 *   3. 寫回 L1，回傳最近 N 天時序
 *
 * 只支援 TW；CN 沒有對應免費 API。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import { loadChipSeries, readInstStock, writeInstStock } from '@/lib/chips/ChipStorage';
import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';

const schema = z.object({
  symbol: z.string().min(1),
  days: z.coerce.number().int().min(10).max(500).optional().default(120),
});

/** 回退 N 個自然日的日期字串 */
function dateMinusDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const parsed = schema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { symbol, days } = parsed.data;

  // 只支援 TW
  const isTW = /^\d+(\.(TW|TWO))?$/i.test(symbol);
  if (!isTW) return apiOk({ symbol, inst: [], tdcc: [], note: '僅 TW 支援籌碼資料' });

  const code = symbol.replace(/\.(TW|TWO)$/i, '');
  const targetDate = getLastTradingDay('TW'); // 最近交易日

  try {
    // ── Step 1: 讀 L1 ──
    const existing = await readInstStock(code);
    const needsRefresh = !existing || existing.lastDate < targetDate;

    // ── Step 2: 若需要，從 FinMind 補抓 ──
    if (needsRefresh) {
      // 抓區間：existing.lastDate+1 → today，或第一次抓 180 天
      const fetchStart = existing?.lastDate
        ? dateMinusDays(existing.lastDate, -1) // 已有資料：抓最後一日 +1 起
        : dateMinusDays(targetDate, 200);      // 第一次：抓 200 天
      try {
        const fetched = await fetchT86ForStock(code, fetchStart, targetDate);
        if (fetched.size > 0) {
          const newRows = Array.from(fetched.entries()).map(([date, v]) => ({ date, ...v }));
          await writeInstStock(code, newRows);
        }
      } catch (err) {
        // FinMind 失敗時，退而求其次回傳 L1（如果有）
        console.warn(`[chips] FinMind 抓取失敗 ${code}:`, err instanceof Error ? err.message : err);
        if (!existing) {
          return apiError(`籌碼資料抓取失敗：${err instanceof Error ? err.message : '未知錯誤'}`);
        }
      }
    }

    // ── Step 3: 從 L1 讀取最近 N 天回傳 ──
    const series = await loadChipSeries(code, days);
    return apiOk(series);
  } catch (err) {
    console.error('[chips] error:', err);
    return apiError('籌碼資料讀取失敗');
  }
}
