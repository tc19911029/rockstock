// ============================================================
// 校準台股捕撈季節 4 級彩柱門檻（周轉率）。
//
// 方法：百分位對齊。
//   1. 取一批陸股，算各日 X11(EMA13 換手率) 在 baseOK 日的分佈 → 求陸股原碼門檻
//      [6.1, 3.8, 2.1, 1.8] 落在陸股分佈的百分位。
//   2. 取一批台股，算同式 X11(EMA13 周轉率) 在 baseOK 日的分佈 → 取「相同百分位」對應的台股值。
//   結果即為台股應使用的 4 級門檻（讓彩柱在台股的稀密程度與陸股相當）。
//
// baseOK 與 computeSanSeChart 內完全一致：X10>5(偏離成本) && XYS1>0(動能) && 數值有效。
//
// 用法：npx tsx scripts/calibrate-tw-season-tiers.ts
// ============================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EMA, REF } from '@/lib/cn-sanse/tdx';
import { fetchDayExtras } from '@/lib/cn-sanse/cnDayExtras';
import { fetchTwDayExtras } from '@/lib/cn-sanse/twDayExtras';
import { CN_TIER_THRESHOLDS } from '@/lib/cn-sanse/indicators';
import type { Candle } from '@/types';

const CN_DIR = path.join(process.cwd(), 'data/candles/CN');
const TW_DIR = path.join(process.cwd(), 'data/candles/TW');
const CN_SAMPLE = 35;
const TW_SAMPLE = 60;

async function loadCandles(dir: string, file: string): Promise<Candle[] | null> {
  try {
    const raw = await fs.readFile(path.join(dir, file), 'utf8');
    const c = JSON.parse(raw)?.candles as Candle[];
    return Array.isArray(c) && c.length >= 200 ? c : null;
  } catch { return null; }
}

/** 回傳該股 baseOK 日的 X11(EMA13 換手率/周轉率) 值集合 */
function x11OnBaseOK(candles: Candle[], extras: { amount: number[]; vol: number[]; turnover: number[] }): number[] {
  const C = candles.map((c) => c.close);
  const H = candles.map((c) => c.high);
  const L = candles.map((c) => c.low);
  const n = candles.length;
  const X1 = C.map((c, i) => (2 * c + H[i] + L[i]) / 3);
  const X4 = EMA(EMA(EMA(X1, 3), 3), 3);
  const rX4 = REF(X4, 1);
  const XYS1 = X4.map((v, i) => (rX4[i] ? ((v - rX4[i]) / rX4[i]) * 100 : NaN));
  const X8 = EMA(extras.amount, 13);
  const X7 = EMA(extras.vol, 13);
  const X9 = X8.map((v, i) => (X7[i] ? v / X7[i] / 100 : NaN));
  const X10 = C.map((c, i) => (X9[i] ? ((c - X9[i]) / X9[i]) * 100 : NaN));
  const X11 = EMA(extras.turnover, 13);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (Number.isFinite(X10[k]) && Number.isFinite(X11[k]) && X10[k] > 5 && XYS1[k] > 0) out.push(X11[k]);
  }
  return out;
}

const quantile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};
const pctlOf = (sorted: number[], v: number): number => {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return lo / sorted.length;
};

async function pool(label: string, items: { file: string; dir: string; cn: boolean }[]): Promise<number[]> {
  const acc: number[] = [];
  let ok = 0, fail = 0;
  for (const { file, dir, cn } of items) {
    const candles = await loadCandles(dir, file);
    if (!candles) { fail++; continue; }
    const symbol = file.replace(/\.json$/, '');
    try {
      let extras;
      if (cn) {
        const m = await fetchDayExtras(symbol);
        if (!m.size) { fail++; continue; }
        extras = {
          amount: candles.map((c) => m.get(c.date)?.amount ?? NaN),
          vol: candles.map((c) => m.get(c.date)?.vol ?? NaN),
          turnover: candles.map((c) => m.get(c.date)?.turnover ?? NaN),
        };
      } else {
        extras = await fetchTwDayExtras(symbol, candles);
        if (!extras) { fail++; continue; }
      }
      const vals = x11OnBaseOK(candles, extras);
      acc.push(...vals);
      ok++;
      if (ok % 10 === 0) console.log(`  [${label}] ${ok} stocks, ${acc.length} baseOK points...`);
    } catch { fail++; }
  }
  console.log(`  [${label}] done: ${ok} ok / ${fail} fail, ${acc.length} total points`);
  return acc.filter(Number.isFinite).sort((a, b) => a - b);
}

(async () => {
  // ── 陸股樣本（cn_stocklist 前段有本地 K 線者）──
  const cnList = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data/cn_stocklist.json'), 'utf8'))
    .stocks.map((s: { symbol: string }) => s.symbol) as string[];
  const cnFiles: { file: string; dir: string; cn: boolean }[] = [];
  for (const sym of cnList) {
    if (cnFiles.length >= CN_SAMPLE) break;
    try { await fs.access(path.join(CN_DIR, `${sym}.json`)); cnFiles.push({ file: `${sym}.json`, dir: CN_DIR, cn: true }); } catch { /* skip */ }
  }

  // ── 台股樣本：知名大型股 + 隨機 4 位數本地檔（涵蓋大中小型）──
  const liquid = ['2330', '2317', '2454', '2308', '2382', '2412', '2882', '1301', '2002', '3008',
    '2603', '2609', '3037', '6505', '1216', '2891', '2884', '2357', '4938', '2376', '1101', '2207',
    '2327', '2379', '2345', '3045', '2392', '3231', '6669', '3661'];
  const twDirFiles = (await fs.readdir(TW_DIR)).filter((f) => /^\d{4}\.TW\.json$/.test(f));
  const twSet = new Set<string>();
  for (const code of liquid) if (twDirFiles.includes(`${code}.TW.json`)) twSet.add(`${code}.TW.json`);
  for (let i = 0; i < twDirFiles.length && twSet.size < TW_SAMPLE; i += Math.max(1, Math.floor(twDirFiles.length / TW_SAMPLE))) {
    twSet.add(twDirFiles[i]);
  }
  const twFiles = [...twSet].slice(0, TW_SAMPLE).map((file) => ({ file, dir: TW_DIR, cn: false }));

  console.log(`抽樣：CN ${cnFiles.length} 檔 / TW ${twFiles.length} 檔\n`);
  console.log('拉陸股換手率分佈...');
  const cnPool = await pool('CN', cnFiles);
  console.log('\n拉台股周轉率分佈...');
  const twPool = await pool('TW', twFiles);

  console.log('\n════════ 校準結果 ════════');
  const names = ['green', 'yellow', 'cyan', 'blue'];
  const twThr = CN_TIER_THRESHOLDS.map((cnThr, i) => {
    const p = pctlOf(cnPool, cnThr);
    const tw = quantile(twPool, p);
    console.log(`${names[i].padEnd(7)} CN=${cnThr}  → 百分位 ${(p * 100).toFixed(1)}%  → TW=${tw.toFixed(3)}`);
    return +tw.toFixed(2);
  });
  console.log('\nTW_TIER_THRESHOLDS =', JSON.stringify(twThr));
  console.log(`\n陸股分佈 中位數=${quantile(cnPool, 0.5).toFixed(2)}  90%=${quantile(cnPool, 0.9).toFixed(2)}`);
  console.log(`台股分佈 中位數=${quantile(twPool, 0.5).toFixed(2)}  90%=${quantile(twPool, 0.9).toFixed(2)}`);
})().catch((e) => { console.error(e); process.exit(1); });
