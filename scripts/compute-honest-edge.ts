/**
 * 誠實 edge 排行（A0）— 把 strategy-leaderboard.json 的「原始報酬」翻譯成
 * 「扣交易成本 + 比大盤超額」的淨 edge，給每個策略×排序評級 keep/thin/info/avoid。
 *
 * 單一事實：本檔輸出 data/backtest/honest-edge-ranking.json 是後面 A1/A2
 * （edgeRating 顯示層 / 收起無 edge 策略）的依據。
 *
 * ── 方法（v1 近似，刻意「偏寬鬆/偏向策略」）──
 *  - 大盤 beta 基準 = 指數在同視窗的「視窗平均」隔日開盤進場 dN 報酬（^TWII / 000001.SS）。
 *    這是近似：未逐筆對齊每檔 pick 的進場日。偏誤方向＝「對策略有利」（只在強勢日觸發的策略
 *    其 pick 的 beta 高於視窗均值 → 視窗均值低估 beta → 高估策略超額）。
 *    => 結論若連這個寬鬆基準都打不贏大盤，就是穩健的「沒 edge」。標 keep 者才需用
 *       逐日對齊（eventBaseline）的精算版二次確認（A0b，背景重跑）。
 *  - 交易成本 = 來回手續費+稅（lib/portfolio/fees.ts 單一事實）。指數是買入持有不扣成本，
 *    故誠實比較 = (策略 raw − 成本) − 指數 raw = 超額 − 成本。
 *
 * 用法：npx tsx scripts/compute-honest-edge.ts
 */

import fs from 'fs';
import path from 'path';
import { FEE_RATES } from '@/lib/portfolio/fees';

type Market = 'TW' | 'CN';
const INDEX_SYMBOL: Record<Market, string> = { TW: '^TWII', CN: '000001.SS' };
const ROOT = path.join(process.cwd(), 'data');
const LB_PATH = path.join(ROOT, 'backtest', 'strategy-leaderboard.json');
const OUT_JSON = path.join(ROOT, 'backtest', 'honest-edge-ranking.json');
const OUT_MD = path.join(ROOT, 'backtest-output', `honest-edge-${new Date().toISOString().slice(0, 10)}.md`);

