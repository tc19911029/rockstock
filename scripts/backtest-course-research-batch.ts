/**
 * 批次B 課程研究區綜合回測（2026-07-05 使用者「都做」拍板）
 *
 * ⚠️ RESEARCH-ONLY — 不動生產偵測器；過誠實 edge（train/test 一致）才升級生產。
 *
 * 一次資料掃描回答 5 個進場側問題：
 *  Q1 CH5-05「第二波」（進場-5）：B 回後買上漲 + 強勢第一波前置 是否更強？
 *     課程判準：第一波凌厲（漲停過高/連紅急拉）→ 回檔不破月線 → 大量紅K做第二波。
 *  Q2 盤整四位置分級 gate 化（回測-5）：C 盤整突破按 pos1~4 分桶，
 *     位置④（高檔已漲一倍）是否 robustly 負 →（課程「錢不要賺」）可 gate。
 *  Q3 ma60Slope 均線強度因子（漏網-6）：多頭股按季線斜率五分位，D20 超額有無單調性。
 *  Q4 高檔均線糾結降權（CH3-05）：糾結突破按位置（高檔 vs 低檔）分桶對照。
 *  Q5 末跌段 lowerLowCount≥5 自創判準（回測-20）：末跌段 vs 一般空頭下跌段的
 *     前瞻報酬有無鑑別度（課程語意：末跌段=低檔別追空、接近反轉）。
 *
 * 慣例（對齊 backtest-kline-consol-variants / golden-pullback）：
 *   進場 = T+1 開盤；出場 = T+5/T+20 收盤；淨超額 = 個股 − ^TWII（曆日對齊）− 0.55% 往返成本；
 *   train/test 以觀測日中位切分；桶樣本 <40 不下結論。
 *   宇宙 = 當日成交額 ≥ 5000 萬（張×收盤×1000）。
 *
 * Usage: NODE_OPTIONS="--max-old-space-size=6144" npx tsx scripts/backtest-course-research-batch.ts [--limit=N]
 */

import fs from 'fs';
import path from 'path';
import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectPullbackBuy, detectRangeBreakout, detectMaClusterBreak } from '@/lib/analysis/highWinPositions';
import { detectTrend, detectTrendPosition } from '@/lib/analysis/trendAnalysis';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const COST = 0.55;
const HOLDS = [5, 20] as const;
const MIN_T0 = '2024-07-01';
const MIN_TURNOVER = 50_000_000;

const argLimit = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = argLimit ? parseInt(argLimit.split('=')[1], 10) : Infinity;

interface Hit { date: string; excess: Record<number, number | null>; tags: Record<string, string | boolean> }

function loadRaw(file: string): Candle[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm: Candle[] = arr.map((c: Partial<Candle>) => ({
      date: (c.date ?? '').slice(0, 10),
      open: Number(c.open) || 0, high: Number(c.high) || 0,
      low: Number(c.low) || 0, close: Number(c.close) || 0,
      volume: Number(c.volume) || 0,
    })).filter((c: Candle) => c.date && c.close > 0);
    return norm.length >= 120 ? norm : null;
  } catch { return null; }
}

function excessOf(candles: Candle[], twii: Map<string, number>, idx: number, hold: number): number | null {
  if (idx + hold >= candles.length) return null;
  const t1 = candles[idx + 1]?.open;
  const exit = candles[idx + hold]?.close;
  if (!t1 || t1 <= 0 || !exit) return null;
  const a = twii.get(candles[idx + 1].date);
  const b = twii.get(candles[idx + hold].date);
  if (a == null || b == null || a <= 0) return null;
  return (exit - t1) / t1 * 100 - (b - a) / a * 100 - COST;
}

