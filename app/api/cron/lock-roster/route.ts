/**
 * GET /api/cron/lock-roster?market=TW|CN&date=YYYY-MM-DD
 *
 * 鎖股名單（獵兔計劃）每日演進（批次D 2026-07-05，課程 CH5-6）：
 *   1. 讀昨日 roster + 當日 post_close 掃描結果（L4）
 *   2. 舊名單逐檔重分類（在等什麼）+ 課程 8 種轉弱汰弱
 *   3. 掃描結果補位到 10~15 檔，按緊迫度排序（三角收斂尾端最前）
 *   4. 寫 roster.json + reviews/{date}.json
 *
 * 排程：launchd com.rockstock.lock-roster 19:05 CST 平日（post_close 掃描後）。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import type { CandleWithIndicators } from '@/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** 掃描結果最多取前 N 檔當候選（roster 只有 15 位，60 檔候選綽綽有餘） */
const MAX_CANDIDATES = 60;

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW' | 'CN';
  if (!['TW', 'CN'].includes(market)) return apiError('market must be TW or CN', 400);
  const date = req.nextUrl.searchParams.get('date') ?? getLastTradingDay(market);
  if (!isTradingDay(date, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', market, date });
  }

  try {
    const { loadScanSession } = await import('@/lib/storage/scanStorage');
    const { loadLockRoster, saveLockRoster, saveRosterReview } = await import('@/lib/storage/lockRosterStorage');
    const { evolveRoster } = await import('@/lib/scanner/lockRoster');

    const prev = await loadLockRoster(market);
    const session = await loadScanSession(market, date, 'long', 'daily');
    const results = session?.results ?? [];

    // 候選排序：六條件分數優先，成交額名次次之（掃描本身已過六條件+戒律+淘汰）
    const candidates = [...results]
      .sort((a, b) => (b.sixConditionsScore - a.sixConditionsScore)
        || ((a.turnoverRank ?? 999) - (b.turnoverRank ?? 999)))
      .slice(0, MAX_CANDIDATES)
      .map(r => ({ symbol: r.symbol, name: r.name, matchedLetters: r.matchedMethods }));

    // 需要 K 線的 symbol：舊名單 ∪ 候選（去重）
    const symbols = new Set<string>([
      ...(prev?.entries ?? []).map(e => e.symbol),
      ...candidates.map(c => c.symbol),
    ]);

    const scanner = market === 'TW'
      ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
      : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();

    const candleMap = new Map<string, CandleWithIndicators[]>();
    for (const s of symbols) {
      try {
        const cs = await scanner.fetchCandles(s, date);
        if (cs && cs.length >= 30) candleMap.set(s, cs);
      } catch { /* 缺K線 → 該檔沿用原狀/跳過候選 */ }
    }

    const { roster, review } = evolveRoster({
      market, date, prev, candidates,
      candlesOf: (s) => candleMap.get(s) ?? null,
    });

    await saveLockRoster(roster);
    await saveRosterReview(review);

    console.info(
      `[lock-roster] ✅ ${market} ${date} entries=${roster.entries.length} ` +
      `kept=${review.kept} added=${review.added.length} removed=${review.removed.length}`,
    );
    return apiOk({
      market, date,
      total: roster.entries.length,
      kept: review.kept,
      added: review.added,
      removed: review.removed,
      flagged: review.flagged.length,
      top3: roster.entries.slice(0, 3).map(e => `${e.symbol} ${e.label}(${e.urgency.toFixed(0)})`),
    });
  } catch (err) {
    console.error(`[lock-roster] ${market} 失敗:`, err);
    return apiError(`lock-roster failed: ${String(err)}`);
  }
}
