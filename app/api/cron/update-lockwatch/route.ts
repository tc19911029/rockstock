/**
 * GET /api/cron/update-lockwatch?market=TW|CN
 *
 * 每日 LockWatch 觀察名單狀態演進（v12 議題 23/49/71/94）
 *
 * 流程：
 *   1. 驗證 CRON_SECRET
 *   2. 取最新 snapshot（昨日 / 前一交易日）
 *   3. 對每筆 active record（observation/entry-signal）：
 *      a. 抓最新 candles
 *      b. checkStructureBroken → 若 broken → markStructureBroken
 *      c. 否則 updateLockWatch（撤銷 / 升級 / 維持）
 *   4. 寫入今日 snapshot（即使無變化也寫，作為 daysObserved 累積快照）
 *
 * 排程建議：每市場盤後一次（TW 18:00 CST、CN 17:00 CST）
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 120;

const INDEX_SYMBOL: Record<'TW' | 'CN', string> = {
  TW: '^TWII',
  CN: '000001.SS',
};

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = req.nextUrl.searchParams.get('market') as 'TW' | 'CN' | null;
  if (!market || !['TW', 'CN'].includes(market)) {
    return apiError('market must be TW or CN', 400);
  }

  const today = getLastTradingDay(market);
  if (!isTradingDay(today, market)) {
    return apiOk({ skipped: true, reason: 'non-trading day', market, today });
  }

  try {
    const {
      loadLockWatchSnapshot,
      saveLockWatchSnapshot,
      listLockWatchDates,
      withLockWatchLock,
    } = await import('@/lib/storage/lockWatchStorage');
    const {
      updateLockWatch,
      migrateNLockWatchDetector,
    } = await import('@/lib/scanner/lockWatchManager');
    const { mergeLockWatchRecord } = await import('@/lib/scanner/lockWatchMerge');
    const { loadLocalCandlesWithTolerance } = await import('@/lib/datasource/LocalCandleStore');

    // 包整段 evolve 在 lockwatch 鎖內 — 避免跟並發 scan-bm appendLockWatchRecords race
    return await withLockWatchLock(market, today, async () => {

    // ── Step 1: 取「昨日 / 前一交易日」的 snapshot 作為演進來源 ─────────
    // 不可用 loadLatestLockWatchSnapshot：scan-bm 在盤中已寫入今日 snapshot
    // （新觸發 records，daysObserved=0），cron 之後若拿到 today 會誤判
    // 「已跑過 idempotent」短路 → 17 天 records 永遠停在 observation。
    const allDates = await listLockWatchDates(market);  // newest first
    const prevDate = allDates.find((d) => d < today) ?? null;
    const prev = prevDate ? await loadLockWatchSnapshot(market, prevDate) : null;

    // 今日的 snapshot 可能已被 scan-bm 寫入（新觸發 records）— 讀進來合併
    const todaySnap = await loadLockWatchSnapshot(market, today);
    const todayNewRecords = todaySnap?.records ?? [];

    if (!prev || prev.records.length === 0) {
      // 沒有歷史 snapshot — 直接以今日新 records 為準（避免空寫覆蓋）
      if (todayNewRecords.length === 0) {
        await saveLockWatchSnapshot({
          market,
          date: today,
          records: [],
          lastUpdated: new Date().toISOString(),
        });
      }
      return apiOk({
        market,
        today,
        prevDate: prev?.date ?? null,
        total: todayNewRecords.length,
        summary: { observation: todayNewRecords.length },
        note: 'no historical snapshot to evolve',
      });
    }

    // ── Step 2: 建立 Scanner 並抓大盤指數 candles ─────────────────────
    const scanner =
      market === 'TW'
        ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
        : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();

    // 盤後 L1 已封存到本機。優先讀本機可避免逐檔打 FinMind/Yahoo，
    // 尤其大量歷史 LockWatch 演進時，外部限流會讓整個 cron 超過 120 秒。
    const fetchEvolutionCandles = async (symbol: string) => {
      const local = await loadLocalCandlesWithTolerance(symbol, market, today, 5).catch(() => null);
      if (local?.candles?.length) return local.candles;
      return scanner.fetchCandles(symbol, today).catch(() => []);
    };

    const indexCandles = await fetchEvolutionCandles(INDEX_SYMBOL[market]);
    if (indexCandles.length === 0) {
      console.warn(`[update-lockwatch] ${market} 指數 ${INDEX_SYMBOL[market]} candles 取得失敗`);
    }

    // ── Step 3: 逐筆更新 ────────────────────────────────────────────
    const summary = {
      observation: 0,
      entrySignal: 0,
      revoked: 0,
      structureBroken: 0,
      purchased: 0,
      manuallyRemoved: 0,
      targetReached: 0,
      changed: 0,
    };
    const newRecords = [];

    for (const r of prev.records) {
      // 跳過已結束的紀錄（保留在 history snapshot 不繼續 update）
      if (
        r.currentStage === 'purchased' ||
        r.currentStage === 'revoked' ||
        r.currentStage === 'manually-removed' ||
        r.currentStage === 'structure-broken' ||
        r.currentStage === 'target-reached'
      ) {
        if (r.currentStage === 'purchased') summary.purchased++;
        else if (r.currentStage === 'revoked') summary.revoked++;
        else if (r.currentStage === 'manually-removed') summary.manuallyRemoved++;
        else if (r.currentStage === 'target-reached') summary.targetReached++;
        else summary.structureBroken++;
        newRecords.push(r);
        continue;
      }

      try {
        const candles = await fetchEvolutionCandles(r.symbol);
        if (!candles || candles.length === 0) {
          newRecords.push(r);
          summary.observation++;
          continue;
        }

        // updateLockWatch 內部順序固定為：舊 detector 重播 → 結構失效 → 達標 → 趨勢撤銷。
        const { changed, record: updated } = updateLockWatch(r, candles, indexCandles, today);
        newRecords.push(updated);
        if (changed) summary.changed++;
        if (updated.currentStage === 'observation') summary.observation++;
        else if (updated.currentStage === 'entry-signal') summary.entrySignal++;
        else if (updated.currentStage === 'revoked') summary.revoked++;
        else if (updated.currentStage === 'structure-broken') summary.structureBroken++;
        else if (updated.currentStage === 'target-reached') summary.targetReached++;
      } catch (err) {
        console.warn(`[update-lockwatch] ${market} ${r.symbol} update 失敗（保留原狀）:`, err);
        newRecords.push(r);
      }
    }

    // ── Step 4: 合併今日新觸發 records（scan-bm 已寫入）──
    // 用 (symbol, triggerSignal) 當 key；evolved 為主，今日新 records 補不衝突的
    const evolvedIndex = new Map(newRecords.map((r, index) => [`${r.symbol}-${r.triggerSignal}`, index]));
    let newToday = 0;
    for (const r of todayNewRecords) {
      let incoming = r;
      if (r.triggerSignal === 'N') {
        const candles = await fetchEvolutionCandles(r.symbol);
        if (candles.length > 0) {
          const migrated = migrateNLockWatchDetector(r, candles, today);
          incoming = migrated.record;
          if (migrated.changed) summary.changed++;
        }
      }
      const key = `${incoming.symbol}-${incoming.triggerSignal}`;
      const existingIndex = evolvedIndex.get(key);
      if (existingIndex == null) {
        newRecords.push(incoming);
        evolvedIndex.set(key, newRecords.length - 1);
        newToday++;
        summary.observation++;
      } else {
        const before = newRecords[existingIndex];
        const merged = mergeLockWatchRecord(before, incoming);
        newRecords[existingIndex] = merged;
        if (merged.triggeredDate > before.triggeredDate) newToday++;
      }
    }

    // 合併時可能由「昨日已結束」切成「今日重新觸發」，最後再依實際 records 重算分桶。
    summary.observation = 0;
    summary.entrySignal = 0;
    summary.revoked = 0;
    summary.structureBroken = 0;
    summary.purchased = 0;
    summary.manuallyRemoved = 0;
    summary.targetReached = 0;
    for (const record of newRecords) {
      if (record.currentStage === 'observation' || record.currentStage === 'pending-breakout') summary.observation++;
      else if (record.currentStage === 'entry-signal') summary.entrySignal++;
      else if (record.currentStage === 'revoked') summary.revoked++;
      else if (record.currentStage === 'structure-broken') summary.structureBroken++;
      else if (record.currentStage === 'purchased') summary.purchased++;
      else if (record.currentStage === 'manually-removed') summary.manuallyRemoved++;
      else if (record.currentStage === 'target-reached') summary.targetReached++;
    }

    // ── Step 5: 寫入今日 snapshot ──────────────────────────────────
    await saveLockWatchSnapshot({
      market,
      date: today,
      records: newRecords,
      lastUpdated: new Date().toISOString(),
    });

    console.info(
      `[update-lockwatch] ✅ ${market} ${today} prev=${prev.date} evolved=${newRecords.length - newToday} todayNew=${newToday} changed=${summary.changed}`,
    );

    return apiOk({
      market,
      today,
      newTodayMerged: newToday,
      prevDate: prev.date,
      total: newRecords.length,
      summary,
    });
    });  // close withLockWatchLock
  } catch (err) {
    console.error(`[update-lockwatch] ${market} 失敗:`, err);
    return apiError(`update-lockwatch failed: ${String(err)}`);
  }
}
