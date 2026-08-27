import { NextRequest, NextResponse } from 'next/server';
import { rankCodeToThemesToday } from '@/lib/theme-sanse/todayHot';
import { TW_OFFICIAL_CLASSIFICATION } from '@/lib/datasource/TWOfficialIndustry';
import type { ThemeRef, TsMarket } from '@/lib/theme-sanse/types';
import { isValidYmd } from '@/lib/utils/ymd';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// CN 首次建（抓全部 ~390 概念成分股）約 40s；給 120s 安全邊際。建好寫硬碟快取後秒回。
export const maxDuration = 120;

/**
 * 輕量產業／題材熱度查詢（給全站策略掃描頁排序用）。
 * 回 byCode = 裸碼 → 所屬熱門分類 refs（已按「今日漲幅」名次升冪，refs[0]=最熱）。
 * 兩市場：TW=TWSE／TPEx 官方產業按 avgD1；CN=概念板塊按今日 pct（即時抓成分股，反指標僅觀察）。
 * 掃描頁只在封存日（lastDate）變時抓一次（非每次盤中輪詢）；結果在 todayHot 內按 (market,date) 快取。
 */
export async function GET(req: NextRequest) {
  const marketRaw = (req.nextUrl.searchParams.get('market') ?? 'TW').toUpperCase();
  if (marketRaw !== 'TW' && marketRaw !== 'CN') {
    return NextResponse.json({ ok: false, error: `market 要 TW|CN，得到 '${marketRaw}'` }, { status: 400 });
  }
  const market = marketRaw as TsMarket;
  const date = req.nextUrl.searchParams.get('date');
  if (!isValidYmd(date)) {
    return NextResponse.json({ ok: false, error: `需要合法 date（YYYY-MM-DD），得到 '${date}'` }, { status: 400 });
  }
  if (!isTradingDay(date, market)) {
    return NextResponse.json({ ok: false, error: `非交易日：${date}` }, { status: 400 });
  }
  if (date > getLastTradingDay(market)) {
    return NextResponse.json({ ok: false, error: `日期尚未收盤：${date}` }, { status: 400 });
  }
  try {
    const byCodeMap = await rankCodeToThemesToday(market, date);
    const byCode = Object.fromEntries(byCodeMap) as Record<string, ThemeRef[]>;
    // 不同題材數＝byCode 內出現過的 themeId 去重
    const themeIds = new Set<string>();
    for (const refs of byCodeMap.values()) for (const r of refs) themeIds.add(r.themeId);
    return NextResponse.json({
      ok: true,
      market,
      date,
      classification: market === 'TW' ? TW_OFFICIAL_CLASSIFICATION : null,
      byCode,
      themeCount: themeIds.size,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'hot 失敗' }, { status: 503 });
  }
}
