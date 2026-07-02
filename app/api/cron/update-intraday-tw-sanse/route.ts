/**
 * GET /api/cron/update-intraday-tw-sanse
 *
 * 三色資金（台股自創策略）盤中即時掃描。把 TW L2 快照當作「今日未收的那根日K」
 * 合成到封存序列重算三色訊號，寫進獨立的 intraday 快照（不碰盤後 18:35 封存版）。
 *
 * 對齊 update-intraday-cn-sanse（陸股版）：
 *   - 讀 L2 即時快照 → 合成今日進行中日K（盤後是讀純封存日K）
 *   - 寫 tw-sanse-scan-intraday/{date}.json（盤後寫 tw-sanse-scan/{date}.json）
 *   - 用 isMarketOpen/isPostCloseWindow gate（盤後只看 isTradingDay）
 *   - 台股單一指數 ^TWII（無滬深雙基準）
 *
 * ⚠️ 量能半根：盤中那根K棒成交量不完整，主力狀態/雙B/捕撈訊號整天會跳動，
 *    越接近收盤越接近真值 —— 盤中三色當「即時觀察」，收盤前才定調。
 *
 * ?force=1 跳過時段 gate（測試/回補用）。
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';
import type { IntradayBar } from '@/lib/cn-sanse/scan';

export const runtime = 'nodejs';
export const maxDuration = 300;

const INDEX_SYMBOL = '^TWII'; // 加權指數（RS 基準 + 行情日曆）

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const force = req.nextUrl.searchParams.get('force') === '1';

  if (!force && !isMarketOpen('TW') && !isPostCloseWindow('TW')) {
    return apiOk({ skipped: true, reason: 'TW 非開盤時段也非盤後窗口' });
  }

  const date = getCurrentTradingDay('TW');
  if (!force && !isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: `${date} 非交易日`, date });
  }

  const startTime = Date.now();

  try {
    const { readIntradaySnapshot } = await import('@/lib/datasource/IntradayCache');
    const { scanTwSanSe } = await import('@/lib/tw-sanse/scan');
    const { saveTwSanSeIntraday } = await import('@/lib/tw-sanse/scanStorage');

    const snap = await readIntradaySnapshot('TW', date);
    if (!snap || snap.count === 0) {
      return apiOk({ skipped: true, reason: 'L2 快照不存在或為空（等 update-intraday 先刷）', date });
    }
    // 用快照自帶的日期當 single source（避免 L2 落後時 getCurrentTradingDay 與快照日不一致，
    // 把昨日快照貼成今日 bar）。不一致就跳過，等 update-intraday 刷出今日快照。
    if (snap.date !== date) {
      return apiOk({ skipped: true, reason: `L2 快照日 ${snap.date} ≠ 交易日 ${date}（等刷新）`, date, snapDate: snap.date });
    }
    // 退化快照防呆：盤前競價 / 刷新凍結時所有報價塌成扁平根（O=H=L=C、量=0），餵進三色會憑空生假金叉/底反。
    // 偵測到就跳過、不覆蓋上一份好的盤中結果（force 也擋——壞快照算不出有效訊號，強跑無意義）。
    const { degenerateSnapshotReason } = await import('@/lib/datasource/IntradayCache');
    const degenerate = degenerateSnapshotReason(snap);
    if (degenerate) {
      return apiOk({ skipped: true, reason: `L2 快照退化（${degenerate}）— 跳過盤中三色，避免假金叉/底反`, date });
    }

    // 個股報價 → Map<4位代碼, bar>；指數 ^TWII 另外抽出（避免與個股撞 key）
    const quotes = new Map<string, IntradayBar>();
    const indexBars = new Map<string, IntradayBar>();
    for (const q of snap.quotes) {
      const bar = { open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume };
      if (q.symbol === INDEX_SYMBOL) {
        if (q.close > 0) indexBars.set(q.symbol, bar); // 指數不過下面的個股 close<=0 過濾
        continue;
      }
      if (q.close <= 0) continue; // 個股停牌 / 無報價
      quotes.set(q.symbol.split('.')[0], bar);
    }

    if (!indexBars.has(INDEX_SYMBOL)) {
      return apiOk({ skipped: true, reason: `L2 快照缺加權指數 ${INDEX_SYMBOL}（RS 基準無法算）`, date });
    }

    const result = await scanTwSanSe({ intraday: { date: snap.date, quotes, indexBars } });
    await saveTwSanSeIntraday(result);

    return apiOk({
      ok: true,
      date: result.lastDate,
      sessionType: result.sessionType,
      evaluated: result.evaluated,
      staleSkipped: result.staleSkipped,
      counts: result.counts,
      resonanceCounts: result.resonanceCounts,
      l2Count: snap.count,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err) {
    console.error('[update-intraday-tw-sanse] 掃描失敗:', err);
    return apiError(err instanceof Error ? err.message : '三色資金盤中掃描失敗', 500);
  }
}
