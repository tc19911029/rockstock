#!/usr/bin/env npx tsx
/**
 * backfill-holdings-costbasis.ts — 為「現在手上的持股」回推補齊成本／壓力價所需的歷史資料。
 *
 * 對每檔持股（預設讀 me + 各 profile 的 holdings.json；也可帶代號覆寫）：
 *   1. 法人歷史（T86 / FinMind range）→ writeInstStock
 *   2. 融資融券 / 借券 / 價格VWAP 歷史 → getMarginSeries / getSblSeries / getPriceSeries（順帶寫 cache）
 *   3. 種下今日 Yahoo 分點快照 → appendBrokerDay（之後靠 cron 累積）
 *   4. 印出回推後的 9 項成本（含主力成本口徑 branch/composite/none）
 *
 * ⚠️ 真正的「分點主力」歷史在台股是付費資料；主力成本在分點累積 <20 日前用
 *    「主力綜合」(法人+融資+借券合成) 估算（method=composite）。
 *
 * 用法：
 *   npx tsx scripts/backfill-holdings-costbasis.ts            # 讀持股
 *   npx tsx scripts/backfill-holdings-costbasis.ts 2408 3661  # 指定代號
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { promises as fs } from 'fs';
import path from 'path';
import { fetchT86ForStock } from '@/lib/datasource/TwseT86Provider';
import { writeInstStock } from '@/lib/chips/ChipStorage';
import { getMarginSeries, getSblSeries, getPriceSeries } from '@/lib/squeeze/dataLoader';
import { fetchYahooBrokerTrades } from '@/lib/datasource/YahooBrokerScraper';
import { appendBrokerDay } from '@/lib/chips/BrokerStorage';
import { getCostBasisBundle } from '@/lib/chipcost/aggregate';

function todayTaipei(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function daysAgo(end: string, n: number): string {
  const d = new Date(end + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function readHoldingCodes(): Promise<string[]> {
  const out = new Set<string>();
  const files: string[] = ['data/agents/portfolio/holdings.json'];
  try {
    const dirs = await fs.readdir(path.join(process.cwd(), 'data', 'portfolios'));
    for (const d of dirs) files.push(`data/portfolios/${d}/holdings.json`);
  } catch { /* no profiles */ }

  for (const f of files) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(process.cwd(), f), 'utf8')) as
        { holdings?: Array<{ symbol?: string; ticker?: string; market?: string; status?: string }> };
      for (const h of j.holdings ?? []) {
        if ((h.market ?? 'TW') !== 'TW') continue;          // 分點只有台股
        if (h.status && h.status !== 'open') continue;
        const code = String(h.symbol ?? h.ticker ?? '').replace(/\.(TW|TWO)$/i, '').trim();
        if (code) out.add(code);
      }
    } catch { /* missing/empty file */ }
  }
  return [...out];
}

async function main() {
  const argCodes = process.argv.slice(2).map(c => c.replace(/\.(TW|TWO)$/i, '').trim()).filter(Boolean);
  const codes = argCodes.length ? argCodes : await readHoldingCodes();
  if (codes.length === 0) {
    console.error('找不到持股（data/agents/portfolio/holdings.json 為空）；可手動帶代號。');
    process.exit(1);
  }
  const date = todayTaipei();
  const start = daysAgo(date, 130);
  console.log(`回推 ${codes.length} 檔：${codes.join(', ')}  (window ${start} ~ ${date})\n`);

  for (const code of codes) {
    const tag = `[${code}]`;
    // 1. 法人歷史
    try {
      const fetched = await fetchT86ForStock(code, start, date);
      if (fetched.size > 0) {
        await writeInstStock(code, Array.from(fetched.entries()).map(([d, v]) => ({ date: d, ...v })));
      }
    } catch (e) { console.log(`${tag} 法人補抓失敗: ${e instanceof Error ? e.message : e}`); }

    // 2. 融資融券 / 借券 / 價格VWAP（getter 內含寫 cache）
    await getMarginSeries(code, start, date).catch(() => []);
    await getSblSeries(code, start, date).catch(() => []);
    await getPriceSeries(code, start, date).catch(() => []);

    // 3. 種下今日分點
    try {
      const t = await fetchYahooBrokerTrades(code);
      if (t) {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(t.date) ? t.date : date;
        await appendBrokerDay(code, d, { netDifference: t.totalDifferenceVolK, concentration: +(t.concentration * 100).toFixed(2) });
      }
    } catch { /* 分點當日無資料 */ }

    // 4. 回報
    try {
      const b = await getCostBasisBundle(code, date);
      const f = (v: number | null) => (v == null ? '—' : v.toFixed(0));
      console.log(
        `${tag} ${b.name} 收${f(b.close)}｜外資${f(b.costs.foreign.d20)} 投信${f(b.costs.trust.d20)} 自營${f(b.costs.dealer.d20)} ` +
        `主力${f(b.costs.broker.d20)}(${b.brokerCostMethod}) 融資${f(b.costs.margin.d20)} 融券${f(b.costs.short.d20)} 券賣${f(b.costs.sbl.d20)}｜` +
        `嘎空${f(b.squeezePrice)} 斷頭${f(b.marginLiquidationPrice)}  [inst ${b.dataCompleteness.instDays}d / margin ${b.dataCompleteness.marginDays}d]`,
      );
    } catch (e) { console.log(`${tag} 成本彙整失敗: ${e instanceof Error ? e.message : e}`); }
  }
  console.log('\n完成。主力成本 method=composite 表示用「主力綜合」估算（分點歷史累積 ≥20 日後自動轉 branch）。');
}

main();