// 來回成本（%）：買 + 賣。TW=0.1425%×2+0.3%=0.585%；CN=0.031%×2+0.05%=0.112%
const ROUND_TRIP_PCT: Record<Market, number> = {
  TW: (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100,
  CN: (FEE_RATES.CN.buy + FEE_RATES.CN.sell) * 100,
};

interface RawCandle { date: string; open: number; high: number; low: number; close: number }

function loadCandles(market: Market, symbol: string): RawCandle[] {
  const file = path.join(ROOT, 'candles', market, `${symbol}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : raw.candles ?? [];
  return arr
    .map((c: Record<string, unknown>) => ({
      date: String(c.date ?? '').slice(0, 10),
      open: Number(c.open) || 0, high: Number(c.high) || 0,
      low: Number(c.low) || 0, close: Number(c.close) || 0,
    }))
    .filter((c: RawCandle) => c.date)
    .sort((a: RawCandle, b: RawCandle) => a.date.localeCompare(b.date));
}

/** 指數在 [start,end] 視窗的「視窗平均」隔日開盤進場 dN(close) 報酬（%），對齊 unifiedLeaderboard 口徑。 */
function indexAvgForward(candles: RawCandle[], start: string, end: string): Record<'d1' | 'd3' | 'd5', number> {
  const off = { d1: 1, d3: 3, d5: 5 } as const;
  const acc: Record<'d1' | 'd3' | 'd5', number[]> = { d1: [], d3: [], d5: [] };
  for (let t0 = 0; t0 < candles.length; t0++) {
    const d = candles[t0].date;
    if (d < start || d > end) continue;
    const entry = candles[t0 + 1];
    if (!entry || !(entry.open > 0)) continue;
    for (const h of ['d1', 'd3', 'd5'] as const) {
      const c = candles[t0 + off[h]];
      if (c && c.close > 0) acc[h].push((c.close - entry.open) / entry.open * 100);
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return { d1: +mean(acc.d1).toFixed(2), d3: +mean(acc.d3).toFixed(2), d5: +mean(acc.d5).toFixed(2) };
}

type Grade = 'keep' | 'thin' | 'info' | 'avoid';

function gradeOf(netEdgeD5: number, nTop1: number): { grade: Grade; note: string } {
  // 低樣本（top1 n<60）一律不給 keep（小樣本=偽優勢，smartmoney 教訓）
  const lowN = nTop1 < 60;
  if (netEdgeD5 >= 0.3 && !lowN) return { grade: 'keep', note: `扣成本後 d5 淨超額 +${netEdgeD5.toFixed(2)}%（寬鬆基準，需精算二確）` };
  if (netEdgeD5 >= 0) return { grade: 'thin', note: `扣成本後幾乎打平大盤（+${netEdgeD5.toFixed(2)}%${lowN ? '、樣本偏少' : ''}）` };
  if (netEdgeD5 >= -0.5) return { grade: 'info', note: `扣成本後輸大盤 ${netEdgeD5.toFixed(2)}%，當資訊看別當買訊` };
  return { grade: 'avoid', note: `扣成本後顯著輸大盤 ${netEdgeD5.toFixed(2)}%` };
}

function main(): void {
  const lb = JSON.parse(fs.readFileSync(LB_PATH, 'utf-8'));
  const perMkt = lb.perMarketWindow ?? {};
  const idxAvg: Record<Market, Record<'d1' | 'd3' | 'd5', number>> = {} as any;
  for (const mkt of ['TW', 'CN'] as Market[]) {
    const w = perMkt[mkt] ?? { start: lb.window.start, end: lb.window.end };
    idxAvg[mkt] = indexAvgForward(loadCandles(mkt, INDEX_SYMBOL[mkt]), w.start, w.end);
    console.log(`  ${mkt} 指數視窗均報酬：d1=${idxAvg[mkt].d1}% d3=${idxAvg[mkt].d3}% d5=${idxAvg[mkt].d5}%（${w.start}~${w.end}）`);
  }

  const rows = (lb.rows as any[]).map((r) => {
    const mkt = r.market as Market;
    const cost = ROUND_TRIP_PCT[mkt];
    const h = r.byHorizon;
    const top1D5 = h.d5.top1.avgPct, cohD5 = h.d5.cohort.avgPct;
    const nTop1 = h.d5.top1.n ?? 0, nCoh = h.d5.cohort.n ?? 0;
    // 超額 = 策略 raw − 指數 raw；淨 edge = 超額 − 來回成本
    const excessTop1D5 = +(top1D5 - idxAvg[mkt].d5).toFixed(2);
    const excessCohD5 = +(cohD5 - idxAvg[mkt].d5).toFixed(2);
    const netTop1D5 = +(excessTop1D5 - cost).toFixed(2);
    const netCohD5 = +(excessCohD5 - cost).toFixed(2);
    const { grade, note } = gradeOf(netTop1D5, nTop1);
    return {
      id: r.id, market: mkt, engine: r.engine, strategyId: r.strategyId,
      strategyLabel: r.strategyLabel, sortLabel: r.sortLabel, track: r.track ?? null,
      days: r.days, nTop1, nCohort: nCoh,
      raw: { top1D5, cohortD5: cohD5, sortAlphaD5: h.d5.sortAlphaPct, top1WinPct: h.d5.top1.winRatePct },
      excess: { top1D5: excessTop1D5, cohortD5: excessCohD5 },
      netEdge: { top1D5: netTop1D5, cohortD5: netCohD5 },
      grade, honestNote: note,
    };
  });

  rows.sort((a, b) => b.netEdge.top1D5 - a.netEdge.top1D5);

  const counts = { keep: 0, thin: 0, info: 0, avoid: 0 };
  for (const r of rows) counts[r.grade as Grade]++;

  // ── 策略「家族」去重彙整（A2 收納/保留以家族為顆粒度，避免「同策略×多排序」灌水）──
  // 家族評級門檻刻意比 row 嚴：keep 需 best 淨edge ≥ +0.5% 且 best 樣本 ≥ 100。
  const famMap = new Map<string, {
    market: Market; strategyId: string; strategyLabel: string; engine: string; track: string | null;
    bestNetD5: number; bestSort: string; maxN: number; sortVariants: number;
  }>();
  for (const r of rows) {
    const key = `${r.market}:${r.strategyId}`;
    const cur = famMap.get(key);
    if (!cur) {
      famMap.set(key, {
        market: r.market, strategyId: r.strategyId, strategyLabel: r.strategyLabel,
        engine: r.engine, track: r.track,
        bestNetD5: r.netEdge.top1D5, bestSort: r.sortLabel, maxN: r.nTop1, sortVariants: 1,
      });
    } else {
      cur.sortVariants++;
      cur.maxN = Math.max(cur.maxN, r.nTop1);
      if (r.netEdge.top1D5 > cur.bestNetD5) { cur.bestNetD5 = r.netEdge.top1D5; cur.bestSort = r.sortLabel; }
    }
  }
  const familyGrade = (net: number, n: number): Grade =>
    (net >= 0.5 && n >= 100) ? 'keep' : net >= 0 ? 'thin' : net >= -0.5 ? 'info' : 'avoid';
  const families = [...famMap.values()]
    .map((f) => ({ ...f, grade: familyGrade(f.bestNetD5, f.maxN) }))
    .sort((a, b) => b.bestNetD5 - a.bestNetD5);
  const famCounts = { keep: 0, thin: 0, info: 0, avoid: 0 };
  for (const f of families) famCounts[f.grade]++;

  const doc = {
    generatedAt: new Date().toISOString(),
    sourceLeaderboard: 'data/backtest/strategy-leaderboard.json',
    method: 'window-average-index-baseline (近似, 偏向策略寬鬆); netEdge = (策略 raw d5 − 指數視窗均 d5) − 來回成本',
    costRoundTripPct: ROUND_TRIP_PCT,
    indexAvgForwardPct: idxAvg,
    window: lb.window,
    perMarketWindow: perMkt,
    caveats: [
      '指數基準用視窗平均、非逐筆對齊進場日 → 偏向策略（高估超額）；標 keep 者需 eventBaseline 精算二確。',
      '本地 K 無下市股 → 存活偏差、偏樂觀（與 leaderboard 同）。',
      '單一 2 年多頭視窗，空頭韌性未測。',
      'netEdge 基於 top1（每天只買最強 1 檔）；勝率多 <50%，靠右尾大贏不靠命中率。',
    ],
    counts,
    familyCounts: famCounts,
    families,
    rows,
  };
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2));

  // Markdown 摘要
  const L: string[] = [];
  L.push('# 誠實 edge 排行（扣成本 + 比大盤）');
  L.push('');
  L.push(`產出：${doc.generatedAt}　視窗：${lb.window.start} ~ ${lb.window.end}`);
  L.push(`成本(來回%)：TW ${ROUND_TRIP_PCT.TW.toFixed(3)} / CN ${ROUND_TRIP_PCT.CN.toFixed(3)}`);
  L.push(`指數視窗均 d5：TW +${idxAvg.TW.d5}% / CN +${idxAvg.CN.d5}%`);
  L.push('');
  L.push(`**列評級：keep ${counts.keep}｜thin ${counts.thin}｜info ${counts.info}｜avoid ${counts.avoid}**（共 ${rows.length} 列）`);
  L.push(`**家族評級（去重，門檻嚴）：keep ${famCounts.keep}｜thin ${famCounts.thin}｜info ${famCounts.info}｜avoid ${famCounts.avoid}**（共 ${families.length} 家族）`);
  L.push('');
  L.push('> netEdge = (策略 top1 d5 raw − 指數視窗均 d5) − 來回成本。基準偏寬鬆（對策略有利），連這都贏不了＝穩健沒 edge。');
  L.push('');
  L.push('## 精華候選家族（family keep，去重後最該保留的少數）');
  L.push('');
  L.push('| 市場 | 策略 | 最佳排序 | best 淨edge d5 | 樣本 | 排序變體數 |');
  L.push('|---|---|---|--:|--:|--:|');
  for (const f of families.filter((x) => x.grade === 'keep')) {
    L.push(`| ${f.market} | ${f.strategyLabel} | ${f.bestSort} | +${f.bestNetD5.toFixed(2)} | ${f.maxN} | ${f.sortVariants} |`);
  }
  L.push('');
  for (const mkt of ['TW', 'CN'] as Market[]) {
    const mr = rows.filter((r) => r.market === mkt && r.nTop1 >= 30);
    L.push(`## ${mkt}（top1 樣本 ≥30，依淨 edge 排序，前 15）`);
    L.push('');
    L.push('| 策略 | 排序 | 天數 | top1 n | raw d5 | 超額 d5 | **淨edge d5** | 勝率 | 評級 |');
    L.push('|---|---|--:|--:|--:|--:|--:|--:|:--|');
    for (const r of mr.slice(0, 15)) {
      const sg = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
      L.push(`| ${r.strategyLabel} | ${r.sortLabel} | ${r.days} | ${r.nTop1} | ${sg(r.raw.top1D5)} | ${sg(r.excess.top1D5)} | **${sg(r.netEdge.top1D5)}** | ${r.raw.top1WinPct}% | ${r.grade} |`);
    }
    L.push('');
  }
  fs.writeFileSync(OUT_MD, L.join('\n'));

  console.log(`\n  列評級：keep ${counts.keep}｜thin ${counts.thin}｜info ${counts.info}｜avoid ${counts.avoid}（共 ${rows.length} 列）`);
  console.log(`  家族評級（去重嚴門檻）：keep ${famCounts.keep}｜thin ${famCounts.thin}｜info ${famCounts.info}｜avoid ${famCounts.avoid}（共 ${families.length} 家族）`);
  console.log('\n  ── 精華候選家族（family keep）──');
  families.filter((f) => f.grade === 'keep').forEach((f, i) => {
    console.log(`  ${i + 1}. [${f.market}] ${f.strategyLabel} × ${f.bestSort} | n=${f.maxN} | best 淨 +${f.bestNetD5.toFixed(2)}`);
  });
  console.log('\n  ── 淨 edge top1 d5 排行 top 10（樣本≥30）──');
  rows.filter((r) => r.nTop1 >= 30).slice(0, 10).forEach((r, i) => {
    const sg = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);
    console.log(`  ${i + 1}. [${r.market}] ${r.strategyLabel} × ${r.sortLabel} | n=${r.nTop1} | raw ${sg(r.raw.top1D5)} 超額 ${sg(r.excess.top1D5)} 淨 ${sg(r.netEdge.top1D5)} | ${r.grade}`);
  });
  console.log(`\n  ✓ 寫出 ${path.relative(process.cwd(), OUT_JSON)}`);
  console.log(`         ${path.relative(process.cwd(), OUT_MD)}`);
}

main();
