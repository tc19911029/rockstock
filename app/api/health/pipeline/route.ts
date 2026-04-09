// GET /api/health/pipeline — 資料管線健康檢查
//
// 檢查 Layer 1-4 各層狀態，回傳 healthy/degraded/unhealthy

import { apiOk } from '@/lib/api/response';
import { readIntradaySnapshot, isSnapshotFresh, readMABase } from '@/lib/datasource/IntradayCache';
import { isMarketOpen, getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const maxDuration = 15;

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function GET() {
  const checks: Check[] = [];
  const now = new Date();

  for (const market of ['TW', 'CN'] as const) {
    const lastDay = getLastTradingDay(market);
    const marketOpen = isMarketOpen(market);
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);

    // ── Layer 2: 盤中快照 ──
    const targetDate = marketOpen ? today : lastDay;
    const snapshot = await readIntradaySnapshot(market, targetDate);

    if (marketOpen) {
      if (!snapshot) {
        checks.push({ name: `${market} 盤中快照`, status: 'fail', detail: '不存在' });
      } else if (!isSnapshotFresh(snapshot, 5 * 60 * 1000)) {
        const ageSec = Math.round((Date.now() - new Date(snapshot.updatedAt).getTime()) / 1000);
        checks.push({ name: `${market} 盤中快照`, status: 'warn', detail: `已過期 (${ageSec}s ago, ${snapshot.count} 檔)` });
      } else {
        checks.push({ name: `${market} 盤中快照`, status: 'ok', detail: `${snapshot.count} 檔 @ ${snapshot.updatedAt}` });
      }
    } else {
      // 盤後：快照可選
      if (snapshot) {
        checks.push({ name: `${market} 盤中快照`, status: 'ok', detail: `盤後存檔: ${snapshot.count} 檔` });
      } else {
        checks.push({ name: `${market} 盤中快照`, status: 'ok', detail: '盤後無快照（正常）' });
      }
    }

    // ── MA Base ──
    const maBase = await readMABase(market, lastDay);
    if (maBase) {
      const entryCount = Object.keys(maBase.data).length;
      checks.push({ name: `${market} MA Base`, status: 'ok', detail: `${entryCount} entries @ ${maBase.date}` });
    } else {
      checks.push({ name: `${market} MA Base`, status: 'warn', detail: `${lastDay} 無 MA Base（粗掃 MA 過濾不可用）` });
    }
  }

  // ── 綜合狀態 ──
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  const status = hasFail ? 'unhealthy' : hasWarn ? 'degraded' : 'healthy';

  return apiOk({
    status,
    timestamp: now.toISOString(),
    checks,
  });
}
