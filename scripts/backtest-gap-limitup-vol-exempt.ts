/**
 * 逐字-11 回測：六條件④量「跳空漲停急拉日」豁免 —— 值不值得改 gate？
 *
 * 課程 CH5-1（昇貿例）：量沒到 1.3x 但當天跳空漲停急拉、其他五條件都符合 → 老師說可進場。
 * 現行程式六條件④量 gate 無此豁免 → 這種最強跳空漲停股被濾掉。此腳本驗證：
 * 「六條件只差量、當天跳空漲停」這組股票的前瞻表現，值不值得放進 gate。
 *
 * 慣例（與 backtest-course-research-batch / reco 一致）：
 *   - T+1 開盤進場（settleBaseline，含一字鎖死 no_fill 守衛 —— 漲停隔日常買不到，這點最致命）
 *   - D5 / D20 close vs entry_open，對 ^TWII 曆日對齊超額（computeEventReturns）
 *   - train / test 中位日期切（防過擬合；兩段同向才算數）
 *   - 決策門檻：豁免組淨超額為正 + train/test 一致 + 不顯著遜於「完整過關組」，才建議改 gate
 *
 * Usage: FROM=2024-01-01 TO=2026-06-30 npx tsx scripts/backtest-gap-limitup-vol-exempt.ts
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { evaluateSixConditions } from '@/lib/analysis/trendAnalysis';
import { isLimitUp } from '@/lib/utils/limitRules';
import { settleBaseline, type BaselineCandle } from '@/lib/backtest/eventBaseline';
import { computeEventReturns } from '@/lib/backtest/eventReturns';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const FROM = process.env.FROM ?? '2024-01-01';
const TO = process.env.TO ?? '2026-06-30';
const NOW = '2099-12-31'; // 強制全部結算

type Group = 'fullPass' | 'volFailGapLimitUp' | 'volFailNoGap';
interface Row { group: Group; date: string; code: string; exD5: number | null; exD20: number | null; status: string; }

function loadRaw(sym: string): Candle[] | null {
  const p = path.join(CANDLE_DIR, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf8')) as { candles?: Candle[] };
    return f.candles && f.candles.length > 0 ? f.candles : null;
  } catch { return null; }
}

const idxRaw = loadRaw('^TWII');
const indexCandles: BaselineCandle[] | null = idxRaw ? idxRaw as unknown as BaselineCandle[] : null;
if (!indexCandles) { console.error('缺 ^TWII，無法算超額'); process.exit(1); }

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
    if (!prev || prev.close <= 0) continue;

    const r = evaluateSixConditions(enriched, i);
    // 核心非量四條件（①趨勢②均線③位置⑤K棒）
    const coreExVol = r.trend.pass && r.ma.pass && r.position.pass && r.kbar.pass;
    if (!coreExVol) continue; // 只關心「其他都過」的股票（量是唯一變數）

    const gapLimitUp = c.open > prev.close && isLimitUp(c.close, prev.close, 'TW', sym);
    let group: Group;
    if (r.volume.pass) group = 'fullPass';
    else if (gapLimitUp) group = 'volFailGapLimitUp';
    else group = 'volFailNoGap';

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
  if (scanned % 300 === 0) console.error(`  ...scanned ${scanned}/${files.length} files, ${rows.length} rows`);
}

// train/test 中位日期切
const dates = [...new Set(rows.map(r => r.date))].sort();
const splitDate = dates[Math.floor(dates.length / 2)] ?? TO;

function stats(rs: Row[], horizon: 'exD5' | 'exD20') {
  const filled = rs.filter(r => r.status === 'filled' && r[horizon] != null);
  const vals = filled.map(r => r[horizon]!);
  const n = vals.length;
  const mean = n ? vals.reduce((a, b) => a + b, 0) / n : NaN;
  const win = n ? filled.filter(r => r[horizon]! > 0).length / n : NaN;
  return { n, mean, win };
}

function report(group: Group) {
  const all = rows.filter(r => r.group === group);
  const noFill = all.filter(r => r.status === 'no_fill').length;
  const train = all.filter(r => r.date <= splitDate);
  const test = all.filter(r => r.date > splitDate);
  console.log(`\n── ${group} ──  總命中 ${all.length}，一字買不到(no_fill) ${noFill}（${(100 * noFill / (all.length || 1)).toFixed(1)}%）`);
  for (const [lbl, rs] of [['train', train], ['test', test]] as const) {
    const d5 = stats(rs, 'exD5');
    const d20 = stats(rs, 'exD20');
    console.log(`   ${lbl}: D5 超額 ${d5.mean.toFixed(2)}% 勝率 ${(100 * d5.win).toFixed(0)}% (n=${d5.n}) | D20 超額 ${d20.mean.toFixed(2)}% 勝率 ${(100 * d20.win).toFixed(0)}% (n=${d20.n})`);
  }
}

console.log(`\n📊 逐字-11 跳空漲停量豁免回測  ${FROM} → ${TO}`);
console.log(`掃 ${scanned} 檔、命中 ${rows.length} 筆（六條件其他五項皆過）；train/test 切點 ${splitDate}`);
report('fullPass');
report('volFailGapLimitUp');
report('volFailNoGap');
console.log(`\n決策提示：volFailGapLimitUp 要「進得去(no_fill 不能太高)」+ D5/D20 超額 train/test 皆正 + 不遜於 fullPass，才建議改 gate。`);
