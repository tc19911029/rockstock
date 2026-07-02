#!/usr/bin/env npx tsx
/**
 * backfill-broker-tw.ts — 種下／更新主力券商分點快照到 data/chips/TW/broker/{code}.json
 *
 * ⚠️ Yahoo broker-trading 只有「當日」資料、無歷史。本腳本只能「種下今日快照」，
 *    讓 broker cache 立即存在並開始累積；真正的多日歷史靠每日 cron
 *    /api/cron/snapshot-broker-tw 逐日 append。歷史 < 20 日 → 主力成本顯示「累積中」。
 *
 * 用法：
 *   npx tsx scripts/backfill-broker-tw.ts 3661 2330 2317
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { appendBrokerDay } from '@/lib/chips/BrokerStorage';

function todayTaipei(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const codes = process.argv.slice(2).map(c => c.replace(/\.(TW|TWO)$/i, '').trim()).filter(Boolean);
  if (codes.length === 0) {
    console.error('用法: npx tsx scripts/backfill-broker-tw.ts <code> [code...]');
    process.exit(1);
  }
  const fallbackDate = todayTaipei();
  for (const code of codes) {
    try {
      const t = await fetchYahooBrokerTrades(code);
      if (!t) { console.log(`✗ ${code}: 無主力分點資料（盤後 17:00 後才有 / 該股無資料）`); continue; }
      const d = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : fallbackDate;
      await appendBrokerDay(code, d, {
        netDifference: t.totalDifferenceVolK,
        concentration: +(t.concentration * 100).toFixed(2),
      });
      console.log(`✓ ${code} @ ${d}: 主力淨買 ${t.totalDifferenceVolK} 張、集中度 ${(t.concentration * 100).toFixed(2)}%`);
    } catch (e) {
      console.log(`✗ ${code}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log('\n注意：單日快照不足以算「主力成本均線」（需 ≥20 日）。每日 cron 會持續累積。');
}

main();
