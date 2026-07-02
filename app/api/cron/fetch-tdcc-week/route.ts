/**
 * Cron: 抓 TDCC 集保戶股權分散表（週五持股，TDCC 週末才公布）
 *
 * 排程：每天 18:30 CST（= 10:30 UTC）`30 10 * * *`
 *   — 每天檢查，route 對已有基準日自動 skip（便宜）；不用固定週四（會慢一週，2026-06-07 踩過）
 *
 * Vercel cron 必填回傳格式：apiOk + 200
 */

import { NextRequest } from 'next/server';
import { apiOk, apiError } from '@/lib/api/response';
import { fetchTdccLatestWeek } from '@/lib/datasource/TdccProvider';
import { appendTdccDay, readTdccStock } from '@/lib/chips/ChipStorage';
import { checkCronAuth } from '@/lib/api/cronAuth';

export const runtime = 'nodejs';
export const maxDuration = 300; // TDCC CSV 約 2.3 MB，需較長 timeout

export async function GET(req: NextRequest) {
  const authDenied = checkCronAuth(req);
  if (authDenied) return authDenied;

  // 2026-05-07：?force=1 重抓並比對內容（TDCC 偶爾發修正版同日期不同分布，
  // 原邏輯 lastDate 相同直接跳過會錯過修正）
  const force = req.nextUrl.searchParams.get('force') === '1';

  try {
    console.log('[cron/fetch-tdcc-week] 開始抓取 TDCC 集保資料...');
    const week = await fetchTdccLatestWeek();
    console.log(`[cron/fetch-tdcc-week] 取得 ${week.date}，共 ${week.data.size} 檔`);

    let saved = 0;
    let skipped = 0;
    let updated = 0;
    for (const [code, row] of week.data) {
      const existing = await readTdccStock(code);
      if (existing?.lastDate === week.date && !force) {
        // 同日期且非強制 → 比對 row 簽章決定是否更新
        // 2026-05-08：原寫 existing.rows 但 TdccStockFile schema 是 data 不是 rows（self-bug）
        const lastRow = existing.data?.[existing.data.length - 1];
        const same = lastRow && JSON.stringify(lastRow) === JSON.stringify({ ...row, date: week.date });
        if (same) { skipped++; continue; }
        await appendTdccDay(code, week.date, row);
        updated++;
        continue;
      }
      await appendTdccDay(code, week.date, row);
      saved++;
    }

    console.log(`[cron/fetch-tdcc-week] 完成 saved=${saved} updated=${updated} skipped=${skipped}`);
    return apiOk({
      date: week.date,
      totalStocks: week.data.size,
      saved,
      updated,
      skipped,
    });
  } catch (err) {
    console.error('[cron/fetch-tdcc-week] 失敗:', err);
    return apiError(err instanceof Error ? err.message : 'TDCC fetch failed');
  }
}
