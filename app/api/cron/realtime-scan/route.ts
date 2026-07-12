/**
 * GET /api/cron/realtime-scan
 *
 * launchd plist (com.rockstock.realtime-scan) 每 30 秒觸發。
 * 流程：
 *   1. 盤中時段判斷（TW 09:00-13:30 / CN 09:30-15:00），盤外 return skip
 *   2. monitorPool.getActiveSymbols() — holdings + 當日 pool
 *   3. 取 vendor quote (TWSE intraday batch / EastMoney CN batch)
 *   4. pushTick → minuteBarStore（自動 close 跨分鐘 bar）
 *   5. 若 buffer 過淺 → backfillFromVendor 補當日歷史
 *   6. detector(1m) + detector(5m aggregate) → Signal[]
 *   7. dispatch(signals) → ntfy + jsonl log
 */

import { NextRequest } from 'next/server';
import { apiOk } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isMarketOpen } from '@/lib/datasource/marketHours';
import { getActiveSymbols } from '@/lib/realtime/monitorPool';
import {
  pushTick, ensureSymbol, getBars, aggregateBars, backfillFromVendor,
  restoreFromDisk, startFlushLoop,
} from '@/lib/realtime/minuteBarStore';
import { detect } from '@/lib/realtime/blowoffDetector';
import { detectGuardSignals } from '@/lib/realtime/holdingsGuard';
import { dispatch, type AlertSignal } from '@/lib/realtime/alertDispatcher';
import { REALTIME_RULES } from '@/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 60;

// per-symbol 上次 backfill 時間（避免每輪都打 vendor）
const lastBackfillAt: Map<string, number> = new Map();
const BACKFILL_TTL_MS = 30 * 60 * 1000; // 30 分鐘

