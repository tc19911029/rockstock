/**
 * 盤後板塊（題材）強弱排名 — 每日 cron 腳本（2026-06-22）
 *
 * 對應 /api/cron/compute-sector-strength 的 standalone 版，給 launchd 每天盤後跑：
 *   讀 TWSE／TPEx 官方產業成分股 L1 + inst 序列 → data/sectors/TW/{date}.json
 *
 * 為什麼要這支：原本只有 route、沒排程（launchd 無 plist），所以盤後存檔一直停在舊日，
 * 跟「盤中即時」（現算）的題材成分/排名對不上。改成每天自動重建即一致。
 *
 * 用法：npx tsx scripts/compute-sector-strength.ts [YYYY-MM-DD]
 *   不帶日期 → 最近一個交易日（盤後 = 今天）。
 */
import { isTradingDay } from '../lib/utils/tradingDay';
import { getLastTradingDay } from '../lib/datasource/marketHours';
import { buildSectorRanking, saveSectorRanking } from '../lib/themes/sectorRanking';

(async () => {
  const arg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const date = arg ?? getLastTradingDay('TW');
  if (!isTradingDay(date, 'TW')) {
    console.log('[sector-strength] skip 非交易日', date);
    return;
  }
  const file = await buildSectorRanking(date);
  const covered = file.themes.filter((t) => t.avgD1 != null).length;
  // 全部題材都算不出報酬 = L1 還沒封 → 不存檔，留重跑機會
  if (covered === 0) {
    console.log('[sector-strength] skip: L1 尚未封存（no data）', date);
    return;
  }
  await saveSectorRanking(file);
  console.log('[sector-strength] saved', date, file.themes.length, '官方產業,', covered, '有資料');
})().catch((e) => {
  console.error('[sector-strength] error', e instanceof Error ? e.message : e);
  process.exit(1);
});
