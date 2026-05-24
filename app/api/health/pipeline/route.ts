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

  // ── 內部 API 自我檢測（防止 dev server 5xx 但 cron 仍 silent fail）──
  // 2026-05-24 發現 port 3000 dev-server 早就在 /api/stock 噴 500，沒人發現直到 bundle
  // 全 fail。這個 self-ping 至少讓 /health 頁面紅燈。
  const SELF_PING_TARGETS = [
    { name: 'internal /api/stock', url: 'http://localhost:3000/api/stock?symbol=2330&interval=1d&period=1mo' },
    { name: 'internal /api/youtube/audit', url: 'http://localhost:3000/api/youtube/audit' },
  ];
  await Promise.all(SELF_PING_TARGETS.map(async t => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(t.url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        checks.push({ name: t.name, status: 'ok', detail: `HTTP ${r.status}` });
      } else {
        checks.push({ name: t.name, status: 'fail', detail: `HTTP ${r.status}` });
      }
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message.slice(0, 80);
      checks.push({ name: t.name, status: 'fail', detail: msg });
    }
  }));

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
