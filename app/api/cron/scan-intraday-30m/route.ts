/**
 * GET /api/cron/scan-intraday-30m?market=TW&force=1
 *
 * 六條件(30分K)選股 — **用開盤第一根 30分K(09:30 收)當每天的選股時點**。
 *
 * 為什麼是開盤那根：實測收盤前 30分K 幾乎不動(最大漲幅~3%、多數~0.5%)，六條件⑤
 * 「紅K實體≥2%」是日K尺度，收盤根幾乎永遠 0 檔；攻擊訊號集中在開盤(09:30 那根動能最大)。
 *
 * 資料流(不逐檔抓 30分K，靠自建 30分K快照層)：
 *   1. 讀全市場 L2 快照(一次讀完，便宜)
 *   2. appendIntraday30mBar：把「開盤 30分K」堆進 30分K宇宙(近似；同邊界重觸發 idempotent)
 *   3. 讀 30分K宇宙(暖機歷史 + 今日開盤根) → scanSixConditions30m(ZHU_PURE_BOOK，原封不動)
 *   4. 09:30 那輪寫 post_close(當天正式名單 + 觸發 prune)
 *
 * 只做台股(六條件是朱家泓台股方法；陸股/停利不在此功能)。
 * 暖機需先跑 scripts/backfill-30m-warmup.ts；盤後由 refresh-30m-eod 用 Fugle 準確版覆蓋。
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isMarketOpen, isPostCloseWindow, getCurrentTradingDay } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** 現在對應「已收盤」的 30分K 結束標籤(floor 到 :00/:30，界內 09:30–13:30) */
function currentBoundaryLabel(): string | null {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const [h, m] = hm.split(':').map(Number);
  const label = `${String(h).padStart(2, '0')}:${m >= 30 ? '30' : '00'}`;
  if (label < '09:30') return null;      // 開盤第一根還沒收
  return label > '13:30' ? '13:30' : label; // 收盤後 → 最終 13:30
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as 'TW';
  const force = req.nextUrl.searchParams.get('force') === '1';
  if (market !== 'TW') return apiOk({ skipped: true, reason: '六條件(30分K)目前只做台股', market });

  if (!force && !isMarketOpen('TW') && !isPostCloseWindow('TW')) {
    return apiOk({ skipped: true, reason: 'TW 非開盤時段也非盤後窗口', market });
  }
  const date = getCurrentTradingDay('TW');
  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: `${date} 非交易日`, market, date });
  }

  const startTime = Date.now();
  try {
    const { readIntradaySnapshot, degenerateSnapshotReason } = await import('@/lib/datasource/IntradayCache');
    const { read30mUniverse, appendIntraday30mBar } = await import('@/lib/candles30m/Candle30mStore');
    const { scanSixConditions30m } = await import('@/lib/candles30m/sixConditions30mScan');
    const { saveScanSession } = await import('@/lib/storage/scanStorage');

    // ── 1+2. 盤中堆疊(有新鮮且非退化的 L2 才 append)─────────────────────
    const boundary = force && !currentBoundaryLabel() ? '09:30' : currentBoundaryLabel();
    let appended = 0;
    let l2Count = 0;
    const snap = await readIntradaySnapshot('TW', date);
    if (snap && snap.count > 0 && boundary) {
      l2Count = snap.count;
      const degen = degenerateSnapshotReason(snap);
      if (degen) {
        console.warn(`[scan-intraday-30m] L2 退化，跳過堆疊：${degen}`);
      } else {
        const r = await appendIntraday30mBar(date, boundary, snap.quotes);
        appended = r.appended;
      }
    }

    // ── 3. 讀宇宙 → 掃六條件 ────────────────────────────────────────────
    const universe = await read30mUniverse();
    if (!universe || Object.keys(universe.data).length === 0) {
      return apiOk({ skipped: true, reason: '30分K宇宙為空(先跑 backfill-30m-warmup)', market, date, appended });
    }

    // metaMap：名稱/產業/成交額名次
    const metaMap = new Map<string, { name?: string; industry?: string; turnoverRank?: number }>();
    try {
      const { TaiwanScanner } = await import('@/lib/scanner/TaiwanScanner');
      const { readTurnoverRank } = await import('@/lib/scanner/TurnoverRank');
      const scanner = new TaiwanScanner();
      const [stockList, rank] = await Promise.all([scanner.getStockList(), readTurnoverRank('TW').catch(() => null)]);
      const byCode = new Map(stockList.map(s => [s.symbol.replace(/\.(TW|TWO)$/i, ''), s]));
      for (const symKey of Object.keys(universe.data)) {
        const code = symKey.replace(/\.(TW|TWO)$/i, '');
        const entry = byCode.get(code);
        const turnoverRank = rank?.ranks?.get(symKey) ?? rank?.ranks?.get(code);
        metaMap.set(symKey, { name: entry?.name, industry: entry?.industry, turnoverRank });
      }
    } catch { /* 名稱缺失不致命，掃描照跑 */ }

    const scanTime = new Date().toISOString();
    const { results, stats } = scanSixConditions30m(universe.data, metaMap, scanTime);

    // ── 4. 寫 intraday session(mtfMode=daily30)────────────────────────
    const baseSession = {
      market: 'TW' as const,
      date,
      direction: 'long' as const,
      timeframe: '30m' as const,
      schemaVersion: 'v12' as const,
      scanTime,
      resultCount: results.length,
      results,
      step1Filter: 'bypassed' as const,
    };
    await saveScanSession({
      ...baseSession,
      id: `TW-long-daily30-${date}-intraday-${Date.now()}`,
      sessionType: 'intraday' as const,
    });

    // 開盤 09:30 那輪 = 當天正式名單：寫 post_close(觸發 prune + 穩定結果)
    const isOpening = boundary === '09:30';
    if (isOpening) {
      await saveScanSession({
        ...baseSession,
        id: `TW-long-daily30-${date}-postclose`,
        sessionType: 'post_close' as const,
      }, { allowOverwritePostClose: true });
    }

    return apiOk({
      market, date,
      boundary,
      l2Count,
      appended,
      universe: stats.universe,
      evaluated: stats.evaluated,
      tooFew: stats.tooFew,
      passed: stats.passed,
      isOpening,
      elapsedMs: Date.now() - startTime,
    });
  } catch (err) {
    console.error('[scan-intraday-30m] 掃描失敗:', err);
    return apiError(`scan-intraday-30m failed: ${String(err)}`);
  }
}
