/**
 * C13 研究專用回測（進場-2 + 賠少-7）— 研究區，絕不動生產線
 * =============================================================================
 * 本檔只在 scripts/ 內，**不改任何 production isCoreReady / gate / 排序**。
 * 直接呼叫生產 `evaluateSixConditions`（位元相同的判定），只在「對照組層」
 * 加上第⑥條 gate / 爆量黑K分級，量 train/test 前瞻報酬，看有沒有真 edge。
 *
 * ── 進場-2：第⑥指標納 gate（6 條全齊 vs 現行 5 條）──
 *   現行生產：isCoreReady = 前5條全過（第⑥ KD/MACD 只加分）。
 *   對照組   ：6 條全齊 = isCoreReady && indicator.pass。
 *   問題：收緊到 6 條，候選數砍多少？勝率/淨超額有沒有變好？train/test 一致嗎？
 *
 * ── 賠少-7：高檔爆天量+長黑分級（≥2× 警示 / ≥5× 強訊）──
 *   現行生產 hasBlowoffBlackReversal 寫死「今量 ≥ 前日 ×3 + 長黑」，且不要求高檔位置。
 *   對照組：分 2×/3×/5× 三檔 + 「有無高檔前置(MA20 乖離>5%)」對照，
 *   量「訊號出現後」前瞻報酬（避雷：報酬越負＝該訊號越該躲）。口徑參照 Wave1。
 *
 * 進場法（與 factor-grid-search / unifiedLeaderboard 對齊）：
 *   隔日開盤進場、持有 d1/d5/d20、超額對 ^TWII（同日曆窗）、每週取成交額 top-500 液態股、
 *   時間中位數切 train/test。raw 報酬不當 alpha，只看「淨超額(扣來回成本)」+ train/test 一致。
 *
 * 用法：npx tsx scripts/backtest-sixth-condition-gate.ts
 *       npx tsx scripts/backtest-sixth-condition-gate.ts --quick   (只跑 ~250 檔抽樣，~2 分鐘冒煙)
 */
import { promises as fs } from 'fs';
import path from 'path';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { ZHU_PURE_BOOK } from '@/lib/strategy/StrategyConfig';
import { FEE_RATES } from '@/lib/portfolio/fees';
import type { Candle } from '@/types';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2024-07-20';
const thresholds = ZHU_PURE_BOOK.thresholds;
// 來回成本（%）：TW 手續費 ×2 + 證交稅
const TW_ROUND_TRIP = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100;

const QUICK = process.argv.includes('--quick');

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }

/** 一筆「訊號日」樣本：對應某檔某日，攜帶前瞻超額報酬 + 各對照旗標 */
interface Sample {
  date: string;
  iso: string;
  turnover: number;
  // 前瞻超額（%）：個股 dN 報酬 − ^TWII 同窗報酬
  exD1: number; exD5: number; exD20: number;
  // 進場-2 旗標
  core5: boolean;        // 現行生產 gate（前5條）
  sixth: boolean;        // 第⑥條 pass（indicator.pass）
  // 賠少-7 旗標（爆量黑K分級 + 高檔前置）
  black: boolean;        // 今日長黑（實體 ≥2%）
  volX: number;          // 今量 / 前日量
  highPos: boolean;      // 高檔前置：MA20 乖離 > 5%（急漲末段近似）
}

async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) {
  const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return dt.getUTCFullYear() + '-' + String(Math.round((dt.getTime() - f.getTime()) / 6048e5)).padStart(2, '0');
}

