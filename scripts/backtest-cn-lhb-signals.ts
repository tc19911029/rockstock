/**
 * 龍虎榜訊號回測 — 哪種龍虎榜情況買進後比較會漲？
 *
 * 對每筆上榜股，用 EM 榜面自帶的「上榜後 5 日漲跌」(fwd.d5) 當結果，
 * 按不同訊號分組，比平均漲跌 + 勝率（d5>0 的比例）。和「全體上榜股」基準比。
 *
 * 註：d5 是該股自己的漲跌（不是贏大盤多少）；先看相對基準的高低就有意義。
 * 席位類訊號只有約 119 天有明細，板面類（買超/原因）245 天都有。
 *
 * 用法：npx tsx scripts/backtest-cn-lhb-signals.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import path from 'path';
import { promises as fs } from 'fs';
import type { LhbDailyFile, LhbStockEntry } from '@/lib/cn-agents/types';

const DIR = path.join(process.cwd(), 'data', 'cn-agents', 'lhb');

interface Cohort { n: number; sum: number; win: number }
function add(c: Cohort, d5: number) { c.n++; c.sum += d5; if (d5 > 0) c.win++; }
function fmt(c: Cohort) {
  return { 筆數: c.n, 平均5日漲跌: c.n ? +(c.sum / c.n).toFixed(2) : null, 勝率: c.n ? +(c.win / c.n).toFixed(2) : null };
}

async function main(): Promise<void> {
  const files = (await fs.readdir(DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const all: Cohort = { n: 0, sum: 0, win: 0 };
  const sig: Record<string, Cohort> = {};
  const g = (k: string) => (sig[k] ??= { n: 0, sum: 0, win: 0 });

  for (const f of files) {
    const day = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf-8')) as LhbDailyFile;
    for (const s of day.stocks) {
      const d5 = s.fwd?.d5;
      if (d5 === null || d5 === undefined || !Number.isFinite(d5)) continue;
      add(all, d5);

      // 板面類（全天有）
      add(g(s.netAmt != null && s.netAmt > 0 ? '淨買超' : '淨賣超'), d5);
      if (s.reason.includes('涨幅')) add(g('原因:漲幅偏離(漲多)'), d5);
      else if (s.reason.includes('跌幅')) add(g('原因:跌幅偏離(跌多)'), d5);
      else if (s.reason.includes('换手')) add(g('原因:高換手'), d5);

      // 席位類（約119天有明細）
      if (day.detailFetched) {
        const ss = s.seatSummary;
        if (ss.institutionBuyCount > 0) add(g('機構買入'), d5);
        if (ss.institutionSellCount > 0) add(g('機構賣出'), d5);
        if (ss.hotMoneyBuyCount > 0) add(g('知名游資買入'), d5);
        if (ss.hotMoneyBuyCount >= 2) add(g('多家游資合力(≥2)'), d5);
        if (ss.retailProxyBuyCount > 0) add(g('散戶通道(拉薩)買'), d5);
        if (ss.buyOneDominance != null && ss.buyOneDominance > 0.5) add(g('買一獨大(>50%)'), d5);
        if (ss.buyOneDominance != null && ss.buyOneDominance <= 0.4 && s.seats.buy.length >= 4) add(g('多席合力(不獨大)'), d5);
        if (ss.northboundBuyCount > 0) add(g('北向通道買'), d5);
      }
    }
  }

  console.log(`📊 龍虎榜訊號回測：${files.length} 天、${all.n} 筆有結果`);
  console.log(`\n基準（全體上榜股）：平均 5 日 ${(all.sum / all.n).toFixed(2)}%、勝率 ${(all.win / all.n).toFixed(2)}\n`);
  const rows = Object.entries(sig).map(([k, c]) => ({ 訊號: k, ...fmt(c) }))
    .sort((a, b) => (b.平均5日漲跌 ?? -99) - (a.平均5日漲跌 ?? -99));
  console.table(rows);
  console.log('（比基準高 = 這訊號比較會漲；比基準低 = 該避開）');
}

main().catch((e) => { console.error(e); process.exit(1); });
