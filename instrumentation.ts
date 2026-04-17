// instrumentation.ts — Next.js server startup hook
// 本地開發時定期呼叫 API route 模擬 Vercel Cron。
//
// 設計原則（鐵律 4：Edge-safe 模組邊界）：
//   本檔只做「時間判斷 + fetch 呼叫」，**不 import 任何含 fs/path 的模組**。
//   實際做事交給宣告 runtime='nodejs' 的 API route。
//   這樣 Edge bundler 才不會在 HMR 後把 fs 依賴拉進來炸掉（歷史傷疤：DabanScanner 2026-04-17）。

import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { isTradingDay } from '@/lib/utils/tradingDay';

function localUrl(path: string): string {
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}${path}`;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.CRON_SECRET) h['authorization'] = `Bearer ${process.env.CRON_SECRET}`;
  return h;
}

async function callRoute(path: string, label: string): Promise<unknown> {
  try {
    const res = await fetch(localUrl(path), { headers: authHeaders() });
    if (!res.ok) {
      console.error(`[local-cron] ${label} HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[local-cron] ${label} fetch failed:`, err);
    return null;
  }
}

export async function register() {
  // 只在本地開發啟動定時器（Vercel 有自己的 cron）
  if (process.env.VERCEL || process.env.NODE_ENV === 'test') return;

  console.log('[local-cron] 本地開發模式：定期呼叫 API route 模擬 Vercel Cron');
  console.log('[local-cron] 刷新+掃描：TW / CN 每 5 分鐘；打板開盤確認：9:25–9:35 CST；L1 下載：盤後一次');

  // ── 盤中：L2 刷新 + L4 掃描（走 update-intraday route） ──
  async function refreshAndScan(market: 'TW' | 'CN') {
    if (!isMarketOpen(market) && !isPostCloseWindow(market)) return;
    const data = await callRoute(`/api/cron/update-intraday?market=${market}`, `${market} update-intraday`);
    if (data && typeof data === 'object') {
      const payload = ('data' in (data as object) ? (data as { data: unknown }).data : data) as {
        snapshot?: { count?: number; updatedAt?: string };
        scanCount?: number;
        skipped?: boolean;
        reason?: string;
      };
      if (payload?.skipped) {
        console.log(`[local-cron] ${market} update-intraday 跳過：${payload.reason}`);
      } else {
        const count = payload?.snapshot?.count ?? -1;
        const scanCount = payload?.scanCount ?? -1;
        console.log(`[local-cron] ${market} L2 刷新 ${count} 支；L4 掃描 ${scanCount} 檔`);
      }
    }
  }

  // ── 盤後：L1 下載（走 download-candles route） ──
  const l1Downloaded = { TW: '', CN: '' };
  async function downloadL1(market: 'TW' | 'CN') {
    const tz = market === 'TW' ? 'Asia/Taipei' : 'Asia/Shanghai';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

    if (l1Downloaded[market] === today) return;
    if (!isTradingDay(today, market)) return;
    if (!isPostCloseWindow(market)) return;

    l1Downloaded[market] = today; // 先標記，防重複執行
    console.log(`[local-cron] ${market} 觸發 download-candles...`);
    await callRoute(`/api/cron/download-candles?market=${market}`, `${market} download-candles`);
  }

  // ── 打板開盤確認（CN 9:25–9:35 CST，每日一次） ──
  const dabanConfirmed = { date: '' };
  async function maybeConfirmDabanOpen() {
    const nowCN = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const hhmm = nowCN.getHours() * 100 + nowCN.getMinutes();

    if (hhmm < 925 || hhmm > 935) return;
    if (dabanConfirmed.date === todayCN) return;
    if (!isTradingDay(todayCN, 'CN')) return;

    dabanConfirmed.date = todayCN;
    console.log('[local-cron] CN 打板開盤確認啟動...');
    const json = await callRoute('/api/cron/confirm-daban-open', 'CN confirm-daban-open') as
      { data?: { confirmed?: number; total?: number; resultCount?: number } } | null;
    const data = json?.data ?? json ?? {};
    const confirmed = (data as { confirmed?: number }).confirmed ?? 0;
    const total = (data as { resultCount?: number; total?: number }).resultCount ?? (data as { total?: number }).total ?? 0;
    console.log(`[local-cron] CN 打板開盤確認完成: ${confirmed}/${total} 支確認進場`);
  }

  // 計時器
  setInterval(() => { refreshAndScan('TW').catch(err => console.error('[local-cron] TW refreshAndScan:', err)); }, 5 * 60 * 1000);
  setInterval(() => { refreshAndScan('CN').catch(err => console.error('[local-cron] CN refreshAndScan:', err)); }, 5 * 60 * 1000);
  setInterval(() => { maybeConfirmDabanOpen().catch(err => console.error('[local-cron] confirm-daban-open:', err)); }, 60 * 1000);
  setInterval(() => {
    downloadL1('TW').catch(err => console.error('[local-cron] TW downloadL1:', err));
    downloadL1('CN').catch(err => console.error('[local-cron] CN downloadL1:', err));
  }, 10 * 60 * 1000);
}
