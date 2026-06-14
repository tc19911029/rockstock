/**
 * 大戶持股 vs 股價 相關性 — 只測「每週成交量前500大」液態股。
 * 格式跟 corr-holder-vs-price.ts 一樣(同一週 + 之後20日 + 三組分桶),方便直接對照。
 * 不比大盤,純看個股自己。大戶 = 400張↑持股%。
 */
import { promises as fs } from 'fs';
import path from 'path';

const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const CAND = path.join(process.cwd(), 'data/candles/TW');
const TOP_N = 500;

interface Cdl { date: string; close: number; volume: number }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i]; }
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  if (vx <= 0 || vy <= 0) return NaN; return cov / Math.sqrt(vx * vy);
}
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

interface Obs { iso: string; turnover: number; dH: number; same: number; fwd: number | null }

async function main() {
  const files = (await fs.readdir(TDCC)).filter(f => /^\d{4}\.json$/.test(f));
  const all: Obs[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    let tj: any, cj: any;
    try { tj = JSON.parse(await fs.readFile(path.join(TDCC, f), 'utf8')); cj = JSON.parse(await fs.readFile(path.join(CAND, `${code}.TW.json`), 'utf8')); } catch { continue; }
    const weeks: any[] = (tj.data || []).filter((w: any) => w.holder400Pct != null);
    const cs: Cdl[] = (cj.candles || []).filter((c: Cdl) => c.close > 0);
    if (weeks.length < 5 || cs.length < 30) continue;
    const dates = cs.map(c => c.date);
    const idxAt = (d: string) => { let lo = 0, hi = cs.length - 1, a = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
    for (let i = 1; i < weeks.length; i++) {
      const dH = weeks[i].holder400Pct - weeks[i - 1].holder400Pct; if (!isFinite(dH)) continue;
      const iCur = idxAt(weeks[i].date), iPrev = idxAt(weeks[i - 1].date);
      if (iCur < 5 || iPrev < 0 || iCur === iPrev) continue;
      const same = (cs[iCur].close / cs[iPrev].close - 1) * 100; if (Math.abs(same) > 40) continue;
      const iFwd = iCur + 20; let fwd: number | null = null;
      if (iFwd < cs.length) { fwd = (cs[iFwd].close / cs[iCur].close - 1) * 100; if (Math.abs(fwd) > 60) continue; }
      let to = 0; for (let k = iCur - 4; k <= iCur; k++) to += cs[k].close * (cs[k].volume || 0);
      all.push({ iso: isoWeek(weeks[i].date), turnover: to / 5, dH, same, fwd });
    }
  }
  // 每週取成交額前500
  const byW = new Map<string, Obs[]>(); for (const o of all) { (byW.get(o.iso) || byW.set(o.iso, []).get(o.iso)!).push(o); }
  const kept: Obs[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const o of arr.slice(0, TOP_N)) kept.push(o); }

  const rSame = pearson(kept.map(o => o.dH), kept.map(o => o.same));
  const fwdObs = kept.filter(o => o.fwd != null);
  const rFwd = pearson(fwdObs.map(o => o.dH), fwdObs.map(o => o.fwd as number));
  const buckets = { up: { n: 0, s: 0, w: 0 }, flat: { n: 0, s: 0, w: 0 }, down: { n: 0, s: 0, w: 0 } };
  for (const o of fwdObs) { const b = o.dH >= 0.3 ? buckets.up : o.dH <= -0.3 ? buckets.down : buckets.flat; b.n++; b.s += o.fwd!; if (o.fwd! > 0) b.w++; }

  console.log('================================================');
  console.log('成交量前500大 — 大戶(400張↑)增加 vs 股價(純看個股自己)');
  console.log('================================================');
  console.log(`觀測筆數: ${kept.length.toLocaleString()} 筆 (檔×週)`);
  console.log('');
  console.log('【相關係數 r】 (+1=完全一起動, 0=沒關係, -1=反著動)');
  console.log(`  大戶變化 vs 同一週股價%     r = ${rSame.toFixed(3)}`);
  console.log(`  大戶變化 vs 之後20日股價%   r = ${rFwd.toFixed(3)}`);
  console.log('');
  console.log('【分組看之後20個交易日(約一個月)平均漲幅】');
  const fmt = (b: { n: number; s: number; w: number }) => `${b.n.toLocaleString().padStart(7)} 筆 | 平均 ${b.s / b.n >= 0 ? '+' : ''}${(b.s / b.n).toFixed(2)}% | 上漲比例 ${(100 * b.w / b.n).toFixed(1)}%`;
  console.log(`  大戶增加(≥+0.3pp): ${fmt(buckets.up)}`);
  console.log(`  大戶持平(±0.3pp ): ${fmt(buckets.flat)}`);
  console.log(`  大戶減少(≤-0.3pp): ${fmt(buckets.down)}`);
  console.log('');
  console.log('若「增加」組漲幅明顯 > 「減少」組 → 你的假說成立(正相關)');
}
main().catch(e => { console.error(e); process.exit(1); });