/** Q1：強勢第一波前置（課程 CH5-05）＋回檔不破月線 */
function firstWaveContext(ci: CandleWithIndicators[], idx: number): { strongFirstWave: boolean; holdsMa20: boolean } {
  const from = Math.max(0, idx - 60);
  let peakIdx = -1, peakHigh = -Infinity;
  for (let j = from; j < idx; j++) if (ci[j].high > peakHigh) { peakHigh = ci[j].high; peakIdx = j; }
  if (peakIdx <= from + 3) return { strongFirstWave: false, holdsMa20: false };
  // 上漲腳起點：峰前 60 根最低 low
  let legLow = Infinity;
  for (let j = Math.max(0, peakIdx - 60); j < peakIdx; j++) if (ci[j].low < legLow) legLow = ci[j].low;
  if (!isFinite(legLow) || legLow <= 0) return { strongFirstWave: false, holdsMa20: false };
  const legGain = peakHigh / legLow - 1;
  // 凌厲：腳內 ≥2 天單日漲 ≥8%（「漲停就過、隔天又漲停」proxy）
  let bigDays = 0;
  for (let j = Math.max(1, peakIdx - 40); j <= peakIdx; j++) {
    if (ci[j - 1].close > 0 && ci[j].close / ci[j - 1].close - 1 >= 0.08) bigDays++;
  }
  // 四線多排 at peak（課程：第一波走完均線早就四線多排）
  const p = ci[peakIdx];
  const fourAlign = p.ma5 != null && p.ma10 != null && p.ma20 != null && p.ma60 != null
    && p.ma5 > p.ma10 && p.ma10 > p.ma20 && p.ma20 > p.ma60;
  const strongFirstWave = legGain >= 0.3 && bigDays >= 2 && fourAlign;
  // 回檔不破月線：峰之後到今日收盤都 ≥ MA20
  let holdsMa20 = true;
  for (let j = peakIdx + 1; j <= idx; j++) {
    if (ci[j].ma20 == null || ci[j].close < ci[j].ma20!) { holdsMa20 = false; break; }
  }
  return { strongFirstWave, holdsMa20 };
}

