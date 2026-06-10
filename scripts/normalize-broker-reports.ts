/**
 * 法人報告 normalize — 確定性校正（根治 LLM 代號編造）。
 *
 * 用法：npx tsx scripts/normalize-broker-reports.ts <date>
 *
 * 對每筆 mention：
 *   1. 用全量 master 重查/驗證 matched.code（優先既有 code、否則 lookupStock(raw_query)、否則抽 4 位數字）
 *   2. 強制 rating = normalizeRating(rating_raw)、sentiment = sentimentFromRating(rating)
 *   3. market = matched ? 'TW' : 'OTHER'
 * 然後重存（saveDailyReports 會重算 stats）。並印 grounding 報告（查無者多為非台股）。
 */

import { loadDailyReports, saveDailyReports } from '@/lib/broker/brokerStorage';
import { normalizeRating, sentimentFromRating } from '@/lib/broker/types';
import { loadStockMaster, lookupStock } from '@/lib/youtube/stockMaster';

async function main() {
  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('用法：npx tsx scripts/normalize-broker-reports.ts <YYYY-MM-DD>');
    process.exit(1);
  }
  const day = await loadDailyReports(date);
  if (!day) { console.error(`找不到 data/broker/reports/${date}.json`); process.exit(1); }

  const master = await loadStockMaster();
  const byCode = new Map(master.entries.map(e => [e.code, e]));
  const unresolved: string[] = [];
  let fixed = 0;

  for (const report of day.reports) {
    for (const m of report.stocks) {
      // 1. 解析 code
      let entry = m.matched?.code ? byCode.get(m.matched.code) : undefined;
      if (!entry) {
        const lk = lookupStock(m.raw_query, master);
        if (lk) entry = byCode.get(lk.code);
      }
      if (!entry) {
        const digits = m.raw_query.match(/\b(\d{4})\b/);
        if (digits) entry = byCode.get(digits[1]);
      }

      const before = m.matched?.code ?? null;
      if (entry) {
        if (before !== entry.code) fixed += 1;
        m.matched = { code: entry.code, name: entry.name, market: entry.market, confidence: 1, match_via: 'exact_code' };
        m.market = 'TW';
      } else {
        if (before !== null) fixed += 1;
        m.matched = null;
        m.market = 'OTHER';
        unresolved.push(`${report.broker}/${m.raw_query}`);
      }

      // 2. 強制 rating/sentiment 一致
      m.rating = normalizeRating(m.rating_raw);
      m.sentiment = sentimentFromRating(m.rating);
    }
  }

  await saveDailyReports(day);
  console.log(`✓ normalize ${date}: ${day.reports.length} 份報告，修正 ${fixed} 筆 code/null。`);
  if (unresolved.length) {
    console.log(`\n[grounding] 查無對應台股（多為非台股 mention，matched=null）：`);
    for (const u of unresolved) console.log(`  · ${u}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
