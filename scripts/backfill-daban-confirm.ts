import { confirmDabanAtOpen } from '../lib/scanner/DabanScanner';
import { listDabanDates } from '../lib/storage/dabanStorage';

/**
 * Backfill 所有 daban session 的 openConfirmed + sentiment 指標。
 * 動態用 listDabanDates 拿到所有日期，pair 連續兩天當 scanDate/openDate。
 */
async function main() {
  const all = await listDabanDates();
  // listDabanDates 回 desc，反轉為 asc 才能正確 pair
  const allDates = [...all].sort((a, b) => a.date.localeCompare(b.date));

  // 預設只重跑最近 N=15 個交易日（command line: --all 跑全部）
  const allFlag = process.argv.includes('--all');
  const dates = allFlag ? allDates : allDates.slice(-15);

  console.log(`找到 ${allDates.length} 個 daban session，本次處理 ${dates.length} 個：${dates[0]?.date} ~ ${dates[dates.length - 1]?.date}\n`);

  const pairs: [string, string][] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    pairs.push([dates[i].date, dates[i + 1].date]);
  }

  let okCount = 0;
  for (const [scanDate, openDate] of pairs) {
    try {
      const result = await confirmDabanAtOpen(scanDate, openDate);
      if (!result) { console.log(`${scanDate} → ${openDate}  ❌ NULL`); continue; }
      const confirmed = result.results.filter(r => r.openConfirmed).length;
      const s = result.sentiment;
      const sentInfo = s
        ? `isCold=${s.isCold} winRate=${s.recentWinRate ?? 'n/a'}% avg=${s.recentAvgReturn ?? 'n/a'}% (${s.recentTradeCount ?? 0}筆/${s.recentSessions ?? 0}天)`
        : 'no sentiment';
      console.log(`${scanDate} → ${openDate}  total=${result.results.length}  confirmed=${confirmed}  ${sentInfo}`);
      okCount++;
    } catch (err) {
      console.log(`${scanDate} → ${openDate}  ❌ ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n完成：${okCount}/${pairs.length} 成功`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
