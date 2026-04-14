import { NextRequest } from 'next/server';
import { confirmDabanAtOpen } from '@/lib/scanner/DabanScanner';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { apiOk, apiError } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 9:25 AM CST 開盤確認 cron
 *
 * 讀取前一交易日的打板掃描結果，對照今日集合競價後的報價，
 * 標記每支候選股是否確認進場（openPrice >= buyThresholdPrice）。
 *
 * 觸發時機：CN 市場 9:25 CST = UTC 01:25
 * 此時 IntradayCache 已有最新集合競價價格（intraday cron 每 2 分鐘更新）。
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return apiError('Unauthorized', 401);
  }

  try {
    // 今日（開盤確認日）
    const openDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    // 上一個交易日（打板掃描日）— 9:25 盤前，getLastTradingDay 返回昨天
    const scanDate = getLastTradingDay('CN');

    if (scanDate === openDate) {
      // 防禦：若 scanDate 等於今天，表示市場已收盤，無需確認
      return apiOk({ skipped: true, reason: 'scanDate equals openDate', scanDate, openDate });
    }

    const result = await confirmDabanAtOpen(scanDate, openDate);

    return apiOk({
      scanDate,
      openDate,
      confirmed: result !== null,
      confirmedCount: result?.results.filter(r => r.openConfirmed).length ?? 0,
      totalCount: result?.resultCount ?? 0,
    });
  } catch (err) {
    return apiError(String(err));
  }
}
