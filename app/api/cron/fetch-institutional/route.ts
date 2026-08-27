/**
 * Daily cron：抓 TWSE + TPEx 三大法人買賣超，並同步掃描逐股快取
 * 收盤後 15:30 CST (UTC 07:30) 資料公開後觸發
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { fetchTWSEInstitutional } from '@/lib/datasource/TWSEInstitutional';
import { fetchTpexInstitutional } from '@/lib/datasource/TpexInstitutional';
import { saveInstitutionalTW, readInstitutionalTW } from '@/lib/storage/institutionalStorage';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { syncInstitutionalDailyToStockCache } from '@/lib/chips/institutionalDailySync';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';

export const runtime = 'nodejs';
export const maxDuration = 60;

function mergeInstitutionalRecords(
  ...sources: Array<ReadonlyArray<Awaited<ReturnType<typeof fetchTWSEInstitutional>>[number]>>
) {
  const bySymbol = new Map<string, Awaited<ReturnType<typeof fetchTWSEInstitutional>>[number]>();
  for (const source of sources) {
    for (const record of source) bySymbol.set(record.symbol, record);
  }
  return Array.from(bySymbol.values());
}

async function syncCurrentUniverse(
  date: string,
  records: Awaited<ReturnType<typeof fetchTWSEInstitutional>>,
  sourceReady: { twse: boolean; tpex: boolean },
) {
  const rank = await readTurnoverRank('TW');
  const ranked = rank ? Array.from(rank.symbols).slice(0, rank.topN) : [];
  // 停牌／當日無成交股沒有法人列是正確狀態，不應補成 0 或列為缺資料。
  const universe: string[] = [];
  const concurrency = 40;
  for (let i = 0; i < ranked.length; i += concurrency) {
    const chunk = ranked.slice(i, i + concurrency);
    const traded = await Promise.all(chunk.map(async symbol => {
      const file = await readCandleFile(symbol, 'TW').catch(() => null);
      return file?.candles.some(candle => candle.date === date) ? symbol : null;
    }));
    universe.push(...traded.filter((symbol): symbol is string => !!symbol));
  }
  if (universe.length === 0) {
    return { requested: 0, written: 0, zeroFilled: 0, missing: 0, note: 'turnover universe unavailable' };
  }
  return syncInstitutionalDailyToStockCache({ date, records, universe, sourceReady });
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');

  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  // 避免重複抓
  const existing = await readInstitutionalTW(date);
  if (existing && existing.length > 0 && !dateParam) {
    // 舊快取可能只含 TWSE，無來源 metadata；只同步確實存在的列，不把未知的 TPEx 值補成 0。
    const sync = await syncCurrentUniverse(date, existing, { twse: false, tpex: false });
    return apiOk({ skipped: true, reason: 'already cached; stock cache re-synced', date, count: existing.length, sync });
  }

  try {
    const [twseResult, tpexResult] = await Promise.allSettled([
      fetchTWSEInstitutional(date),
      fetchTpexInstitutional(date),
    ]);
    const twse = twseResult.status === 'fulfilled' ? twseResult.value : [];
    const tpex = tpexResult.status === 'fulfilled' ? tpexResult.value : [];
    // 任一官方來源暫時失敗時保留既有成功內容，只以本次成功來源覆蓋同代號；
    // 不允許「部分成功」把完整日檔降級覆蓋成半份資料。
    const records = mergeInstitutionalRecords(existing ?? [], twse, tpex);
    if (records.length === 0) {
      return apiOk({ skipped: true, reason: 'empty response (non-trading or not yet published)', date });
    }
    await saveInstitutionalTW(date, records);
    const sync = await syncCurrentUniverse(date, records, {
      twse: twseResult.status === 'fulfilled' && twse.length > 0,
      tpex: tpexResult.status === 'fulfilled' && tpex.length > 0,
    });
    return apiOk({
      date,
      count: records.length,
      sources: { twse: twse.length, tpex: tpex.length },
      sync,
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
