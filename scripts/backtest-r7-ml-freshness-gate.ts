/**
 * R7-3 回測：M / L 買法補「首次突破」新鮮度 gate？
 *
 * 課程 6-6：「當**出現**大量中長紅K收盤突破上升軌道線」— 是狀態轉換（今天才第一次過），
 * 不是位置比較（今天在線上方就算）。C 買法已有此 gate
 *（lib/analysis/highWinPositions.ts:669 `if (prev.close > upperYesterday) return null`），
 * M（lib/analysis/v12LetterM.ts）完全沒有、L（blackKBreakoutEntry）只有 3 天隱性上界。
 *
 * 新鮮度定義（照 C 的先例）：
 *   M：昨收 < 軌道線昨日延伸值 ×1.03（＝昨天還沒過同一條門檻）
 *   L：昨收 ≤ 大量黑K最高點（＝昨天還沒突破同一個目標）
 *
 * 分組：fresh（首次突破，改了會留下） / stale（改了會被砍掉）
 * 通過條件：stale 的 D5/D20 超額在 train 與 test 兩段都低於 fresh。任一段翻面 ⇒ 否決。
 * 樣本 <100 標「樣本不足」。
 *
 * 慣例：T+1 開盤進場（settleBaseline）、對 ^TWII 曆日對齊超額（computeEventReturns）、
 *      train/test 依中位日期切。
 *
 * Usage: FROM=2023-01-01 TO=2026-06-30 npx tsx scripts/backtest-r7-ml-freshness-gate.ts
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectLetterM } from '@/lib/analysis/v12LetterM';
import { detectBlackKBreakout } from '@/lib/analysis/blackKBreakoutEntry';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
// 訊號稀疏 → 視窗開大一點才有樣本
const FROM = process.env.FROM ?? '2023-01-01';
const TO = process.env.TO ?? '2026-06-30';
const NOW = '2099-12-31';
const TRUE_BREAKOUT_PCT = 0.03; // 與 v12LetterM 同值

type Letter = 'M' | 'L';
interface Row { letter: Letter; fresh: boolean; date: string; code: string; exD5: number | null; exD20: number | null; status: string; daysSince?: number }

function loadRaw(sym: string): Candle[] | null {
  const p = path.join(CANDLE_DIR, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf8')) as { candles?: Candle[] };
    return f.candles && f.candles.length > 0 ? f.candles : null;
  } catch { return null; }
}

const idxRaw = loadRaw('^TWII');
if (!idxRaw) { console.error('缺 ^TWII'); process.exit(1); }
const indexCandles = idxRaw as unknown as BaselineCandle[];

const files = fs.readdirSync(CANDLE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('^'));
const rows: Row[] = [];
let scanned = 0;

for (const file of files) {
  const sym = file.replace(/\.json$/, '');
  const raw = loadRaw(sym);
  if (!raw || raw.length < 80) continue;
  const enriched = computeIndicators(raw);
  const baseCandles = raw as unknown as BaselineCandle[];

  for (let i = 60; i < enriched.length; i++) {
    const c = enriched[i];
    if (c.date < FROM || c.date > TO) continue;
    const prev = enriched[i - 1];
    if (!prev || prev.volume <= 0 || c.open <= 0 || prev.close <= 0) continue;

    // 便宜的共同前置（M/L 都要紅K+實體≥2%+量比≥1.3）— 省掉 95% 的 detectTrend/findPivots
    if (c.close <= c.open) continue;
    if ((c.close - c.open) / c.open * 100 < 2) continue;
    if (c.volume / prev.volume < 1.3) continue;

    const hits: Array<{ letter: Letter; fresh: boolean; daysSince?: number }> = [];

    // ── M：突破上升軌道線 ──
    const m = detectLetterM(enriched, i, 'TW', sym);
    if (m.triggered && m.supportLow1Index != null && m.supportLow2Index != null
        && m.channelAnchorIndex != null && m.channelAnchorPrice != null) {
      const slope = (m.supportLow1Price! - m.supportLow2Price!) / (m.supportLow1Index - m.supportLow2Index);
      const channelYesterday = m.channelAnchorPrice + slope * (i - 1 - m.channelAnchorIndex);
      const fresh = prev.close < channelYesterday * (1 + TRUE_BREAKOUT_PCT);
      hits.push({ letter: 'M', fresh });
    }

    // ── L：突破大量黑K ──
    const l = detectBlackKBreakout(enriched, i);
    if (l) {
      hits.push({ letter: 'L', fresh: prev.close <= l.blackKHigh, daysSince: l.daysSinceBlackK });
    }

    if (hits.length === 0) continue;
    const baseline = settleBaseline(c.date, baseCandles, NOW);
    const ret = computeEventReturns({ baseline }, baseCandles, indexCandles);
    for (const h of hits) {
      rows.push({
        letter: h.letter, fresh: h.fresh, daysSince: h.daysSince,
        date: c.date, code: sym,
        exD5: ret?.excess.d5 ?? null,
        exD20: ret?.excess.d20 ?? null,
        status: baseline.status,
      });
    }
  }
  scanned++;
  if (scanned % 300 === 0) console.error(`  ...scanned ${scanned}/${files.length}, ${rows.length} signals`);
}

const dates = [...new Set(rows.map(r => r.date))].sort();
const splitDate = dates[Math.floor(dates.length / 2)] ?? TO;

function stats(rs: Row[], h: 'exD5' | 'exD20') {
  const f = rs.filter(r => r.status === 'filled' && r[h] != null);
  const v = f.map(r => r[h]!);
  const n = v.length;
  return { n, mean: n ? v.reduce((a, b) => a + b, 0) / n : NaN, win: n ? f.filter(r => r[h]! > 0).length / n : NaN };
}

console.log(`\n📊 R7-3 M/L 首次突破新鮮度 gate 回測  ${FROM} → ${TO}（掃 ${scanned} 檔）`);
console.log(`總訊號 ${rows.length}；train/test 切點 ${splitDate}`);

for (const letter of ['M', 'L'] as Letter[]) {
  const all = rows.filter(r => r.letter === letter);
  const fresh = all.filter(r => r.fresh), stale = all.filter(r => !r.fresh);
  console.log(`\n═══ 買法 ${letter} ═══ 總訊號 ${all.length}　→ 加 gate 後留 ${fresh.length}（${(100 * fresh.length / (all.length || 1)).toFixed(0)}%）、砍 ${stale.length}（${(100 * stale.length / (all.length || 1)).toFixed(0)}%）`);
  if (letter === 'L') {
    const byDay = new Map<number, { n: number; stale: number }>();
    for (const r of all) {
      const k = r.daysSince ?? 0;
      const e = byDay.get(k) ?? { n: 0, stale: 0 };
      e.n++; if (!r.fresh) e.stale++;
      byDay.set(k, e);
    }
    console.log(`   L 距黑K天數分佈：${[...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `D+${k}:${v.n}(stale ${v.stale})`).join('  ')}`);
  }
  for (const [gl, gr] of [['fresh（首次突破，留）', fresh], ['stale（非首次，砍）', stale]] as const) {
    console.log(`   ── ${gl} ──`);
    for (const [lbl, rs] of [['train', gr.filter(r => r.date <= splitDate)], ['test ', gr.filter(r => r.date > splitDate)]] as const) {
      const d5 = stats(rs, 'exD5'), d20 = stats(rs, 'exD20');
      const flag = d5.n < 50 ? '  ⚠樣本少' : '';
      console.log(`      ${lbl}: D5 超額 ${d5.mean.toFixed(2)}% 勝率 ${(100 * d5.win).toFixed(0)}% (n=${d5.n}) | D20 超額 ${d20.mean.toFixed(2)}% 勝率 ${(100 * d20.win).toFixed(0)}% (n=${d20.n})${flag}`);
    }
  }
}
// ── 穩健性：改切三段（防「剛好對半切才成立」的過擬合）──────────────────────
console.log(`\n═══ 穩健性檢查：改切三段（fresh − stale 的超額差，正 = gate 有用）═══`);
const t1 = dates[Math.floor(dates.length / 3)], t2 = dates[Math.floor(2 * dates.length / 3)];
for (const letter of ['M', 'L'] as Letter[]) {
  const all = rows.filter(r => r.letter === letter);
  const segs: Array<[string, Row[]]> = [
    [`P1 ≤${t1}`, all.filter(r => r.date <= t1)],
    [`P2 ~${t2}`, all.filter(r => r.date > t1 && r.date <= t2)],
    [`P3 >${t2}`, all.filter(r => r.date > t2)],
  ];
  console.log(`   ${letter}:`);
  for (const [lbl, seg] of segs) {
    const f = seg.filter(r => r.fresh), s = seg.filter(r => !r.fresh);
    const d5 = stats(f, 'exD5').mean - stats(s, 'exD5').mean;
    const d20 = stats(f, 'exD20').mean - stats(s, 'exD20').mean;
    console.log(`      ${lbl}: Δ D5 ${d5 >= 0 ? '+' : ''}${d5.toFixed(2)}%  Δ D20 ${d20 >= 0 ? '+' : ''}${d20.toFixed(2)}%  (fresh n=${stats(f, 'exD5').n} / stale n=${stats(s, 'exD5').n})`);
  }
}
console.log(`\n判定：加 gate 要成立 ⇒ stale 的 D5/D20 超額在 train 與 test 兩段都低於 fresh。`);
console.log(`      任一段翻面 ⇒ 否決（過擬合）。任一組樣本 <100 ⇒ 樣本不足、存查不上生產。`);
