/**
 * GET /api/cron/realtime-scan
 *
 * 本機 scheduler 每 10 秒觸發（single-flight 防重疊）。
 * 流程：
 *   1. 盤中時段判斷（TW 09:00-13:30 / CN 09:30-15:00），盤外 return skip
 *   2. monitorPool.getActiveSymbols() — holdings + 當日 pool
 *   3. 取目標池 quote (TW MIS / Tencent + Sina + L2 failover)
 *   4. 若 buffer 過淺或斷檔 → backfillFromVendor 補當日歷史
 *   5. pushTick → minuteBarStore（自動 close 跨分鐘 bar）
 *   6. detector 預篩；TW 候選以 Fugle 精準分鐘 K 二次確認
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
import { detect, type DetectorContext, type Signal } from '@/lib/realtime/blowoffDetector';
import { detectGuardSignals } from '@/lib/realtime/holdingsGuard';
import { dispatch, type AlertSignal } from '@/lib/realtime/alertDispatcher';
import { REALTIME_RULES } from '@/lib/config';
import { fetchCNRealtimeQuoteBatch } from '@/lib/realtime/CNRealtimeQuoteSource';
import { fetchTWRealtimeQuoteBatch } from '@/lib/realtime/TWRealtimeQuoteSource';
import { verifyTWPatternCandidates } from '@/lib/realtime/TWPatternVerifier';

export const runtime = 'nodejs';
export const maxDuration = 60;

// per-symbol 上次 backfill 時間（避免每輪都打 vendor）
const lastBackfillAt: Map<string, number> = new Map();
const BACKFILL_RETRY_MS = 5 * 60 * 1000;
const BAR_GAP_BACKFILL_MS = 150 * 1000;

// 一次性 init flag（首次呼叫時 restore + 開 flush loop）
let initialized = false;
let scanInFlight = false;
let scanStartedAt = 0;
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

  // 外部 scheduler 或人工呼叫可能重疊。single-flight 避免慢輪持續疊加連線。
  if (scanInFlight) {
    return apiOk({
      skipped: true,
      reason: 'previous realtime scan still running',
      runningForMs: Date.now() - scanStartedAt,
    });
  }
  scanInFlight = true;
  scanStartedAt = Date.now();

  try {
    return await executeRealtimeScan(twOpen, cnOpen);
  } finally {
    scanInFlight = false;
    scanStartedAt = 0;
  }
}

async function executeRealtimeScan(twOpen: boolean, cnOpen: boolean) {
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
    ? await fetchTWBatch(twSymbols.map(item => item.symbol))
    : null;
  const cnQuoteMap = cnOpen && cnSymbols.length > 0
    ? await fetchCNBatch(cnSymbols.map(item => item.symbol))
    : null;

  // ── backfill ──
  // 先補歷史再 push 累積量；冷啟動時可避免把「截至目前的整日量」誤當單分鐘量。
  const backfillJobs: Promise<unknown>[] = [];
  for (const item of pool) {
    const isMarketLive = item.market === 'TW' ? twOpen : cnOpen;
    if (!isMarketLive) continue;
    ensureSymbol(item.symbol, item.market);
    const bars = getBars(item.symbol);
    const lastBf = lastBackfillAt.get(item.symbol) ?? 0;
    const newestTs = bars[bars.length - 1]?.ts ?? 0;
    const shallow = bars.length < REALTIME_RULES.MIN_BARS_FOR_DETECT;
    const hasGap = newestTs > 0 && Date.now() - newestTs > BAR_GAP_BACKFILL_MS;
    const needBackfill = lastBf === 0
      || ((shallow || hasGap) && Date.now() - lastBf >= BACKFILL_RETRY_MS);
    if (needBackfill) {
      lastBackfillAt.set(item.symbol, Date.now());
      backfillJobs.push(backfillFromVendor(item.symbol, item.market).catch(() => null));
    }
  }

  if (backfillJobs.length > 0) {
    await Promise.race([
      Promise.allSettled(backfillJobs),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]);
  }

  // ── pushTick ──
  let ticksPushed = 0;
  for (const item of pool) {
    const isMarketLive = item.market === 'TW' ? twOpen : cnOpen;
    if (!isMarketLive) continue;
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

  // ── Detect ──
  // 收盤後不對該 market 的 symbol 跑 detector — 否則停滯 bar 會反覆觸發 ma5-breakdown
  // 給持股推 ntfy。整個 cron 只要 TW || CN 任一在盤中就會繼續跑，但 detect 必須按 symbol
  // 所屬 market 個別 gate。
  const allSignals: AlertSignal[] = [];
  const twPatternCandidates = new Map<string, { candidates: Signal[]; ctx: DetectorContext }>();
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

    const signals1m = detect(bars1m, ctx, 1, { dedupe: item.market !== 'TW' });
    if (item.market === 'TW') {
      twPatternCandidates.set(item.symbol, { candidates: signals1m, ctx });
    } else {
      allSignals.push(...signals1m);
    }

    // 5m aggregate detector
    const bars5m = aggregateBars(bars1m, 5);
    if (bars5m.length >= REALTIME_RULES.MIN_BARS_FOR_DETECT) {
      const signals5m = detect(bars5m, ctx, 5, { dedupe: item.market !== 'TW' });
      if (item.market === 'TW') {
        const entry = twPatternCandidates.get(item.symbol) ?? { candidates: [], ctx };
        entry.candidates.push(...signals5m);
        twPatternCandidates.set(item.symbol, entry);
      } else {
        allSignals.push(...signals5m);
      }
    }
  }

  // MIS 的 sampled OHLC 只做免費快速預篩；候選才消耗一次 Fugle REST，以精準 1m K
  // 重算同一規則。這同時避開免費方案 5 檔 WebSocket 上限與 60 req/min REST 上限。
  const verificationStats = { candidates: 0, verified: 0, rejected: 0, unavailable: 0, stale: 0 };
  const verificationJobs = [...twPatternCandidates.values()]
    .filter(entry => entry.candidates.length > 0)
    .map(async entry => {
      verificationStats.candidates += entry.candidates.length;
      const result = await verifyTWPatternCandidates(entry.candidates, entry.ctx);
      verificationStats[result.status] += result.status === 'verified' ? result.signals.length : 1;
      return result.signals;
    });
  if (verificationJobs.length > 0) {
    const verifiedGroups = await Promise.all(verificationJobs);
    for (const signals of verifiedGroups) allSignals.push(...signals);
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
    twPatternVerification: verificationStats,
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

let lastTWQuoteSource = '';
async function fetchTWBatch(symbols: string[]): Promise<Map<string, BatchQuote>> {
  const result = await fetchTWRealtimeQuoteBatch(symbols);
  if (result.source !== lastTWQuoteSource) {
    console.info(`[realtime-scan] TW quote source=${result.source} count=${result.quotes.size}`);
    lastTWQuoteSource = result.source;
  }
  return result.quotes;
}

let lastCNQuoteSource = '';
async function fetchCNBatch(symbols: string[]): Promise<Map<string, BatchQuote>> {
  const result = await fetchCNRealtimeQuoteBatch(symbols);
  if (result.source !== lastCNQuoteSource) {
    console.info(`[realtime-scan] CN quote source=${result.source} count=${result.quotes.size}`);
    lastCNQuoteSource = result.source;
  }
  return result.quotes;
}
