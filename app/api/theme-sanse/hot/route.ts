import { NextRequest, NextResponse } from 'next/server';
import { rankHotThemes } from '@/lib/theme-sanse/hotThemes';
import { invertHotThemes } from '@/lib/theme-sanse/codeThemes';
import type { ThemeRef, TsMarket } from '@/lib/theme-sanse/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * 輕量題材熱度查詢（給三色掃描頁的「🔥今日熱點」排序用）。
 * 回 byCode = 裸碼 → 所屬熱門題材 refs（已按熱度名次升冪）。
 * 三色掃描頁只在 lastDate 變時抓一次（非每次盤中輪詢），避免重算 rankHotThemes 的成本。
 */
export async function GET(req: NextRequest) {
  const marketRaw = (req.nextUrl.searchParams.get('market') ?? 'TW').toUpperCase();
  if (marketRaw !== 'TW' && marketRaw !== 'CN') {
    return NextResponse.json({ ok: false, error: `market 要 TW|CN，得到 '${marketRaw}'` }, { status: 400 });
  }
  const market = marketRaw as TsMarket;
  const date = req.nextUrl.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, error: `需要合法 date（YYYY-MM-DD），得到 '${date}'` }, { status: 400 });
  }
  try {
    const hot = await rankHotThemes(market, date);
    const byCode = Object.fromEntries(invertHotThemes(hot)) as Record<string, ThemeRef[]>;
    return NextResponse.json({ ok: true, market, date, byCode, themeCount: hot.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'hot 失敗' }, { status: 500 });
  }
}
