// QA sweep over candle FILES (no server / no rate limit / full history).
// For 200 CN + 200 TW sampled stocks, validates exactly what the 三色 chart computes on:
//   - availability  : <60 candles → chart 404s (would show stale ghost pre-fix; clean post-fix)
//   - ohlc_invalid  : high<low, high<max(o,c), low>min(o,c), non-positive, NaN
//   - contamination : single-day |closeΔ| > 25% (no price-limit board allows this → unadjusted ex-rights/data error)
//   - line_band     : recompute duokong=MA60 & zhineng=HHV(ZB,13)*.95; flag if outside [0.2,5]× last close
//   - stale         : last bar older than cutoff
import { promises as fs } from 'node:fs';

const N = Number(process.env.N || 200);
const CONTAM = 0.25;
const STALE_BEFORE = '2026-05-20';

function sample(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; const out = []; for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]); return out; }
const MA = (a, p, i) => { if (i + 1 < p) return NaN; let s = 0; for (let k = i - p + 1; k <= i; k++) s += a[k]; return s / p; };

async function scanFile(dir, file) {
  const sym = file.replace('.json', '');
  let candles;
  try { candles = JSON.parse(await fs.readFile(`${dir}/${file}`, 'utf8')).candles; } catch (e) { return { sym, flags: ['read_err:' + e.message] }; }
  if (!Array.isArray(candles) || candles.length < 60) return { sym, n: candles?.length ?? 0, flags: ['availability(<60)'] };
  const flags = [];
  const C = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  // ohlc validity (scan all)
  let bad = 0;
  for (const c of candles) {
    const { open: o, high: h, low: l, close: cl } = c;
    if (![o, h, l, cl].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || cl <= 0) { bad++; continue; }
    if (h < l || h < Math.max(o, cl) - 1e-6 || l > Math.min(o, cl) + 1e-6) bad++;
  }
  if (bad) flags.push(`ohlc_invalid×${bad}`);
  // contamination: worst single-day jump over full history
  let maxJ = 0, at = -1;
  for (let i = 1; i < C.length; i++) { if (C[i - 1] > 0) { const d = Math.abs(C[i] / C[i - 1] - 1); if (d > maxJ) { maxJ = d; at = i; } } }
  if (maxJ > CONTAM) flags.push(`contamination ${(maxJ * 100).toFixed(0)}%@${candles[at]?.date}`);
  // 三色 line band (recompute the two cheap lines)
  const i = C.length - 1;
  const duokong = MA(C, 60, i);
  const ZB = candles.map(c => (c.close + c.high + c.open + c.low) / 4);
  let hh = -Infinity; for (let k = Math.max(0, i - 12); k <= i; k++) hh = Math.max(hh, ZB[k]);
  const zhineng = hh * 0.95;
  for (const [name, v] of [['duokong', duokong], ['zhineng', zhineng]]) {
    if (Number.isFinite(v) && last.close > 0 && (v > last.close * 5 || v < last.close * 0.2)) flags.push(`line_band:${name}=${v.toFixed(1)}vs${last.close}`);
  }
  // staleness
  if (last.date < STALE_BEFORE) flags.push(`stale(last=${last.date})`);
  return { sym, n: candles.length, lastDate: last.date, lastClose: last.close, maxJumpPct: +(maxJ * 100).toFixed(1), flags };
}

async function scanMarket(label, dir, re, stripIdx) {
  let files;
  try { files = await fs.readdir(dir); } catch (e) { console.log(`${label}: cannot read ${dir}: ${e.message}`); return []; }
  files = files.filter(f => re.test(f) && !stripIdx(f)).sort();
  const picked = sample(files, N);
  const results = [];
  for (const f of picked) results.push(await scanFile(dir, f));
  return results;
}

function report(label, results) {
  const clean = results.filter(r => !r.flags.length);
  const flagged = results.filter(r => r.flags.length);
  console.log(`\n===== ${label}: ${results.length} scanned · ${clean.length} clean · ${flagged.length} flagged =====`);
  const byType = {};
  for (const r of flagged) for (const f of r.flags) { const k = f.split(/[ :×(]/)[0]; byType[k] = (byType[k] || 0) + 1; }
  console.log('  flag types:', JSON.stringify(byType));
  for (const r of flagged) console.log(`  ⚠ ${r.sym}  n=${r.n} last=${r.lastDate} close=${r.lastClose}  ${r.flags.join('  ')}`);
  return { label, scanned: results.length, clean: clean.length, flagged: flagged.map(r => ({ sym: r.sym, flags: r.flags })) };
}

(async () => {
  const cn = await scanMarket('CN', 'data/candles/CN', /^\d{6}\.(SS|SZ)\.json$/, f => f.startsWith('000001.SS'));
  const tw = await scanMarket('TW', 'data/candles/TW', /^\d{4,6}\.(TW|TWO)\.json$/, f => f.startsWith('^'));
  const out = { cn: report('CN', cn), tw: report('TW', tw), cnRes: cn, twRes: tw };
  await fs.writeFile('/tmp/sanse-data-sweep.json', JSON.stringify(out, null, 2));
  console.log('\nFull → /tmp/sanse-data-sweep.json');
})();
