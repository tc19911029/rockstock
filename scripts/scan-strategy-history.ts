// ============================================================
// 三色具名策略 — 歷史數據（重讀現成每日快照，不重跑掃描）
//
// 對 data/{tw,cn}-sanse-scan/{date}.json 既有快照，逐日把每個具名策略（lib/cn-sanse/namedStrategies）
// 的命中股票挑出來，用 analyzeForwardBatch + metricsFromOpen 算隔日開進場的 d3/d5/d10/d20/maxGain，
// 固化「每日命中名單」+「各策略全期統計」+ 可讀 markdown。
//
// 用法：npx tsx scripts/scan-strategy-history.ts [TW|CN] [days=全部]
//   forward 取本地 K 線；最近 ~20 個交易日 forward 窗未滿 → 長天期報酬為 null（統計自動略過）。
// ============================================================

import { promises as fs } from 'fs';
import path from 'path';
import { NAMED_STRATEGIES } from '@/lib/cn-sanse/namedStrategies';
import { metricsFromOpen } from '@/lib/cn-sanse/forwardMetrics';
import { analyzeForwardBatch } from '@/lib/backtest/ForwardAnalyzer';
import { loadTwSanSeScan, listTwSanSeDates } from '@/lib/tw-sanse/scanStorage';
import { loadSanSeScan, listSanSeDates } from '@/lib/cn-sanse/scanStorage';
import type { HKey } from '@/lib/cn-sanse/rankingScore';

type Market = 'TW' | 'CN';
const HS: HKey[] = ['d3Return', 'd5Return', 'd10Return', 'd20Return', 'maxGain'];
const HLABEL: Record<string, string> = { d3Return: 'd3', d5Return: 'd5', d10Return: 'd10', d20Return: 'd20', maxGain: '途中最高' };

interface Hit {
  date: string; symbol: string; name: string; price: number; changePct: number;
  grade?: string; metrics: Record<HKey, number | null>;
}

const median = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const winp = (a: number[]): number | null => (a.length ? (a.filter((x) => x > 0).length / a.length) * 100 : null);
const f2 = (v: number | null) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%');
const f1 = (v: number | null) => (v == null ? '—' : v.toFixed(1) + '%');

