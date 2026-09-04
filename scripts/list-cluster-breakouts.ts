/**
 * 拉出最近一年「均線糾結突破」命中的股票清單（生產端 detectMaClusterBreak）
 * Usage: FROM=2025-07-09 TO=2026-07-09 npx tsx scripts/list-cluster-breakouts.ts
 */
import fs from 'fs';
import path from 'path';
import type { Candle } from '@/types';
import { computeIndicators } from '@/lib/indicators';
import { detectMaClusterBreak } from '@/lib/analysis/highWinPositions';

const CANDLE_DIR = path.join(process.cwd(), 'data', 'candles', 'TW');
const FROM = process.env.FROM ?? '2025-07-09';
const TO = process.env.TO ?? '2026-07-09';

// 股名對照
let master: Record<string, string> = {};
try {
  const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'youtube', 'stock-master.json'), 'utf8'));
  const arr = Array.isArray(m) ? m : (m.stocks ?? m.entries ?? Object.entries(m).map(([code, name]) => ({ code, name })));
  for (const e of arr) if (e?.code) master[String(e.code)] = e.name ?? '';
} catch { /* 沒有就只出代號 */ }

function loadRaw(sym: string): Candle[] | null {
  const p = path.join(CANDLE_DIR, `${sym}.json`);
  if (!fs.existsSync(p)) return null;
  try { const f = JSON.parse(fs.readFileSync(p, 'utf8')) as { candles?: Candle[] }; return f.candles?.length ? f.candles : null; } catch { return null; }
}

const files = fs.readdirSync(CANDLE_DIR).filter(f => /^\d{4}\.TW\.json$/.test(f));
interface Hit { date: string; code: string; name: string; close: number; chgPct: number; volRatio: number; }
const hits: Hit[] = [];
let scanned = 0;

for (const file of files) {
  const sym = file.replace(/\.json$/, '');
  const code = sym.replace('.TW', '');
  const raw = loadRaw(sym);
  if (!raw || raw.length < 80) continue;
  const en = computeIndicators(raw);
  for (let i = 30; i < en.length; i++) {
    const c = en[i];
    if (c.date < FROM || c.date > TO) continue;
    if (!detectMaClusterBreak(en as any, i)) continue;
    const prev = en[i - 1];
    const chg = prev?.close ? (c.close - prev.close) / prev.close * 100 : 0;
    const volRatio = c.avgVol5 ? c.volume / c.avgVol5 : 0;
    hits.push({ date: c.date, code, name: master[code] ?? '', close: c.close, chgPct: chg, volRatio });
  }
  scanned++;
  if (scanned % 300 === 0) console.error(`  ...${scanned}/${files.length}, ${hits.length} hits`);
}

hits.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.code.localeCompare(b.code)));

// 輸出 CSV
const outDir = path.join(process.cwd(), 'data', 'reports');
fs.mkdirSync(outDir, { recursive: true });
const csvPath = path.join(outDir, `cluster-breakouts_${FROM}_${TO}.csv`);
const csv = ['date,code,name,close,chg_pct,vol_ratio', ...hits.map(h => `${h.date},${h.code},${h.name},${h.close},${h.chgPct.toFixed(2)},${h.volRatio.toFixed(2)}`)].join('\n');
fs.writeFileSync(csvPath, csv);

// 統計
const byMonth: Record<string, number> = {};
for (const h of hits) { const m = h.date.slice(0, 7); byMonth[m] = (byMonth[m] ?? 0) + 1; }
const uniqStocks = new Set(hits.map(h => h.code));

console.log(`\n📊 均線糾結突破命中清單  ${FROM} → ${TO}`);
console.log(`   掃 ${scanned} 檔、命中 ${hits.length} 筆、涉及 ${uniqStocks.size} 檔股票`);
console.log(`   月分佈: ${Object.entries(byMonth).sort().map(([m, n]) => `${m.slice(5)}=${n}`).join(' ')}`);
console.log(`   CSV → ${path.relative(process.cwd(), csvPath)}`);
console.log(`\n最近 30 筆:`);
console.log('  日期        代號  股名          收盤    漲幅%   量比');
for (const h of hits.slice(0, 30)) {
  console.log(`  ${h.date}  ${h.code.padEnd(5)} ${(h.name || '').padEnd(8)}  ${String(h.close).padStart(7)}  ${h.chgPct.toFixed(1).padStart(5)}  ${h.volRatio.toFixed(1).padStart(4)}`);
}
