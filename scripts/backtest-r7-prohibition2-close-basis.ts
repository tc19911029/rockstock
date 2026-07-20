/**
 * R7-1 回測：戒律2 口徑 —「連3根紅K」vs「連3日收盤走高」
 *
 * 現況 lib/rules/entryProhibitions.ts:80-90 用 close > open（紅K）數連續根數。
 * 課程 CH2-1/p04：「真正漲跌看今日收盤 vs 昨日收盤，不是看K棒顏色」。
 * 同 repo 正解先例：lib/rules/winnerPatternRules.ts:281-285。
 *
 * 戒律2 是**硬否決**（擋掉就不能進場），所以好的 gate = 擋掉「之後表現差」的股票。
 * 判定看四個互斥子集：
 *   both     = 新舊都擋（不受影響）
 *   onlyOld  = A\B 舊擋新不擋（改了以後「放行」的那批）→ 若表現好 ⇒ 舊口徑誤殺
 *   onlyNew  = B\A 新擋舊不擋（改了以後「新擋掉」的那批）→ 若表現差 ⇒ 新口徑抓到真追高
 *   neither  = 都不擋（對照組 = 實際會進場的樣本）
 *
 * 通過條件：onlyNew 超額 < neither（新擋掉的比放行的差）
 *          且 onlyOld 超額 > neither 或至少不差（舊誤殺）
 *          且 train / test 兩段同向。任一段翻面 ⇒ 否決。
 *
 * 慣例（對齊 backtest-gap-limitup-vol-exempt.ts）：
 *   T+1 開盤進場（settleBaseline，一字鎖死 no_fill 不計分）
 *   D5/D20 close vs entry_open，對 ^TWII 曆日對齊超額（computeEventReturns）
 *   train/test 依中位日期切
 *
 * Usage: FROM=2024-01-01 TO=2026-06-30 npx tsx scripts/backtest-r7-prohibition2-close-basis.ts
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const FROM = process.env.FROM ?? '2024-01-01';
const TO = process.env.TO ?? '2026-06-30';
const NOW = '2099-12-31';

type Group = 'both' | 'onlyOld' | 'onlyNew' | 'neither';
interface Row { group: Group; date: string; code: string; exD5: number | null; exD20: number | null; status: string }

function loadRaw(sym: string): Candle[] | null {
  const p = path.join(CANDLE_DIR, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf8')) as { candles?: Candle[] };
    return f.candles && f.candles.length > 0 ? f.candles : null;
  } catch { return null; }
}

const idxRaw = loadRaw('^TWII');
if (!idxRaw) { console.error('缺 ^TWII，無法算超額'); process.exit(1); }
const indexCandles = idxRaw as unknown as BaselineCandle[];

/** 舊口徑：連續紅K（close > open）根數，最多回看 5 根 */
function streakRedK(cs: { open: number; close: number }[], index: number): number {
  let n = 0;
  for (let i = index; i >= Math.max(0, index - 4); i--) {
    if (cs[i].close > cs[i].open) n++; else break;
  }
  return n;
}
/** 新口徑（課程）：連續「收盤高於昨收」天數，最多回看 5 根 */
function streakCloseUp(cs: { close: number }[], index: number): number {
  let n = 0;
  for (let i = index; i >= Math.max(0, index - 4); i--) {
    if (i - 1 < 0) break;
    if (cs[i].close > cs[i - 1].close) n++; else break;
  }
  return n;
}

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

    // 母體 = 六條件核心 5 項全過（＝生產鏈路上「戒律才會被叫到」的位置）
    const r = evaluateSixConditions(enriched, i);
    if (!r.isCoreReady) continue;

    const oldHit = streakRedK(enriched, i) >= 3;
    const newHit = streakCloseUp(enriched, i) >= 3;
    const group: Group = oldHit && newHit ? 'both' : oldHit ? 'onlyOld' : newHit ? 'onlyNew' : 'neither';

    const baseline = settleBaseline(c.date, baseCandles, NOW);
    const ret = computeEventReturns({ baseline }, baseCandles, indexCandles);
    rows.push({
      group, date: c.date, code: sym,
      exD5: ret?.excess.d5 ?? null,
      exD20: ret?.excess.d20 ?? null,
      status: baseline.status,
    });
  }
  scanned++;
  if (scanned % 300 === 0) console.error(`  ...scanned ${scanned}/${files.length}, ${rows.length} rows`);
}

