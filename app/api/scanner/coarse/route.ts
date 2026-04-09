/**
 * POST /api/scanner/coarse — 第一級全市場粗掃
 *
 * 使用 Layer 2 盤中快照（單一檔案）進行快速篩選，
 * 不讀逐檔 Blob candle files。
 *
 * 效能目標: < 3 秒（含手機網路環境）
 *
 * 回傳候選清單，前端再用 /api/scanner/chunk 進行精掃。
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  readIntradaySnapshot,
  refreshIntradaySnapshot,
  isSnapshotFresh,
  readMABase,
} from '@/lib/datasource/IntradayCache';
import { coarseScan } from '@/lib/scanner/CoarseScanner';
import { isMarketOpen, getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 30; // 粗掃應 < 10 秒

const schema = z.object({
  market: z.enum(['TW', 'CN']),
  direction: z.enum(['long', 'short']).default('long'),
  /** 快照最大允許年齡（秒），超過就自動刷新。預設 180 (3 分鐘) */
  maxSnapshotAgeSec: z.number().optional().default(180),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiValidationError(parsed.error);
  }

  const { market, direction, maxSnapshotAgeSec } = parsed.data;

  try {
    // ── 判斷目標日期 ──
    const marketOpen = isMarketOpen(market);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai',
    }).format(new Date());

    // 盤中用今天，盤後用上一個交易日
    const targetDate = marketOpen ? today : getLastTradingDay(market);

    // ── 讀取或刷新盤中快照 ──
    let snapshot = await readIntradaySnapshot(market, targetDate);

    if (!isSnapshotFresh(snapshot, maxSnapshotAgeSec * 1000)) {
      // 快照太舊或不存在，重新抓取
      // 只在盤中才刷新（盤後用已存的快照）
      if (marketOpen) {
        snapshot = await refreshIntradaySnapshot(market);
      } else if (!snapshot) {
        // 盤後且無快照：嘗試用收盤資料生成
        // 先嘗試讀取，如果沒有就直接回傳空
        return apiError(`${market} 尚無盤中快照，請等待盤中更新`, 404);
      }
    }

    if (!snapshot || snapshot.count === 0) {
      return apiError(`${market} 盤中快照為空`, 404);
    }

    // ── 讀取 MA Base（歷史尾端快取）──
    // 嘗試當天和前一天的 MA Base
    let maBase = await readMABase(market, targetDate);
    if (!maBase) {
      // 嘗試前一個交易日
      const prevDate = getLastTradingDay(market);
      if (prevDate !== targetDate) {
        maBase = await readMABase(market, prevDate);
      }
    }
    // MA Base 可能不存在（第一次使用），粗掃仍可進行（只是沒有 MA 過濾）

    // ── 執行粗掃 ──
    const result = coarseScan(snapshot, maBase, { direction });

    return apiOk({
      ...result,
      maBaseAvailable: !!maBase,
      snapshotDate: snapshot.date,
      snapshotUpdatedAt: snapshot.updatedAt,
    });
  } catch (err) {
    console.error('[scanner/coarse] error:', err);
    return apiError('粗掃服務暫時無法使用');
  }
}
