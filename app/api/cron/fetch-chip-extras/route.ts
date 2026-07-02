/**
 * Daily cron：融資券 / 借券 / 當沖 全市場持久化（2026-06-12 B2）
 *
 * 為什麼：/api/chip 原本動態查官方（單檔），沒有本地歷史序列就做不了
 * 「融資暴增」「借券暴增」「當沖過高」的時間序判斷，也無法回測這些排除型訊號。
 *
 * 排程：21:35 CST（借券 TWT93U 約 21:00 後才完整）。
 * 來源全官方 bulk（單次回全市場，零 FinMind 額度）：
 *   margin   = TWSE MI_MARGN + TPEx margin_bal_result
 *   sbl      = TWSE TWT93U + TPEx /www/zh-tw/margin/sbl
 *   daytrade = TWSE TWTB4U（上櫃無個股表 — v1 缺口，仍走 FinMind fallback）
 *
 * 用法：GET /api/cron/fetch-chip-extras[?date=YYYY-MM-DD]（不帶 date = 最近交易日）
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { checkCronAuth } from '@/lib/api/cronAuth';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { fetchTwseMarginBulk } from '@/lib/datasource/TwseMarginProvider';
import { fetchTpexMarginBulk } from '@/lib/datasource/TpexMarginProvider';
import { fetchTwseSblBulk } from '@/lib/datasource/TwseSblProvider';
import { fetchTpexSblBulk } from '@/lib/datasource/TpexSblProvider';
import { fetchTwseDayTradeBulk } from '@/lib/datasource/TwseDayTradeProvider';
import {
  writeMarginStock, writeSblStock, writeDayTradeStock,
  type MarginDay, type SblDay, type DayTradeDay,
} from '@/lib/chips/ChipExtrasStorage';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** 個股/ETF 代號（剃掉權證等奇形 row）*/
const CODE_RE = /^\d{4}$|^00\d{2,4}[A-Z]?$/;

async function writeAll<T extends { date: string }>(
  byCode: Map<string, T[]>,
  writer: (code: string, rows: T[]) => Promise<{ added: boolean }>,
): Promise<number> {
  let written = 0;
  const codes = [...byCode.keys()];
  const CONCURRENCY = 32;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(code => writer(code, byCode.get(code)!)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.added) written++;
    }
  }
  return written;
}

function groupByCode<R extends { stockId: string }, T extends { date: string }>(
  rows: R[],
  toDay: (r: R) => T,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const code = r.stockId.trim();
    if (!CODE_RE.test(code)) continue;
    const day = toDay(r);
    const arr = out.get(code);
    if (arr) arr.push(day);
    else out.set(code, [day]);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  const dateParam = req.nextUrl.searchParams.get('date');
  const date = dateParam ?? getLastTradingDay('TW');
  if (!isTradingDay(date, 'TW')) {
    return apiOk({ skipped: true, reason: 'non-trading day', date });
  }

  try {
    // TWSE 對同 IP 並發敏感（實測三條並發第三條被擋回空）→ TWSE 串行 + 間隔，TPEx 並行
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const twsePromise = (async () => {
      const margin = await fetchTwseMarginBulk(date);
      await sleep(1500);
      const sbl = await fetchTwseSblBulk(date);
      await sleep(1500);
      const dayTrade = await fetchTwseDayTradeBulk(date);
      return { margin, sbl, dayTrade };
    })();
    const [twse, tpexMargin, tpexSbl] = await Promise.all([
      twsePromise,
      fetchTpexMarginBulk(date),
      fetchTpexSblBulk(date),
    ]);
    const { margin: twseMargin, sbl: twseSbl, dayTrade: twseDayTrade } = twse;

    const fetched = {
      twseMargin: twseMargin.length,
      tpexMargin: tpexMargin.length,
      twseSbl: twseSbl.length,
      tpexSbl: tpexSbl.length,
      twseDayTrade: twseDayTrade.length,
    };

    // 全部來源空 = 資料未出表或被擋，不寫檔（保留舊序列）
    if (Object.values(fetched).every(n => n === 0)) {
      return apiOk({ skipped: true, reason: 'all sources empty (not yet published or blocked)', date, fetched });
    }

    const marginByCode = new Map<string, MarginDay[]>([
      ...groupByCode(twseMargin, r => ({
        date: r.date, marginBalance: r.marginBalance, marginNet: r.marginNet,
        marginUtilRate: r.marginUtilRate, shortBalance: r.shortBalance, shortNet: r.shortNet,
      } satisfies MarginDay)),
      ...groupByCode(tpexMargin, r => ({
        date: r.date, marginBalance: r.marginBalance, marginNet: r.marginNet,
        marginUtilRate: r.marginUtilRate, shortBalance: r.shortBalance, shortNet: r.shortNet,
      } satisfies MarginDay)),
    ]);
    const sblByCode = new Map<string, SblDay[]>([
      ...groupByCode([...twseSbl, ...tpexSbl], r => ({
        date: r.date, lendingBalance: r.lendingBalance, lendingNet: r.lendingNet,
        lendingShortSales: r.lendingShortSales, shortBalance: r.shortBalance, shortNet: r.shortNet,
      } satisfies SblDay)),
    ]);
    const dayTradeByCode = groupByCode(twseDayTrade, r => ({
      date: r.date, dayTradeLots: r.dayTradeLots, buyValue: r.buyValue, sellValue: r.sellValue,
    } satisfies DayTradeDay));

    const written = {
      margin: await writeAll(marginByCode, writeMarginStock),
      sbl: await writeAll(sblByCode, writeSblStock),
      daytrade: await writeAll(dayTradeByCode, writeDayTradeStock),
    };

    return apiOk({ date, fetched, written });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
}
