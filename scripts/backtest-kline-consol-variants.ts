/**
 * C18 回測：K 線橫盤突破門檻（進場-13）+ 假突破過濾（進場-11）變體對照
 *
 * ⚠️ RESEARCH-ONLY — 不動生產偵測器、不改 scan 預設輸出。
 *    生產偵測器位元不變；本腳本對 lib/research/klineConsolidationVariants.ts
 *    的變體 vs 生產 baseline 做隔日開盤前瞻報酬比較，含 train/test 切分 + 大盤淨超額。
 *
 * 字母 K = detectKlineConsolidationBreakout（K 線橫盤突破），本腳本回測它的門檻調整。
 *
 * 進場規則對齊北極星：
 *   - 進場 = 訊號日(T0)次一交易日(T+1)開盤。
 *   - 出場 = T+5 / T+10 收盤。
 *   - 報酬 = (出場 - T+1開盤) / T+1開盤。
 *   - 淨超額 = 個股報酬 − ^TWII 同期報酬（曆日對齊，扣大盤 beta）。
 *   - 成本 = 進出各 0.1425%×折讓 + 賣 0.3% 證交稅，近似往返 ~0.55%（TW）。
 *   - train/test 以 T0 日期中位切分，兩段同號才算穩定。
 *
 * Usage:
 *   NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/backtest-kline-consol-variants.ts
 *   可選參數：--limit=N （只跑前 N 檔，快測用）
 */

import fs from 'fs';
import path from 'path';
import type { Candle, CandleWithIndicators } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectKlineConsolidationBreakout } from '@/lib/analysis/klineConsolidationBreakout';
import {
  detectKlineConsolBreakoutVariant,
  detectFalseBreakout,
  PRODUCTION_BASELINE,
  type KlineConsolVariantOptions,
} from '@/lib/research/klineConsolidationVariants';

// ─────────────────────────────────────────────────────────────────────────
const ROOT = path.join(process.cwd(), 'data');
const CANDLE_DIR = path.join(ROOT, 'candles', 'TW');
const TWII_FILE = path.join(CANDLE_DIR, '^TWII.json');

const ROUND_TRIP_COST_PCT = 0.55;   // TW 往返成本近似（手續費×2 + 證交稅）
const HOLD_DAYS = [5, 10] as const;
const MIN_T0_DATE = '2023-04-13';   // ^TWII benchmark 起點，前面沒大盤對齊

const argLimit = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = argLimit ? parseInt(argLimit.split('=')[1], 10) : Infinity;

// ─────────────────────────────────────────────────────────────────────────
// 載入 candles
// ─────────────────────────────────────────────────────────────────────────
function loadRaw(file: string): Candle[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.candles ?? []);
    const norm: Candle[] = arr
      .map((c: Partial<Candle>) => ({
        date: (c.date ?? '').slice(0, 10),
        open: Number(c.open) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
        close: Number(c.close) || 0,
        volume: Number(c.volume) || 0,
      }))
      .filter((c: Candle) => c.date && c.close > 0);
    return norm.length ? norm : null;
  } catch {
    return null;
  }
}

// ^TWII close by date → 大盤基準
function loadTwiiClose(): Map<string, number> {
  const m = new Map<string, number>();
  const raw = loadRaw(TWII_FILE);
  if (raw) for (const c of raw) m.set(c.date, c.close);
  return m;
}

// ─────────────────────────────────────────────────────────────────────────
// 變體定義
// ─────────────────────────────────────────────────────────────────────────
interface Variant {
  id: string;
  label: string;
  opts: KlineConsolVariantOptions;
  /** 假突破過濾：用 T+1/T+2 黑 K 收盤跌破 1/2 價剔除 */
  falseBreakoutFilter: boolean;
}

