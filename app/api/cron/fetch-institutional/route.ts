/**
 * Daily cron：抓 TWSE + TPEx 三大法人買賣超，並同步掃描逐股快取
 * 收盤後 15:30 CST (UTC 07:30) 資料公開後觸發
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiFailure } from '@/lib/api/response';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { fetchTWSEInstitutional } from '@/lib/datasource/TWSEInstitutional';
import { fetchTpexInstitutional } from '@/lib/datasource/TpexInstitutional';
import { saveInstitutionalTW, readInstitutionalTW } from '@/lib/storage/institutionalStorage';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { readTurnoverRank } from '@/lib/scanner/TurnoverRank';
import { syncInstitutionalDailyToStockCache } from '@/lib/chips/institutionalDailySync';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { redactSensitiveText } from '@/lib/datasource/curlFetch';

export const runtime = 'nodejs';
export const maxDuration = 60;

function syncCoverage(sync: { requested: number; written: number }): number {
  return sync.requested > 0 ? +(sync.written / sync.requested).toFixed(4) : 0;
}

function institutionalResponse(
  date: string,
  count: number,
  sync: Awaited<ReturnType<typeof syncCurrentUniverse>>,
  extra: Record<string, unknown> = {},
) {
  const coverage = syncCoverage(sync);
  const details = { date, count, sync, coverage, ...extra };
  if (sync.requested === 0 || coverage < 0.98 || sync.missing > 0) {
    return apiFailure('institutional stock-cache sync incomplete', {
      dataStatus: 'degraded',
      ...details,
    });
  }
  return apiOk({ dataStatus: 'complete', ...details });
}

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

  // 日檔存在不代表兩個官方來源都完整；每次重跑都重新抓 TWSE + TPEx，讓部分成功可自癒。
  // existing 只作「本次某來源失敗時不倒退覆蓋」的保底，不能短路重試。
  const existing = await readInstitutionalTW(date);

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
      return apiOk({
        skipped: true,
        dataStatus: 'pending',
        reason: 'empty response (non-trading or not yet published)',
        date,
      }, { status: 202 });
    }
    await saveInstitutionalTW(date, records);
    const sync = await syncCurrentUniverse(date, records, {
      twse: twseResult.status === 'fulfilled' && twse.length > 0,
      tpex: tpexResult.status === 'fulfilled' && tpex.length > 0,
    });
    return institutionalResponse(date, records.length, sync, {
      sources: { twse: twse.length, tpex: tpex.length },
      sourceErrors: {
        twse: twseResult.status === 'rejected' ? redactSensitiveText(twseResult.reason) : null,
        tpex: tpexResult.status === 'rejected' ? redactSensitiveText(tpexResult.reason) : null,
      },
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
