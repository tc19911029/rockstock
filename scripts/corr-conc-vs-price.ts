/**
 * 籌碼集中度（主力分點）vs 股價 — 過去一年。和當初「大戶持股 vs 股價」同款，純看關係。
 *   集中度 =（前15大券商買超 − 賣超）÷ 成交量 × 100%（5日 + 20日）
 * 報三件事：①同期一起動嗎(相關r) ②能不能預測之後20日(相關r) ③分組看之後20日漲幅/上漲比例
 * 液態股(每週成交額前500)、不比大盤(純個股自己)。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const FROM = '2025-06-12', FWD = 20;

interface OHLC { date: string; close: number; volume: number }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length; if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i]; }
  const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
  return (vx <= 0 || vy <= 0) ? NaN : cov / Math.sqrt(vx * vy);
}

interface R { conc5: number; conc20: number; same5: number; fwd: number; turnover: number; iso: string }

async function main() {
  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  const all: R[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 50) continue;
    const bk = await readJ(path.join(BROKER, f));
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const conc = (t: number, w: number): number | null => { let n = 0, v = 0; for (let k = t - w + 1; k <= t; k++) { if (!bm.has(cs[k].date)) return null; n += bm.get(cs[k].date)!; v += cs[k].volume; } return v > 0 ? n / v * 100 : null; };
    for (let t = 25; t + FWD < cs.length; t++) {
      if (cs[t].date < FROM) continue;
      const c5 = conc(t, 5), c20 = conc(t, 20); if (c5 == null || c20 == null) continue;
      const same5 = (cs[t].close / cs[t - 5].close - 1) * 100;
      const fwd = (cs[t + FWD].close / cs[t].close - 1) * 100;
      if (Math.abs(same5) > 40 || Math.abs(fwd) > 60) continue;
      all.push({ conc5: c5, conc20: c20, same5, fwd, turnover: cs[t].close * (cs[t].volume || 0), iso: isoWeek(cs[t].date) });
    }
  }
  const byW = new Map<string, R[]>(); for (const r of all) { (byW.get(r.iso) || byW.set(r.iso, []).get(r.iso)!).push(r); }
  const liq: R[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }

  console.log('================================================');
  console.log(`主力分點籌碼集中度 vs 股價 — 過去一年液態股 ${liq.length.toLocaleString()} 筆`);
  console.log('================================================');
  console.log('【相關係數 r】 (+1=完全一起動 0=沒關係 -1=反著動)');
  console.log(`  5日集中度  vs 同期5日股價%    r = ${pearson(liq.map(r => r.conc5), liq.map(r => r.same5)).toFixed(3)}`);
  console.log(`  5日集中度  vs 之後20日股價%   r = ${pearson(liq.map(r => r.conc5), liq.map(r => r.fwd)).toFixed(3)}`);
  console.log(`  20日集中度 vs 之後20日股價%   r = ${pearson(liq.map(r => r.conc20), liq.map(r => r.fwd)).toFixed(3)}`);
  console.log('\n【按 5日集中度分組，看之後20日(約1個月)】');
  const buckets: [string, (r: R) => boolean][] = [
    ['爆高 >8% (隔日沖嫌疑)', r => r.conc5 > 8],
    ['偏高 3~8%', r => r.conc5 > 3 && r.conc5 <= 8],
    ['溫和 0~3%', r => r.conc5 > 0 && r.conc5 <= 3],
    ['負(主力在倒)<0%', r => r.conc5 <= 0],
  ];
  for (const [label, pick] of buckets) {
    const s = liq.filter(pick);
    if (s.length < 30) { console.log(`  ${label.padEnd(22)} ${s.length}筆(太少)`); continue; }
    const a = s.reduce((x, r) => x + r.fwd, 0) / s.length;
    const up = 100 * s.filter(r => r.fwd > 0).length / s.length;
    console.log(`  ${label.padEnd(22)} ${String(s.length).padStart(6)}筆 | 之後20日平均 ${a >= 0 ? '+' : ''}${a.toFixed(2)}% | 上漲比例 ${up.toFixed(0)}%`);
  }
  console.log('\n判讀：若各組漲幅差不多/高集中度組沒比較會漲 → 集中度跟「之後漲不漲」沒關係。');
}
main().catch(e => { console.error(e); process.exit(1); });
