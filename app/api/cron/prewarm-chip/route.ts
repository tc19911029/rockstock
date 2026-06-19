import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { listAllProfilesOpenStockHoldings } from '@/lib/agents/portfolio/storage';
import { checkChipFreshness } from '@/lib/health/chipFreshness';
import { snapshotBrokerDayFromFinMind } from '@/lib/chips/brokerSnapshotFinMind';
import { sendNtfy } from '@/lib/notify/ntfy';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * 籌碼/成本價預熱 cron（2026-06-12，QA 提案 #6）。
 *
 * 背景：/api/chip 與 /api/cost-basis 冷載要打 TDCC/券商/融資等外部源，
 * 實測 15-20 秒；使用者點開持倉股籌碼面板就要罰站。本 route 每日盤後
 * （launchd 18:10，TDCC 18:00 更新後）對「持倉 + 三色監看清單」逐檔自打
 * 內部端點，把 server cache 烘熱，白天點開秒回。
 *
 * 只預熱 TW（chip/cost-basis 是台股資料鏈）；symbols 來源：
 *   - 所有持倉人（profiles）的 open 持倉聯集（2026-06-12 改，
 *     與 sanse-notify 同源，取代手寫 sanse-watch.json）
 */
async function collectSymbols(): Promise<string[]> {
  try {
    const all = await listAllProfilesOpenStockHoldings();
    return all.map(x => x.symbol).filter(s => /\.(TW|TWO)$/i.test(s));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('host') ?? 'localhost:3000';
  const base = `${proto}://${host}`;
  const symbols = await collectSymbols();
  if (symbols.length === 0) return apiOk({ warmed: 0, note: 'no symbols' });

  const results: Array<{ symbol: string; chipMs: number | null; costMs: number | null }> = [];
  for (const sym of symbols) {
    const r = { symbol: sym, chipMs: null as number | null, costMs: null as number | null };
    for (const [key, url] of [
      ['chipMs', `${base}/api/chip?symbol=${encodeURIComponent(sym)}`],
      ['costMs', `${base}/api/cost-basis?symbol=${encodeURIComponent(sym)}`],
    ] as const) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (res.ok) { await res.arrayBuffer(); r[key] = Date.now() - t0; }
      } catch { /* 單檔失敗不擋整批 */ }
    }
    results.push(r);
  }
  const warmed = results.filter(r => r.chipMs !== null || r.costMs !== null).length;
  if (warmed === 0) return apiError('prewarm 全部失敗', 500);

  // ── 主力分點補寫（2026-06-19，取代會漏的 Yahoo 250 檔 cron）─────────────────
  // 用 FinMind 分點（同源、無 250 上限、有歷史）逐檔補寫 broker 檔最新一筆，讓
  // 主力成本(brokerCost)/掃描/chip 集中度欄持續累積。best-effort，失敗不擋。
  let brokerSnap = 0;
  for (const sym of symbols) {
    const code = sym.replace(/\.(TW|TWO)$/i, '');
    try {
      if (await snapshotBrokerDayFromFinMind(code)) brokerSnap++;
    } catch { /* 單檔失敗不擋整批 */ }
  }

  // ── 籌碼資料體檢（2026-06-19）─────────────────────────────────────────────
  // 暖完順手體檢：持倉股「買賣超/集中度」(FinMind 分點同源) 有沒有變空/過期。
  // 紅了走 ntfy 推手機 → 系統先叫、不用使用者眼睛掃到才發現（買賣超原靠 Yahoo 250 檔
  // 上限的 cron 靜默漏，就是這樣才沒人知道）。best-effort，失敗不擋 prewarm。
  let chipAlarm: { level: string; checked: number; staleCount: number; pushed: boolean } | null = null;
  try {
    const chip = await checkChipFreshness();
    let pushed = false;
    if (chip.level === 'red' && chip.stale.length > 0) {
      const detail = chip.stale
        .map(s => `${s.name || s.symbol}（最後${s.chipLast ?? '無'}／應到${s.expected ?? '?'}）`)
        .join('\n');
      const sent = await sendNtfy({
        title: `📉 籌碼資料過期 — ${chip.stale.length} 檔持倉買賣超/集中度沒更新`,
        message: `這幾檔的買賣超/集中度抓不到最新資料（走圖會留白）：\n${detail}\n\n多半是資料源臨時抓不到，通常隔天會自己補回；連續幾天就要查來源。`,
        tags: ['chart_with_downwards_trend'],
        priority: 3,
        click: 'http://localhost:3000/health',
      });
      pushed = sent.ok;
    }
    chipAlarm = { level: chip.level, checked: chip.checked, staleCount: chip.stale.length, pushed };
  } catch (err) {
    console.warn('[prewarm-chip] 籌碼體檢失敗:', err);
  }

  return apiOk({ warmed, total: symbols.length, results, brokerSnap, chipAlarm });
}
