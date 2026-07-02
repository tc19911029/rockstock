/**
 * 法人報告 audit — 完工前強制驗證（0 FAIL 才交付）。
 *
 * 用法：npx tsx scripts/audit-broker-reports.ts <date>
 *
 * 守則：
 *   - report_id 非空、report_date = YYYY-MM-DD、broker 非空
 *   - sentiment === sentimentFromRating(normalizeRating(rating_raw))（單一事實來源）
 *   - target_price / prev_target_price 為 null 或 > 0
 *   - covered === true ⇒ rating !== 'other'
 *   - matched 存在 ⇒ market='TW'；matched=null ⇒ market='OTHER'
 */

import { loadDailyReports } from '@/lib/broker/brokerStorage';
import { normalizeRating, sentimentFromRating } from '@/lib/broker/types';

async function main() {
  const date = process.argv[2];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('用法：npx tsx scripts/audit-broker-reports.ts <YYYY-MM-DD>');
    process.exit(1);
  }
  const day = await loadDailyReports(date);
  if (!day) { console.error(`找不到 data/broker/reports/${date}.json`); process.exit(1); }

  const fails: string[] = [];
  const F = (id: string, msg: string) => fails.push(`[${id}] ${msg}`);

  for (const r of day.reports) {
    const tag = `${r.broker}/${r.report_id}`;
    if (!r.report_id) F(tag, 'report_id 空');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.report_date)) F(tag, `report_date 格式錯：${r.report_date}`);
    if (!r.broker) F(tag, 'broker 空');
    for (const m of r.stocks) {
      const stag = `${tag}/${m.raw_query}`;
      const expectSent = sentimentFromRating(normalizeRating(m.rating_raw));
      if (m.sentiment !== expectSent) F(stag, `sentiment=${m.sentiment} 應為 ${expectSent}（rating_raw=${m.rating_raw}）`);
      if (m.rating !== normalizeRating(m.rating_raw)) F(stag, `rating=${m.rating} 應為 ${normalizeRating(m.rating_raw)}`);
      if (m.target_price != null && !(m.target_price > 0)) F(stag, `target_price 非正：${m.target_price}`);
      if (m.prev_target_price != null && !(m.prev_target_price > 0)) F(stag, `prev_target_price 非正：${m.prev_target_price}`);
      if (m.covered && m.rating === 'other') F(stag, 'covered=true 但 rating=other（主標的必有評等）');
      if (m.matched && m.market !== 'TW') F(stag, `有 matched 但 market=${m.market}`);
      if (!m.matched && m.market !== 'OTHER') F(stag, `matched=null 但 market=${m.market}`);
    }
  }

  if (fails.length === 0) {
    console.log(`✓ audit ${date} PASS：${day.reports.length} 份報告全部通過。`);
    process.exit(0);
  }
  console.error(`✗ audit ${date} FAIL（${fails.length}）：`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
