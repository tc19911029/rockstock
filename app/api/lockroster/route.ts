/**
 * /api/lockroster — 鎖股名單（獵兔計劃）讀取與手動維護（批次D 2026-07-05）
 *
 * GET  ?market=TW           → { roster, recentReviews }
 * POST { market, action: 'add'|'remove', symbol, name? }
 *   - add：手動鎖股（source='manual'，汰弱只旗標不自動刪）
 *   - remove：手動移除（roster 直接剔除，寫 history 到當日 review）
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkSameOriginOrCron } from '@/lib/api/sameOriginAuth';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import type { MarketId } from '@/lib/scanner/types';
import { resolveStockIdentity } from '@/lib/stocks/resolveStockIdentity';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const market = (req.nextUrl.searchParams.get('market') ?? 'TW') as MarketId;
  const { loadLockRoster, listRecentReviews } = await import('@/lib/storage/lockRosterStorage');
  const [roster, recentReviews] = await Promise.all([
    loadLockRoster(market),
    listRecentReviews(market, 10),
  ]);
  return apiOk({ roster, recentReviews });
}

export async function POST(req: NextRequest) {
  const denied = checkSameOriginOrCron(req);
  if (denied) return denied;

  let bodyJson: { market?: MarketId; action?: string; symbol?: string; name?: string };
  try { bodyJson = await req.json(); } catch { return apiError('invalid json', 400); }
  const market = (bodyJson.market ?? 'TW') as MarketId;
  const requestedSymbol = (bodyJson.symbol ?? '').trim();
  if (!requestedSymbol) return apiError('symbol required', 400);

  const { loadLockRoster, saveLockRoster } = await import('@/lib/storage/lockRosterStorage');
  const { classifyHuntCategory, HUNT_LABELS, ROSTER_MAX } = await import('@/lib/scanner/lockRoster');
  const roster = (await loadLockRoster(market)) ?? { market, updatedAt: '', entries: [] };
  const today = getLastTradingDay(market);

  if (bodyJson.action === 'remove') {
    const before = roster.entries.length;
    roster.entries = roster.entries.filter(e => e.symbol !== requestedSymbol);
    if (roster.entries.length === before) return apiError('symbol not in roster', 404);
    roster.updatedAt = new Date().toISOString();
    await saveLockRoster(roster);
    return apiOk({ removed: requestedSymbol, total: roster.entries.length });
  }

  if (bodyJson.action === 'add') {
    const identity = await resolveStockIdentity({
      symbol: requestedSymbol,
      marketHint: market === 'CN' ? 'CN' : 'TW',
      providedName: bodyJson.name,
    });
    if (!identity.name || identity.market === 'unknown') {
      return apiError(`查不到 ${requestedSymbol} 的正式股票名稱，未加入鎖股名單`, 422);
    }
    if (identity.market !== market) {
      return apiError(`代號 ${requestedSymbol} 與市場 ${market} 不一致`, 422);
    }
    const symbol = identity.canonicalSymbol;
    if (roster.entries.some(e => e.symbol === symbol)) return apiError('already in roster', 409);
    if (roster.entries.length >= ROSTER_MAX + 5) return apiError(`roster full（課程上限 ${ROSTER_MAX} 檔，手動可小幅超額）`, 409);
    // 手動加入 → 立即分類一次（拿最新 K 線）
    const scanner = market === 'TW'
      ? new (await import('@/lib/scanner/TaiwanScanner')).TaiwanScanner()
      : new (await import('@/lib/scanner/ChinaScanner')).ChinaScanner();
    const cs = await scanner.fetchCandles(symbol, today).catch(() => []);
    const cls = cs.length >= 30 ? classifyHuntCategory(cs, cs.length - 1) : null;
    roster.entries.push({
      symbol, name: identity.name, market,
      addedDate: today, source: 'manual',
      category: cls?.category ?? 4,
      label: cls?.label ?? HUNT_LABELS[4],
      waitingFor: cls?.waitingFor ?? '（K線不足，待每日 cron 重分類）',
      urgency: cls?.urgency ?? 30,
      urgencyDetail: cls?.urgencyDetail ?? '手動鎖股',
      triggerLevel: cls?.triggerLevel,
      lastClose: cs.length ? cs[cs.length - 1].close : 0,
      lastReviewDate: today, weakFlags: [],
      history: [{ date: today, event: 'added', detail: '手動鎖股' }],
    });
    roster.entries.sort((a, b) => b.urgency - a.urgency);
    roster.updatedAt = new Date().toISOString();
    await saveLockRoster(roster);
    return apiOk({ added: symbol, total: roster.entries.length });
  }

  return apiError('action must be add or remove', 400);
}