function mean(a: number[]) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function win(a: number[]) { return a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN; }
const fmt = (x: number) => (isNaN(x) ? '  n/a ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`).padStart(8);

function report(title: string, hits: Hit[], groupFn: (h: Hit) => string, order?: string[]) {
  console.log(`\n━━━ ${title}（n=${hits.length}）━━━`);
  if (!hits.length) return;
  const dates = hits.map(h => h.date).sort();
  const mid = dates[Math.floor(dates.length / 2)];
  for (const [seg, pool] of [['train', hits.filter(h => h.date < mid)], ['test ', hits.filter(h => h.date >= mid)]] as const) {
    console.log(`  [${seg}] 分界 ${mid}`);
    const groups = new Map<string, Hit[]>();
    for (const h of pool) {
      const g = groupFn(h);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(h);
    }
    const keys = order ?? [...groups.keys()].sort();
    console.log('    分桶'.padEnd(30) + 'n'.padStart(7) + 'D5淨超額'.padStart(10) + 'D20淨超額'.padStart(10) + 'D20勝率'.padStart(9));
    for (const k of keys) {
      const rows = groups.get(k) ?? [];
      if (rows.length < 40) { console.log(`    ${k.padEnd(26)}${String(rows.length).padStart(7)}  (樣本<40 不下結論)`); continue; }
      const d5 = rows.map(h => h.excess[5]).filter((x): x is number => x != null);
      const d20 = rows.map(h => h.excess[20]).filter((x): x is number => x != null);
      console.log(`    ${k.padEnd(26)}${String(rows.length).padStart(7)}${fmt(mean(d5))}${fmt(mean(d20))}${win(d20).toFixed(0).padStart(8)}%`);
    }
  }
}

async function main() {
  const twiiRaw = loadRaw(path.join(CANDLE_DIR, '^TWII.json'));
  if (!twiiRaw) throw new Error('^TWII missing');
  const twii = new Map(twiiRaw.map(c => [c.date, c.close]));

  const files = fs.readdirSync(CANDLE_DIR)
    .filter(f => /^\d{4,6}\.(TW|TWO)\.json$/.test(f))
    .slice(0, LIMIT);
  console.log(`宇宙檔數 ${files.length}，區間 ${MIN_T0}~，成交額地板 ${MIN_TURNOVER / 1e8} 億`);

  const q1: Hit[] = [];  // B 回後買上漲 × 第二波前置
  const q2: Hit[] = [];  // C 盤整突破 × pos1-4
  const q3: Hit[] = [];  // 多頭股日 × ma60 斜率五分位
  const q4: Hit[] = [];  // 糾結突破 × 高低檔
  const q5: Hit[] = [];  // 空頭股日 × 末跌段 vs 下跌段
  const q3Raw: { hit: Hit; slope: number }[] = [];

  let done = 0;
  for (const f of files) {
    const raw = loadRaw(path.join(CANDLE_DIR, f));
    if (!raw) continue;
    const ci = computeIndicators(raw);
    for (let idx = 60; idx + 20 < ci.length; idx++) {
      const c = ci[idx];
      if (c.date < MIN_T0) continue;
      if (c.close * c.volume * 1000 < MIN_TURNOVER) continue;

      const mkHit = (tags: Record<string, string | boolean>): Hit => ({
        date: c.date,
        excess: Object.fromEntries(HOLDS.map(h => [h, excessOf(raw, twii, idx, h)])),
        tags,
      });

      // Q1: B 回後買上漲
      if (detectPullbackBuy(ci, idx) != null) {
        const fw = firstWaveContext(ci, idx);
        q1.push(mkHit({ sfw: fw.strongFirstWave, ma20: fw.holdsMa20 }));
      }

      // Q2: C 盤整突破 pos 分級
      const rb = detectRangeBreakout(ci, idx) as ({ positionGrade?: string } | null);
      if (rb != null) q2.push(mkHit({ pos: rb.positionGrade ?? '?' }));

      // Q3/Q5: 趨勢股日觀測（每 2 天取樣 1 次防自相關爆量）
      if (idx % 2 === 0) {
        const trend = detectTrend(ci, idx);
        if (trend === '多頭' && c.ma60 != null && ci[idx - 10]?.ma60 != null && ci[idx - 10].ma60! > 0) {
          const slope = (c.ma60! / ci[idx - 10].ma60! - 1) * 100;
          q3Raw.push({ hit: mkHit({}), slope });
        } else if (trend === '空頭') {
          const pos = detectTrendPosition(ci, idx);
          q5.push(mkHit({ pos: pos === '末跌段(低檔)' ? '末跌段' : pos === '接近支撐區' ? '接近支撐' : '下跌段' }));
        }
      }

      // Q4: 糾結突破 × 位置
      if (detectMaClusterBreak(ci, idx)) {
        const dev20 = c.ma20 != null && c.ma20 > 0 ? (c.close - c.ma20) / c.ma20 : 0;
        let hi120 = -Infinity;
        for (let j = Math.max(0, idx - 120); j < idx; j++) if (ci[j].high > hi120) hi120 = ci[j].high;
        const isHigh = dev20 > 0.10 || (isFinite(hi120) && c.close >= hi120 * 0.95);
        q4.push(mkHit({ zone: isHigh ? '高檔糾結' : '中低檔糾結' }));
      }
    }
    if (++done % 400 === 0) console.log(`  ...${done}/${files.length}`);
  }

  // Q3 五分位（全期斜率排序取分位界）
  const slopes = q3Raw.map(r => r.slope).sort((a, b) => a - b);
  const qtile = (p: number) => slopes[Math.min(slopes.length - 1, Math.floor(p * slopes.length))];
  const [p20, p40, p60, p80] = [qtile(0.2), qtile(0.4), qtile(0.6), qtile(0.8)];
  for (const r of q3Raw) {
    const b = r.slope < p20 ? 'Q1(最平/降)' : r.slope < p40 ? 'Q2' : r.slope < p60 ? 'Q3' : r.slope < p80 ? 'Q4' : 'Q5(最陡)';
    r.hit.tags.q = b;
    q3.push(r.hit);
  }

  report('Q1 B回後買上漲 × 第二波前置（CH5-05）', q1,
    h => h.tags.sfw && h.tags.ma20 ? 'V3 強第一波+不破月線' : h.tags.sfw ? 'V2 只強第一波' : h.tags.ma20 ? 'V1 只不破月線' : 'V0 一般B',
    ['V0 一般B', 'V1 只不破月線', 'V2 只強第一波', 'V3 強第一波+不破月線']);
  report('Q2 C盤整突破 × 四位置分級（回測-5 gate化判定）', q2,
    h => String(h.tags.pos), ['pos1', 'pos2', 'pos3', 'pos4']);
  report('Q3 多頭股日 × MA60 10日斜率五分位（漏網-6）', q3,
    h => String(h.tags.q), ['Q1(最平/降)', 'Q2', 'Q3', 'Q4', 'Q5(最陡)']);
  report('Q4 均線糾結突破 × 位置（CH3-05 高檔降權判定）', q4, h => String(h.tags.zone));
  report('Q5 空頭股日 × 末跌段判準（回測-20）', q5,
    h => String(h.tags.pos), ['下跌段', '接近支撐', '末跌段']);

  console.log('\n判讀：');
  console.log('  Q1 V3 若 train/test 皆穩定高於 V0 → 第二波前置值得做成 B 的加分/變體（仍需 honest-edge 複驗）。');
  console.log('  Q2 pos4 若兩段皆顯著負 → 依課程「錢不要賺」把 pos4 做成 C 的警示/gate。');
  console.log('  Q3 無單調性 → ma60Slope 因子關帳（進研究區記錄）。');
  console.log('  Q4 高檔糾結若兩段皆遜於中低檔 → 顯示層降權標註。');
  console.log('  Q5 末跌段 vs 下跌段無鑑別 → lowerLowCount≥5 自創判準記錄為「無資訊量」。');
}

main().catch(e => { console.error(e); process.exit(1); });