const VARIANTS: Variant[] = [
  // baseline（變體版用 PRODUCTION_BASELINE，行為應等於生產 detector — 另有 parity 檢查）
  { id: 'V0_baseline', label: '生產 baseline（min4/僅紅/無加權）', opts: { ...PRODUCTION_BASELINE }, falseBreakoutFilter: false },
  // 進場-13a：橫盤天數 4→3
  { id: 'V1_min3', label: '橫盤≥3 天（書本下限）', opts: { ...PRODUCTION_BASELINE, minConsolDays: 3 }, falseBreakoutFilter: false },
  // 進場-13b：錨點紅黑皆可
  { id: 'V2_anchorBlack', label: '錨點紅黑皆可', opts: { ...PRODUCTION_BASELINE, anchorAllowBlack: true }, falseBreakoutFilter: false },
  // 進場-13c：跳空向上突破量比放寬 8 折
  { id: 'V3_gapRelief', label: '跳空突破量比放寬(×0.8)', opts: { ...PRODUCTION_BASELINE, gapVolRelief: 0.8 }, falseBreakoutFilter: false },
  // 進場-13d：三項全開（min3 + 黑K + 跳空加權）
  { id: 'V4_allLoosen', label: '三項放寬全開', opts: { ...PRODUCTION_BASELINE, minConsolDays: 3, anchorAllowBlack: true, gapVolRelief: 0.8 }, falseBreakoutFilter: false },
  // 進場-11：baseline + 假突破過濾
  { id: 'V5_baseline_FBfilter', label: '生產 baseline + 假突破過濾', opts: { ...PRODUCTION_BASELINE }, falseBreakoutFilter: true },
  // 進場-11+13：三項放寬 + 假突破過濾
  { id: 'V6_allLoosen_FBfilter', label: '三項放寬 + 假突破過濾', opts: { ...PRODUCTION_BASELINE, minConsolDays: 3, anchorAllowBlack: true, gapVolRelief: 0.8 }, falseBreakoutFilter: true },
];

// ─────────────────────────────────────────────────────────────────────────
// 一筆觸發事件
// ─────────────────────────────────────────────────────────────────────────
interface Hit {
  date: string;       // T0
  t1Open: number;
  fwd: Record<number, number | null>;   // hold → 個股報酬 %
  excess: Record<number, number | null>; // hold → 淨超額 %（扣大盤、扣成本）
  isFalseBreakout: boolean;
}

function forwardReturn(candles: Candle[], t0: number, hold: number): number | null {
  if (t0 + hold >= candles.length) return null;
  const t1Open = candles[t0 + 1]?.open;
  const exitClose = candles[t0 + hold]?.close;
  if (!t1Open || t1Open <= 0 || !exitClose) return null;
  return (exitClose - t1Open) / t1Open * 100;
}

function twiiReturn(twii: Map<string, number>, candles: Candle[], t0: number, hold: number): number | null {
  // 用個股的 T+1 日期與 T+hold 日期對齊 ^TWII（曆日對齊）
  const t1Date = candles[t0 + 1]?.date;
  const exitDate = candles[t0 + hold]?.date;
  if (!t1Date || !exitDate) return null;
  const a = twii.get(t1Date);
  const b = twii.get(exitDate);
  if (a == null || b == null || a <= 0) return null;
  return (b - a) / a * 100;
}

// ─────────────────────────────────────────────────────────────────────────
// 對單檔跑 baseline + 變體，回每個變體的 Hit 清單
// ─────────────────────────────────────────────────────────────────────────
function runSymbol(
  candles: Candle[],
  twii: Map<string, number>,
  prodHits: Hit[],
  variantHits: Map<string, Hit[]>,
): void {
  const ci: CandleWithIndicators[] = computeIndicators(candles);
  const n = ci.length;

  for (let idx = 0; idx < n; idx++) {
    const t0Date = candles[idx].date;
    if (t0Date < MIN_T0_DATE) continue;

    // ── 生產 baseline（真實生產 detector，做 parity 對照）──
    const prod = detectKlineConsolidationBreakout(ci, idx);
    if (prod?.isBreakout) {
      prodHits.push(buildHit(candles, twii, idx, false));
    }

    // ── 變體 ──
    for (const v of VARIANTS) {
      const r = detectKlineConsolBreakoutVariant(ci, idx, v.opts);
      if (!r?.isBreakout) continue;
      let isFalse = false;
      if (v.falseBreakoutFilter) {
        isFalse = detectFalseBreakout(ci, idx, 2).isFalse;
        if (isFalse) continue;  // 假突破過濾 → 剔除這筆進場
      } else {
        isFalse = detectFalseBreakout(ci, idx, 2).isFalse;  // 仍記錄供統計
      }
      const list = variantHits.get(v.id)!;
      list.push(buildHit(candles, twii, idx, isFalse));
    }
  }
}