// 一次性 init flag（首次呼叫時 restore + 開 flush loop）
let initialized = false;
async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const restored = await restoreFromDisk();
    if (restored.symbols.length > 0) {
      console.log(`[realtime-scan] restored ${restored.loaded} bars across ${restored.symbols.length} symbols`);
    }
  } catch (err) {
    console.warn('[realtime-scan] restoreFromDisk failed (continuing):', err);
  }
  startFlushLoop();
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  await ensureInitialized();

  const twOpen = isMarketOpen('TW');
  const cnOpen = isMarketOpen('CN');
  if (!twOpen && !cnOpen) {
    return apiOk({ skipped: true, reason: 'both markets closed' });
  }

  const startMs = Date.now();
  const pool = await getActiveSymbols();
  if (pool.length === 0) {
    return apiOk({ skipped: true, reason: 'empty pool' });
  }

  // 拆 TW/CN
  const twSymbols = pool.filter(p => p.market === 'TW');
  const cnSymbols = pool.filter(p => p.market === 'CN');

  // ── Fetch quotes ──
  const twQuoteMap = twOpen && twSymbols.length > 0
    ? await fetchTWBatch()
    : null;
  const cnQuoteMap = cnOpen && cnSymbols.length > 0
    ? await fetchCNBatch()
    : null;

  // ── pushTick + backfill ──
  let ticksPushed = 0;
  const backfillJobs: Promise<unknown>[] = [];

  for (const item of pool) {
    const isMarketLive = item.market === 'TW' ? twOpen : cnOpen;
    if (!isMarketLive) continue;
    ensureSymbol(item.symbol, item.market);

    // 必要時 backfill
    const lastBf = lastBackfillAt.get(item.symbol) ?? 0;
    const needBackfill = (Date.now() - lastBf) > BACKFILL_TTL_MS
      || getBars(item.symbol).length < REALTIME_RULES.MIN_BARS_FOR_DETECT;
    if (needBackfill) {
      lastBackfillAt.set(item.symbol, Date.now());
      backfillJobs.push(backfillFromVendor(item.symbol, item.market).catch(() => null));
    }

    // pushTick
    if (item.market === 'TW' && twQuoteMap) {
      const code = item.symbol.split('.')[0];
      const q = twQuoteMap.get(code);
      if (q && q.close > 0) {
        pushTick(item.symbol, 'TW', {
          price: q.close,
          // TWSE quote.volume 已是「張」單位
          cumulativeVolume: q.volume,
        });
        ticksPushed++;
      }
    } else if (item.market === 'CN' && cnQuoteMap) {
      const code = item.symbol.split('.')[0];
      const q = cnQuoteMap.get(code);
      if (q && q.close > 0) {
        pushTick(item.symbol, 'CN', {
          price: q.close,
          // EastMoneyRealtime.volume 是「股」 → ÷100 轉「手」與 Sina backfill 對齊
          cumulativeVolume: Math.round(q.volume / 100),
        });
        ticksPushed++;
      }
    }
  }

  // 等 backfill 全跑完（最多 8 秒，避免 cron 卡住）
  if (backfillJobs.length > 0) {
    await Promise.race([
      Promise.allSettled(backfillJobs),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }

  // ── Detect ──
  // 收盤後不對該 market 的 symbol 跑 detector — 否則停滯 bar 會反覆觸發 ma5-breakdown
  // 給持股推 ntfy。整個 cron 只要 TW || CN 任一在盤中就會繼續跑，但 detect 必須按 symbol
  // 所屬 market 個別 gate。
  const allSignals: AlertSignal[] = [];
  let guardSignalCount = 0;
  for (const item of pool) {
    const isMarketLive = item.market === 'TW' ? twOpen : cnOpen;
    if (!isMarketLive) continue;

    const bars1m = getBars(item.symbol);
    const ctx = {
      symbol: item.symbol,
      market: item.market,
      isHolding: item.isHolding,
      source: item.source,
      name: item.name ?? item.holding?.name ?? item.lockTrigger?.name,
    };

    // ── 持倉保命層：純 quote + 1m 視窗，不受 MIN_BARS_FOR_DETECT 限制 ──
    // （重啟後分K殘缺時，跌破停損/拉高回落仍要能工作）
    const code = item.symbol.split('.')[0];
    const q = item.market === 'TW' ? twQuoteMap?.get(code) : cnQuoteMap?.get(code);
    const guardSignals = detectGuardSignals(
      q && q.close > 0
        ? { price: q.close, dayHigh: q.high, prevClose: q.prevClose }
        : null,
      bars1m,
      { ...ctx, holding: item.holding, lockTrigger: item.lockTrigger },
    );
    guardSignalCount += guardSignals.length;
    allSignals.push(...guardSignals);

    if (bars1m.length < REALTIME_RULES.MIN_BARS_FOR_DETECT) continue;

    allSignals.push(...detect(bars1m, ctx, 1));

    // 5m aggregate detector
    const bars5m = aggregateBars(bars1m, 5);
    if (bars5m.length >= REALTIME_RULES.MIN_BARS_FOR_DETECT) {
      allSignals.push(...detect(bars5m, ctx, 5));
    }
  }

  // ── Dispatch ──
  const dispatchResult = await dispatch(allSignals);

  return apiOk({
    elapsedMs: Date.now() - startMs,
    poolSize: pool.length,
    ticksPushed,
    backfilled: backfillJobs.length,
    signalsDetected: allSignals.length,
    guardSignals: guardSignalCount,
    dispatch: dispatchResult,
  });
}

// ── helpers ─────────────────────────────────────────────────────────────

/** 帶 high/prevClose 給 holdingsGuard 規則2（拉高出貨保護）用 */
interface BatchQuote {
  close: number;
  volume: number;
  high?: number;
  prevClose?: number;
}

async function fetchTWBatch(): Promise<Map<string, BatchQuote>> {
  try {
    const { getTWSERealtimeIntraday } = await import('@/lib/datasource/TWSERealtime');
    const map = await getTWSERealtimeIntraday();
    const out = new Map<string, BatchQuote>();
    for (const [code, q] of map) {
      out.set(code, { close: q.close, volume: q.volume, high: q.high, prevClose: q.previousClose });
    }
    return out;
  } catch (err) {
    console.warn('[realtime-scan] fetchTWBatch failed:', err);
    return new Map();
  }
}

async function fetchCNBatch(): Promise<Map<string, BatchQuote>> {
  try {
    const { getEastMoneyRealtime } = await import('@/lib/datasource/EastMoneyRealtime');
    const map = await getEastMoneyRealtime();
    const out = new Map<string, BatchQuote>();
    for (const [code, q] of map) {
      out.set(code, { close: q.close, volume: q.volume, high: q.high, prevClose: q.prevClose });
    }
    return out;
  } catch (err) {
    console.warn('[realtime-scan] fetchCNBatch failed:', err);
    return new Map();
  }
}