async function main() {
  const market = ((process.argv[2] ?? 'TW').toUpperCase()) as Market;
  if (market !== 'TW' && market !== 'CN') throw new Error('market 只能 TW 或 CN');
  const daysArg = parseInt(process.argv[3] ?? '', 10);

  const listDates = market === 'TW' ? listTwSanSeDates : listSanSeDates;
  const loadScan = market === 'TW' ? loadTwSanSeScan : loadSanSeScan;
  const tag = market === 'TW' ? 'tw' : 'cn';

  let dates = (await listDates()).map((d) => d.date).sort();
  if (Number.isFinite(daysArg) && daysArg > 0) dates = dates.slice(-daysArg);
  console.log(`[strategy-history] ${market}｜${dates.length} 個掃描日（${dates[0]} ~ ${dates[dates.length - 1]}）`);

  const outDayDir = path.join(process.cwd(), 'data', `${tag}-sanse-strategy`);
  const outStatDir = path.join(process.cwd(), 'data', 'strategy-stats');
  await fs.mkdir(outDayDir, { recursive: true });
  await fs.mkdir(outStatDir, { recursive: true });

  // 各策略累計樣本（forward 報酬）
  const acc: Record<string, Record<HKey, number[]>> = {};
  for (const s of NAMED_STRATEGIES) acc[s.id] = Object.fromEntries(HS.map((h) => [h, []])) as Record<HKey, number[]>;
  const totalHits: Record<string, number> = Object.fromEntries(NAMED_STRATEGIES.map((s) => [s.id, 0]));

  for (const date of dates) {
    const scan = await loadScan(date);
    if (!scan || !scan.records?.length) { console.log(`  ${date} 無 records，略過`); continue; }

    // 各策略命中
    const perStrat: Record<string, typeof scan.records> = {};
    const unionSyms = new Map<string, { symbol: string; name: string; scanPrice: number }>();
    for (const s of NAMED_STRATEGIES) {
      const hits = scan.records.filter((r) => s.match(r.report));
      perStrat[s.id] = hits;
      totalHits[s.id] += hits.length;
      for (const r of hits) unionSyms.set(r.symbol, { symbol: r.symbol, name: r.name, scanPrice: r.price });
    }
    if (unionSyms.size === 0) { console.log(`  ${date} 0 命中`); continue; }

    // 一次抓 union 的 forward（避免重複），再分配給各策略
    // 歷史統計必須可重現：只用本地已驗證 K 線，並封頂在本批最後掃描日，
    // 避免資料尚未落盤的「今天」讓每檔誤觸發外部 API 補抓。
    const { results } = await analyzeForwardBatch([...unionSyms.values()], date, {
      localOnly: true,
      dataEndDate: dates.at(-1),
    });
    const perfMap = new Map(results.map((p) => [p.symbol, p]));

    const dayOut: Record<string, Hit[]> = {};
    for (const s of NAMED_STRATEGIES) {
      const hits: Hit[] = perStrat[s.id].map((r) => {
        const m = metricsFromOpen(perfMap.get(r.symbol));
        for (const h of HS) if (m[h] != null) acc[s.id][h].push(m[h] as number);
        return { date, symbol: r.symbol, name: r.name, price: r.price, changePct: r.changePct, grade: r.report.combo?.grade, metrics: m };
      });
      dayOut[s.id] = hits;
    }
    await fs.writeFile(path.join(outDayDir, `${date}.json`), JSON.stringify({ date, market, strategies: dayOut }), 'utf8');
    const cnt = NAMED_STRATEGIES.map((s) => `${s.label} ${perStrat[s.id].length}`).join('｜');
    console.log(`  ${date}：${cnt}`);
  }

  // 全期統計
  const stats = NAMED_STRATEGIES.map((s) => ({
    id: s.id, label: s.label, totalHits: totalHits[s.id],
    metrics: Object.fromEntries(HS.map((h) => {
      const xs = acc[s.id][h];
      return [h, { n: xs.length, win: winp(xs), mean: mean(xs), median: median(xs) }];
    })),
  }));
  await fs.writeFile(path.join(outStatDir, `${tag}-strategy-stats.json`), JSON.stringify({ market, dates: { from: dates[0], to: dates[dates.length - 1], count: dates.length }, stats }, null, 2), 'utf8');

  // markdown 表
  const L: string[] = [];
  L.push(`# 三色具名策略 — ${market === 'TW' ? '台股' : '陸股'}歷史統計（${dates[0]} ~ ${dates[dates.length - 1]}，${dates.length} 個掃描日）`);
  L.push('');
  L.push('> 隔日開盤進場、漲停買不到剔除。最近 ~20 日 forward 窗未滿、長天期樣本較少。三色為自創因子（鐵則 #5），僅輔助看盤。');
  L.push('');
  L.push(`| 策略 | 累計命中 | d5 勝率 | 平均d3 | 平均d5 | 平均d10 | 平均d20 | 平均最高 | 中位d5 |`);
  L.push(`|---|--:|--:|--:|--:|--:|--:|--:|--:|`);
  for (const st of stats) {
    const m = st.metrics as Record<string, { n: number; win: number | null; mean: number | null; median: number | null }>;
    L.push(`| ${st.label} | ${st.totalHits} | ${f1(m.d5Return.win)} (n${m.d5Return.n}) | ${f2(m.d3Return.mean)} | ${f2(m.d5Return.mean)} | ${f2(m.d10Return.mean)} | ${f2(m.d20Return.mean)} | ${f2(m.maxGain.mean)} | ${f2(m.d5Return.median)} |`);
  }
  L.push('');
  await fs.writeFile(path.join(outStatDir, `${tag}-strategy-summary.md`), L.join('\n'), 'utf8');

  console.log(`\n[strategy-history] 已寫 → data/${tag}-sanse-strategy/{date}.json、data/strategy-stats/${tag}-strategy-{stats.json,summary.md}`);
  console.log('\n' + L.join('\n'));
}
main().catch((e) => { console.error(e); process.exit(1); });