function buildHit(candles: Candle[], twii: Map<string, number>, idx: number, isFalse: boolean): Hit {
  const fwd: Record<number, number | null> = {};
  const excess: Record<number, number | null> = {};
  for (const h of HOLD_DAYS) {
    const r = forwardReturn(candles, idx, h);
    const b = twiiReturn(twii, candles, idx, h);
    fwd[h] = r;
    excess[h] = (r != null && b != null) ? (r - b - ROUND_TRIP_COST_PCT) : null;
  }
  return {
    date: candles[idx].date,
    t1Open: candles[idx + 1]?.open ?? 0,
    fwd,
    excess,
    isFalseBreakout: isFalse,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 統計
// ─────────────────────────────────────────────────────────────────────────
function mean(a: number[]): number { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
function winRate(a: number[]): number { return a.length ? a.filter(x => x > 0).length / a.length * 100 : NaN; }

interface Segment {
  n: number;
  fwdAvg: Record<number, number>;
  excessAvg: Record<number, number>;
  winRate: Record<number, number>;
}

function summarize(hits: Hit[]): Segment {
  const fwdAvg: Record<number, number> = {};
  const excessAvg: Record<number, number> = {};
  const wr: Record<number, number> = {};
  for (const h of HOLD_DAYS) {
    const fwd = hits.map(x => x.fwd[h]).filter((x): x is number => x != null);
    const exc = hits.map(x => x.excess[h]).filter((x): x is number => x != null);
    fwdAvg[h] = mean(fwd);
    excessAvg[h] = mean(exc);
    wr[h] = winRate(exc);  // 勝率用「淨超額>0」算（贏大盤+成本）
  }
  return { n: hits.length, fwdAvg, excessAvg, winRate: wr };
}

function trainTestSplit(hits: Hit[]): { train: Hit[]; test: Hit[]; cut: string } {
  const sorted = [...hits].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) return { train: [], test: [], cut: '-' };
  const mid = Math.floor(sorted.length / 2);
  const cut = sorted[mid].date;
  return { train: sorted.slice(0, mid), test: sorted.slice(mid), cut };
}

function fmt(x: number, sign = true): string {
  if (Number.isNaN(x)) return '  n/a';
  const s = x >= 0 && sign ? '+' : '';
  return `${s}${x.toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
function main(): void {
  console.log('\n  載入 ^TWII 基準...');
  const twii = loadTwiiClose();
  console.log(`  ^TWII ${twii.size} 個交易日`);

  const files = fs.readdirSync(CANDLE_DIR)
    .filter(f => /\.(TW|TWO)\.json$/.test(f))
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`  掃描 ${files.length} 檔 TW 股票...`);

  const prodHits: Hit[] = [];
  const variantHits = new Map<string, Hit[]>(VARIANTS.map(v => [v.id, [] as Hit[]]));

  let done = 0;
  for (const f of files) {
    const candles = loadRaw(path.join(CANDLE_DIR, f));
    if (!candles || candles.length < 40) continue;
    runSymbol(candles, twii, prodHits, variantHits);
    if (++done % 300 === 0) process.stdout.write(`    ...${done}/${files.length}\n`);
  }

  // ── Parity 檢查：V0_baseline（變體版）應與生產 detector 命中數一致 ──
  const v0 = variantHits.get('V0_baseline')!;
  console.log(`\n  ════ Parity 檢查 ════`);
  console.log(`  生產 detector 命中：${prodHits.length}`);
  console.log(`  V0_baseline 變體命中：${v0.length}`);
  console.log(`  parity ${prodHits.length === v0.length ? '✅ 一致' : '⚠️ 不一致（變體版邏輯偏離生產，需修）'}`);

  // ── 假突破命中率（baseline 全部觸發中，T+1/T+2 黑 K 跌破 1/2 價的比例）──
  const v0False = v0.filter(h => h.isFalseBreakout).length;
  console.log(`\n  ════ 假突破統計（baseline 觸發）════`);
  console.log(`  baseline 觸發 ${v0.length} 筆，其中 ${v0False} 筆 (${(v0.length ? v0False / v0.length * 100 : 0).toFixed(1)}%) 在 T+1/T+2 被黑 K 跌破 1/2 價（假突破）`);
  // 假突破 vs 真突破 d5 淨超額對照
  const falseD5 = v0.filter(h => h.isFalseBreakout).map(h => h.excess[5]).filter((x): x is number => x != null);
  const trueD5 = v0.filter(h => !h.isFalseBreakout).map(h => h.excess[5]).filter((x): x is number => x != null);
  console.log(`  假突破 d5 淨超額均值：${fmt(mean(falseD5))}%（n=${falseD5.length}）`);
  console.log(`  真突破 d5 淨超額均值：${fmt(mean(trueD5))}%（n=${trueD5.length}）`);

  // ── 變體主表 ──
  console.log(`\n  ════ 變體對照（淨超額 = 扣大盤 + 扣成本 ${ROUND_TRIP_COST_PCT}%；勝率 = 淨超額>0）════\n`);
  const lines: string[] = [];
  lines.push('| 變體 | 樣本 | d5淨超額% | d5勝率% | d10淨超額% | d10勝率% | train d5超額 | test d5超額 | 一致 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|:--:|');

  for (const v of VARIANTS) {
    const hits = variantHits.get(v.id)!;
    const all = summarize(hits);
    const { train, test } = trainTestSplit(hits);
    const tr = summarize(train);
    const te = summarize(test);
    const trX = tr.excessAvg[5];
    const teX = te.excessAvg[5];
    const consistent = (!Number.isNaN(trX) && !Number.isNaN(teX) && Math.sign(trX) === Math.sign(teX)) ? '✅' : '✗';
    const row = `| ${v.id} | ${all.n} | ${fmt(all.excessAvg[5])} | ${fmt(all.winRate[5], false)} | ${fmt(all.excessAvg[10])} | ${fmt(all.winRate[10], false)} | ${fmt(trX)} | ${fmt(teX)} | ${consistent} |`;
    lines.push(row);
    console.log(`  ${v.id.padEnd(24)} n=${String(all.n).padStart(5)} d5超額 ${fmt(all.excessAvg[5])}% 勝率 ${fmt(all.winRate[5], false)}% | train ${fmt(trX)} test ${fmt(teX)} ${consistent}  — ${v.label}`);
  }

  console.log('\n  ── Markdown 表 ──\n');
  console.log(lines.join('\n'));
  console.log('');

  // 額外輸出對照：每變體 vs baseline 的「樣本增量」與「淨超額差」
  console.log('  ════ 變體 vs V0_baseline 增量 ════');
  const base = summarize(variantHits.get('V0_baseline')!);
  for (const v of VARIANTS) {
    if (v.id === 'V0_baseline') continue;
    const s = summarize(variantHits.get(v.id)!);
    const dN = s.n - base.n;
    const dX = s.excessAvg[5] - base.excessAvg[5];
    console.log(`  ${v.id.padEnd(24)} 樣本 ${dN >= 0 ? '+' : ''}${dN}，d5淨超額 ${fmt(dX)}pp`);
  }
  console.log('');
}

main();
