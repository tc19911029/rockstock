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
    const { getActiveStrategyServer } = await import('@/lib/strategy/activeStrategyServer');
    const { loadLockRoster, saveLockRoster, saveRosterReview } = await import('@/lib/storage/lockRosterStorage');
    const { evolveRoster } = await import('@/lib/scanner/lockRoster');

    const strategy = await getActiveStrategyServer();
    const storedPrev = await loadLockRoster(market);
    const storedStrategyId = storedPrev?.strategyId ?? 'zhu-pure-book';
    // 切換策略時不能沿用舊策略的自動候選；手動鎖股是使用者意圖，保留。
    const prev = storedPrev && storedStrategyId !== strategy.id
      ? { ...storedPrev, strategyId: strategy.id, entries: storedPrev.entries.filter(e => e.source === 'manual') }
      : storedPrev;
    const session = await loadScanSession(market, date, 'long', 'daily', strategy.id);
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
    roster.strategyId = strategy.id;
    review.strategyId = strategy.id;

    // ── 避雷紅旗（北極星＝賺多賠少）：Tier1 處置/注意股一定套；Tier2 籌碼避雷讀本地快取 best-effort ──
    if (market === 'TW') {
      try {
        const { annotateAvoidance } = await import('@/lib/scanner/lockRoster');
        const { getActiveDisposalSet, getRecentNoticeSet, bareCode } = await import('@/lib/market/attentionList');
        const { computeChipAvoidSignals } = await import('@/lib/avoidance/chipAvoidSignals');
        const { readInstStock } = await import('@/lib/chips/ChipStorage');
        const { readBrokerStock } = await import('@/lib/chips/BrokerStorage');
        const [disposalSet, noticeSet] = await Promise.all([
          getActiveDisposalSet(date).catch(() => new Set<string>()),
          getRecentNoticeSet(date, 5).catch(() => new Set<string>()),
        ]);
        roster.entries = await Promise.all(roster.entries.map(async (e) => {
          const bare = bareCode(e.symbol);
          const disposal = disposalSet.has(bare);
          const notice = noticeSet.has(bare);
          let chipFlags: string[] = [];
          const cs = candleMap.get(e.symbol);
          if (cs && cs.length >= 21) {
            try {
              const code = e.symbol.replace(/\.(TW|TWO)$/i, '');
              const [inst, broker] = await Promise.all([readInstStock(code), readBrokerStock(code)]);
              const instByDate = new Map((inst?.data ?? []).map(d => [d.date, d.total]));
              const brokerByDate = new Map((broker?.data ?? []).map(d => [d.date, d.netDifference]));
              if (instByDate.size > 0 || brokerByDate.size > 0) {
                const { flags } = computeChipAvoidSignals({
                  price: cs[cs.length - 1].close,
                  candles: cs.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
                  holderRows: [], brokerByDate, instByDate,
                });
                chipFlags = flags.map(f => f.label);
              }
            } catch { /* 本地無籌碼快取 → 略過 Tier2（誠實部分覆蓋） */ }
          }
          return annotateAvoidance(e, { disposal, notice, chipFlags });
        }));
        // avoid 級往下沉（不推薦陷阱當「明天最可能發動」），同級維持 urgency 排序
        roster.entries.sort((a, b) =>
          (a.avoidLevel === 'avoid' ? 1 : 0) - (b.avoidLevel === 'avoid' ? 1 : 0) || b.urgency - a.urgency);
      } catch (e) {
        console.warn('[lock-roster] 避雷紅旗標註略過:', e);
      }
    }

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