const dates = [...new Set(rows.map(r => r.date))].sort();
const splitDate = dates[Math.floor(dates.length / 2)] ?? TO;

function stats(rs: Row[], h: 'exD5' | 'exD20') {
  const filled = rs.filter(r => r.status === 'filled' && r[h] != null);
  const vals = filled.map(r => r[h]!);
  const n = vals.length;
  const mean = n ? vals.reduce((a, b) => a + b, 0) / n : NaN;
  const win = n ? filled.filter(r => r[h]! > 0).length / n : NaN;
  return { n, mean, win };
}

function report(g: Group, label: string) {
  const all = rows.filter(r => r.group === g);
  const train = all.filter(r => r.date <= splitDate);
  const test = all.filter(r => r.date > splitDate);
  console.log(`\n── ${g}（${label}）── 總命中 ${all.length}`);
  for (const [lbl, rs] of [['train', train], ['test ', test]] as const) {
    const d5 = stats(rs, 'exD5'), d20 = stats(rs, 'exD20');
    console.log(`   ${lbl}: D5 超額 ${d5.mean.toFixed(2)}% 勝率 ${(100 * d5.win).toFixed(0)}% (n=${d5.n}) | D20 超額 ${d20.mean.toFixed(2)}% 勝率 ${(100 * d20.win).toFixed(0)}% (n=${d20.n})`);
  }
}

console.log(`\n📊 R7-1 戒律2 口徑回測（紅K根數 vs 收盤走高）  ${FROM} → ${TO}`);
console.log(`掃 ${scanned} 檔、母體（六條件核心5項全過）${rows.length} 筆；train/test 切點 ${splitDate}`);
report('neither', '兩口徑都放行＝對照組');
report('both', '新舊都擋');
report('onlyOld', 'A\\B 舊擋新放 → 改了會多放進來');
report('onlyNew', 'B\\A 新擋舊放 → 改了會多擋掉');
// ── 決策關鍵：兩種口徑各自「放行的池子」整體品質 ──────────────────────────────
// 舊口徑放行 = neither ∪ onlyNew（舊沒擋到的）；新口徑放行 = neither ∪ onlyOld
console.log(`\n═══ 放行池整體品質（真正的決策數字）═══`);
for (const [lbl, rs] of [['train', rows.filter(r => r.date <= splitDate)], ['test ', rows.filter(r => r.date > splitDate)]] as const) {
  const oldPool = rs.filter(r => r.group === 'neither' || r.group === 'onlyNew');
  const newPool = rs.filter(r => r.group === 'neither' || r.group === 'onlyOld');
  for (const h of ['exD5', 'exD20'] as const) {
    const o = stats(oldPool, h), n = stats(newPool, h);
    const delta = n.mean - o.mean;
    console.log(`   ${lbl} ${h}: 舊口徑放行 ${o.mean.toFixed(2)}% (n=${o.n}) → 新口徑放行 ${n.mean.toFixed(2)}% (n=${n.n})　差 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`);
  }
}
console.log(`\n判定：改口徑要成立 ⇒ onlyNew 超額顯著低於 neither（新擋到真的差股）`);
console.log(`      且 onlyOld 超額 ≥ neither（舊口徑誤殺好股），兩段 train/test 同向。`);
console.log(`      放行池「差」欄兩段同號為正才算真的改善；一段正一段負 ⇒ 過擬合，否決。`);