interface Agg { ex1: number; ex5: number; ex20: number; win5: number; n: number }
function agg(rows: Sample[]): Agg {
  if (rows.length === 0) return { ex1: 0, ex5: 0, ex20: 0, win5: 0, n: 0 };
  const m = (f: (r: Sample) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return {
    ex1: m(r => r.exD1), ex5: m(r => r.exD5), ex20: m(r => r.exD20),
    win5: 100 * rows.filter(r => r.exD5 > 0).length / rows.length, n: rows.length,
  };
}
const sg = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(2);

async function main() {
  const t0 = Date.now();
  const twii: OHLC[] = (await readJ(path.join(C, '^TWII.json'))).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string) => { let lo = 0, hi = td.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (td[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };

  let files = (await fs.readdir(C)).filter(f => /\.TW\.json$/.test(f) && !f.startsWith('^'));
  if (QUICK) files = files.filter((_, i) => i % 4 === 0).slice(0, 250);
  console.log(`掃 ${files.length} 檔 TW（${QUICK ? 'quick 抽樣' : '全部'}）...`);

  const all: Sample[] = [];
  let done = 0;
  for (const f of files) {
    done++;
    if (done % 200 === 0) console.log(`  ...${done}/${files.length}`);
    const cdl = await readJ(path.join(C, f));
    if (!cdl) continue;
    const raw: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0 && c.open > 0);
    if (raw.length < 90) continue;
    const cs = computeIndicators(raw as Candle[]);

    for (let t = 60; t + 1 + 20 < cs.length; t++) {
      const day = cs[t].date.slice(0, 10);
      if (day < FROM) continue;
      const entry = cs[t + 1];
      if (!(entry.open > 0)) continue;

      // 前瞻超額（隔日開盤進場，持有 dN close）
      const fwd = (off: number) => {
        const c = cs[Math.min(t + 1 + off, cs.length - 1)];
        if (!c || !(c.close > 0)) return null;
        const ret = (c.close / entry.open - 1) * 100;
        if (Math.abs(ret) > 80) return null;
        const e = twAt(entry.date.slice(0, 10)), x = twAt(c.date.slice(0, 10));
        const mkt = (e >= 0 && x >= 0 && twii[e].close > 0) ? (twii[x].close / twii[e].close - 1) * 100 : 0;
        return ret - mkt;
      };
      const ex1 = fwd(1), ex5 = fwd(5), ex20 = fwd(20);
      if (ex1 == null || ex5 == null || ex20 == null) continue;

      // 生產六條件（位元相同）
      const six = evaluateSixConditions(cs, t, thresholds);

      // 賠少-7：長黑 + 爆量倍數 + 高檔前置
      const c = cs[t], prev = cs[t - 1];
      const body = c.open > 0 ? Math.abs(c.close - c.open) / c.open : 0;
      const isBlack = c.close < c.open && body >= 0.02;
      const volX = prev && prev.volume > 0 ? c.volume / prev.volume : 0;
      const ma20 = c.ma20;
      const highPos = ma20 != null && ma20 > 0 && (c.close - ma20) / ma20 > 0.05;

      all.push({
        date: day, iso: isoWeek(day),
        turnover: c.close * (c.volume || 0),
        exD1: ex1, exD5: ex5, exD20: ex20,
        core5: six.isCoreReady,
        sixth: six.indicator.pass,
        black: isBlack, volX, highPos,
      });
    }
  }

  // 每週取成交額 top-500 液態股（與 factor-grid-search / universe top-N 對齊）
  const byW = new Map<string, Sample[]>();
  for (const r of all) { const a = byW.get(r.iso) ?? []; if (a.length === 0) byW.set(r.iso, a); a.push(r); }
  const liq: Sample[] = [];
  for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (liq.length === 0) { console.error('無樣本'); process.exit(1); }
  const mid = liq[Math.floor(liq.length / 2)].date;
  const train = liq.filter(r => r.date < mid), test = liq.filter(r => r.date >= mid);

  const baseAll = agg(liq), baseTr = agg(train), baseTe = agg(test);
  console.log(`\n液態樣本 ${liq.length} 筆 | train ${train.length}(${liq[0].date}~) | test ${test.length}(${mid}~${liq[liq.length - 1].date})`);
  console.log(`全體基準前瞻超額：d1 ${sg(baseAll.ex1)}% d5 ${sg(baseAll.ex5)}% d20 ${sg(baseAll.ex20)}% | 來回成本 ${TW_ROUND_TRIP.toFixed(3)}%`);

  // ───────────────────────── 進場-2：5 條 vs 6 條 ─────────────────────────
  console.log('\n================ 進場-2：第⑥條納 gate（5 條 vs 6 條）================');
  const fmt = (label: string, trA: Agg, teA: Agg, allA: Agg) => {
    const netTe5 = teA.ex5 - TW_ROUND_TRIP;
    console.log(`  ${label}`);
    console.log(`     候選數：all ${allA.n} | train ${trA.n} | test ${teA.n}`);
    console.log(`     train  d1 ${sg(trA.ex1)} d5 ${sg(trA.ex5)} d20 ${sg(trA.ex20)}  勝率(d5) ${trA.win5.toFixed(1)}%`);
    console.log(`     test   d1 ${sg(teA.ex1)} d5 ${sg(teA.ex5)} d20 ${sg(teA.ex20)}  勝率(d5) ${teA.win5.toFixed(1)}%`);
    console.log(`     淨超額(test d5 扣成本) ${sg(netTe5)}%`);
  };
  const c5 = liq.filter(r => r.core5);
  const c6 = liq.filter(r => r.core5 && r.sixth);
  fmt('現行生產【5 條 isCoreReady】', agg(train.filter(r => r.core5)), agg(test.filter(r => r.core5)), agg(c5));
  fmt('對照組【6 條全齊 (5條+第⑥)】', agg(train.filter(r => r.core5 && r.sixth)), agg(test.filter(r => r.core5 && r.sixth)), agg(c6));

  // 收緊比例 + 增量分析：被第⑥條剔掉的那批（5條過但第⑥不過）報酬如何？
  const droppedTr = train.filter(r => r.core5 && !r.sixth);
  const droppedTe = test.filter(r => r.core5 && !r.sixth);
  const n5 = c5.length, n6 = c6.length;
  const dropRate = n5 > 0 ? 100 * (n5 - n6) / n5 : 0;
  console.log(`\n  收緊：6 條候選 ${n6} 筆 = 5 條 ${n5} 筆的 ${(100 * n6 / Math.max(1, n5)).toFixed(1)}%（砍掉 ${dropRate.toFixed(1)}%）`);
  console.log(`  被第⑥條剔掉那批（5過/⑥不過）：train d5 ${sg(agg(droppedTr).ex5)}% / test d5 ${sg(agg(droppedTe).ex5)}%（n=${droppedTr.length}/${droppedTe.length}）`);
  const d5gainTr = agg(train.filter(r => r.core5 && r.sixth)).ex5 - agg(train.filter(r => r.core5)).ex5;
  const d5gainTe = agg(test.filter(r => r.core5 && r.sixth)).ex5 - agg(test.filter(r => r.core5)).ex5;
  console.log(`  第⑥條 gate 對 d5 超額的增益：train ${sg(d5gainTr)}pp / test ${sg(d5gainTe)}pp`);
  const verdict62 = (d5gainTr > 0 && d5gainTe > 0)
    ? '✅ 兩段都讓 d5 超額變好 → 值得當研究候選，需精算二確'
    : (d5gainTr <= 0 && d5gainTe <= 0)
      ? '❌ 兩段都沒讓超額變好（只是砍候選） → 維持現行 5 條 gate'
      : '⚠️ train/test 不一致 → 過擬合嫌疑，不進主視圖';
  console.log(`  判讀：${verdict62}`);

  // ───────────────────────── 賠少-7：爆量黑K分級 ─────────────────────────
  console.log('\n================ 賠少-7：高檔爆量長黑分級（避雷：報酬越負越該躲）================');
  const blackTiers: [string, (r: Sample) => boolean][] = [
    ['長黑+量≥2×（警示檔）',           r => r.black && r.volX >= 2],
    ['長黑+量≥3×（現行生產寫死）',     r => r.black && r.volX >= 3],
    ['長黑+量≥5×（強訊檔）',           r => r.black && r.volX >= 5],
    ['長黑+量≥2×+高檔(乖離>5%)',       r => r.black && r.volX >= 2 && r.highPos],
    ['長黑+量≥3×+高檔(乖離>5%)',       r => r.black && r.volX >= 3 && r.highPos],
    ['長黑+量≥5×+高檔(乖離>5%)',       r => r.black && r.volX >= 5 && r.highPos],
  ];
  console.log('  （前瞻超額為負＝訊號後該躲；高檔前置應讓避雷更乾淨）');
  console.log('  分級                              train d5超額/勝  →  test d5超額/勝  (n)');
  for (const [name, pred] of blackTiers) {
    const tr = agg(train.filter(pred)), te = agg(test.filter(pred));
    console.log(`  ${name.padEnd(30)} ${sg(tr.ex5)}%/${tr.win5.toFixed(0)}% → ${sg(te.ex5)}%/${te.win5.toFixed(0)}%  (${tr.n}/${te.n})`);
  }
  // 分級單調性檢查：量越大、是否前瞻越差（test d5）
  const teTier = (pred: (r: Sample) => boolean) => agg(test.filter(pred)).ex5;
  const t2 = teTier(r => r.black && r.volX >= 2 && r.volX < 5);
  const t5 = teTier(r => r.black && r.volX >= 5);
  console.log(`\n  分級單調性(test d5)：2~5× ${sg(t2)}% vs ≥5× ${sg(t5)}%  →  ${t5 < t2 ? '✅ 量越大前瞻越差，分級有意義' : '⚠️ 倍數越大未必越差（與 Wave1「價量避雷常反向」一致，當警示不當硬排除）'}`);
  const tHi = teTier(r => r.black && r.volX >= 3 && r.highPos);
  const tLo = teTier(r => r.black && r.volX >= 3 && !r.highPos);
  console.log(`  高檔前置(test d5, ≥3×)：高檔 ${sg(tHi)}% vs 非高檔 ${sg(tLo)}%  →  ${tHi < tLo ? '✅ 高檔前置讓避雷更乾淨（生產缺此前置，盤整區爆量黑K誤命中）' : '⚠️ 高檔前置沒讓避雷更乾淨'}`);

  console.log(`\n  ⏱ 耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log('  ⚠ 研究專用，未動任何生產 gate / 排序（production_touched=false）。');
}
main().catch(e => { console.error(e); process.exit(1); });
