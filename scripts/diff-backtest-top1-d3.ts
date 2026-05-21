/**
 * 對照 backtest_top1_d3 baseline (5/12 Tier 1 前) vs 新版 (Tier 1 後)
 * 看每個 (letter, sort) cell 的 avgMaxGain / winRate 有沒有變化
 */
import { readFileSync } from 'fs';

interface Cell {
  letter: string;
  sort: string;
  track: string;
  picks: number;
  avgMaxGain: number;
  winRateMaxGain: number;
  hitRate5pct: number;
  grade: string;
}

const baseline = JSON.parse(readFileSync('data/backtest_top1_d3.tier1-before.json', 'utf-8'));
const newer = JSON.parse(readFileSync('data/backtest_top1_d3.tier1-after.json', 'utf-8'));

const baseMap = new Map<string, Cell>();
for (const c of baseline.stats as Cell[]) {
  baseMap.set(`${c.letter}|${c.sort}`, c);
}

interface DiffRow {
  letter: string;
  sort: string;
  picksDelta: number;
  avgGainDelta: number;
  winRateDelta: number;
  hitRateDelta: number;
  gradeChange: string;
  baseGain: number;
  newGain: number;
}
const diffs: DiffRow[] = [];

for (const c of newer.stats as Cell[]) {
  const b = baseMap.get(`${c.letter}|${c.sort}`);
  if (!b) {
    diffs.push({
      letter: c.letter, sort: c.sort,
      picksDelta: c.picks, avgGainDelta: c.avgMaxGain,
      winRateDelta: c.winRateMaxGain, hitRateDelta: c.hitRate5pct,
      gradeChange: `+ (新 ${c.grade})`,
      baseGain: 0, newGain: c.avgMaxGain,
    });
    continue;
  }
  diffs.push({
    letter: c.letter, sort: c.sort,
    picksDelta: c.picks - b.picks,
    avgGainDelta: +(c.avgMaxGain - b.avgMaxGain).toFixed(2),
    winRateDelta: +(c.winRateMaxGain - b.winRateMaxGain).toFixed(1),
    hitRateDelta: +(c.hitRate5pct - b.hitRate5pct).toFixed(1),
    gradeChange: b.grade === c.grade ? '─' : `${b.grade} → ${c.grade}`,
    baseGain: b.avgMaxGain, newGain: c.avgMaxGain,
  });
}

console.log(`=== Baseline ${baseline.generatedAt.slice(0, 10)} → 新版 ${newer.generatedAt.slice(0, 10)} ===`);
console.log(`Baseline cells: ${baseline.stats.length}, 新版 cells: ${newer.stats.length}\n`);

console.log('=== 有變化的 cells（avgGainDelta != 0 或 picks != 0）===');
const changed = diffs.filter(d => d.avgGainDelta !== 0 || d.picksDelta !== 0 || d.gradeChange !== '─');
if (changed.length === 0) {
  console.log('  (none)');
} else {
  console.log('  Letter  Sort        Δpicks  baseGain  newGain  ΔavgGain   ΔwinR   ΔhitR  Grade');
  for (const d of changed) {
    const sign = (n: number) => n > 0 ? `+${n}` : `${n}`;
    console.log(
      `  ${d.letter.padEnd(7)} ${d.sort.padEnd(12)} ` +
      `${String(sign(d.picksDelta)).padStart(6)}  ` +
      `${d.baseGain.toFixed(2).padStart(7)}  ` +
      `${d.newGain.toFixed(2).padStart(6)}  ` +
      `${sign(d.avgGainDelta).padStart(8)}%  ` +
      `${sign(d.winRateDelta).padStart(5)}%  ` +
      `${sign(d.hitRateDelta).padStart(5)}%  ` +
      `${d.gradeChange}`,
    );
  }
}

console.log(`\n=== 完全沒變的 cells: ${diffs.length - changed.length} / ${diffs.length} ===`);

const dfChanged = changed.filter(d => d.letter === 'D' || d.letter === 'F');
if (dfChanged.length > 0) {
  console.log(`\n=== D/F 軌變化（Tier 1 #2 弱中透強加持影響面）===`);
  for (const d of dfChanged) {
    console.log(`  ${d.letter} × ${d.sort}: ${d.baseGain.toFixed(2)}% → ${d.newGain.toFixed(2)}% (${d.avgGainDelta > 0 ? '+' : ''}${d.avgGainDelta}%)`);
  }
} else {
  console.log(`\n=== D/F 軌：完全沒變 — 預期內（品質標記不過濾訊號） ===`);
}
