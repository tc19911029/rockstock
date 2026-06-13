import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { listAllProfilesOpenStockHoldings } from '@/lib/agents/portfolio/storage';

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
  return apiOk({ warmed, total: symbols.length, results });
}
