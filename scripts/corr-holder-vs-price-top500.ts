/**
 * 純相關性檢查（聚焦版）：
 *   宇宙 = 每週成交額前 500 大股
 *   假說 = 這週大戶持股(400張↑)增加 → 下週(之後5個交易日)股價上漲
 *
 * 不比大盤、不算超額。純看個股自己下週漲不漲。
 */
import { promises as fs } from 'fs';
import path from 'path';

const TDCC_DIR = path.join(process.cwd(), 'data/chips/TW/tdcc');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TOP_N = 500;
const FWD_DAYS = 5; // 下週 ≈ 5 個交易日

interface Cdl { date: string; close: number; volume: number }

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i]*xs[i]; syy += ys[i]*ys[i]; sxy += xs[i]*ys[i]; }
  const cov = sxy - sx*sy/n, vx = sxx - sx*sx/n, vy = syy - sy*sy/n;
  if (vx <= 0 || vy <= 0) return NaN;
  return cov / Math.sqrt(vx*vy);
}

// 把日期歸到 ISO 週 'YYYY-Www'，吸收各檔 TDCC 日期 ±幾天的錯位
function isoWeek(d: string): string {
  const dt = new Date(d + 'T00:00:00Z');
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

interface Obs { code: string; iso: string; turnover: number; dH: number; fwd: number | null }

async function main() {
  const tdccFiles = (await fs.readdir(TDCC_DIR)).filter(f => f.endsWith('.json'));
  const allObs: Obs[] = [];

  for (const tf of tdccFiles) {
    const code = tf.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;

    let tdcc: any, cdl: any;
    try {
      tdcc = JSON.parse(await fs.readFile(path.join(TDCC_DIR, tf), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }

    const weeks: any[] = (tdcc.data || []).filter((w: any) => w.holder400Pct != null);
    const candles: Cdl[] = (cdl.candles || []).filter((c: Cdl) => c.close > 0);
    if (weeks.length < 5 || candles.length < 30) continue;
    const dates = candles.map(c => c.date);

    const idxAtOrBefore = (d: string): number => {
      let lo = 0, hi = candles.length - 1, ans = -1;
      while (lo <= hi) { const m = (lo+hi)>>1; if (dates[m] <= d) { ans = m; lo = m+1; } else hi = m-1; }
      return ans;
    };

    for (let i = 1; i < weeks.length; i++) {
      const dH = weeks[i].holder400Pct - weeks[i-1].holder400Pct;
      if (!isFinite(dH)) continue;
      const iCur = idxAtOrBefore(weeks[i].date);
      if (iCur < 5) continue;
      const cClose = candles[iCur].close;

      // 流動性 = 近 5 日平均成交額(收盤×量)
      let to = 0, cnt = 0;
      for (let k = iCur - 4; k <= iCur; k++) { to += candles[k].close * (candles[k].volume || 0); cnt++; }
      const turnover = cnt ? to / cnt : 0;

      const iFwd = iCur + FWD_DAYS;
      let fwd: number | null = null;
      if (iFwd < candles.length) fwd = (candles[iFwd].close / cClose - 1) * 100;
      if (fwd != null && Math.abs(fwd) > 40) continue; // 濾除權息/壞bar跳階

      allObs.push({ code, iso: isoWeek(weeks[i].date), turnover, dH, fwd });
    }
  }

  // 每個 ISO 週內，依成交額排名取前 500
  const byWeek = new Map<string, Obs[]>();
  for (const o of allObs) {
    if (!byWeek.has(o.iso)) byWeek.set(o.iso, []);
    byWeek.get(o.iso)!.push(o);
  }
  const kept: Obs[] = [];
  for (const arr of byWeek.values()) {
    arr.sort((a, b) => b.turnover - a.turnover);
    for (const o of arr.slice(0, TOP_N)) if (o.fwd != null) kept.push(o);
  }

  const r = pearson(kept.map(o => o.dH), kept.map(o => o.fwd as number));
  const stocks = new Set(kept.map(o => o.code)).size;

  const buckets = {
    up:   { n: 0, sum: 0, win: 0 },
    flat: { n: 0, sum: 0, win: 0 },
    down: { n: 0, sum: 0, win: 0 },
  };
  for (const o of kept) {
    const b = o.dH >= 0.3 ? buckets.up : o.dH <= -0.3 ? buckets.down : buckets.flat;
    b.n++; b.sum += o.fwd!; if (o.fwd! > 0) b.win++;
  }

  console.log('================================================');
  console.log('成交額前500大股：大戶(400張↑)增加 → 下週股價');
  console.log('================================================');
  console.log(`涵蓋股票: ${stocks} 檔   觀測: ${kept.length.toLocaleString()} 筆（檔×週）`);
  console.log(`下週 = 之後 ${FWD_DAYS} 個交易日`);
  console.log('');
  console.log('【相關係數 r】 +1=完全正相關 0=無關 -1=反相關');
  console.log(`  大戶持股變化 vs 下週股價%   r = ${r.toFixed(3)}`);
  console.log('');
  console.log('【分組：下週平均漲幅】');
  const fmt = (b: {n:number;sum:number;win:number}) =>
    `${b.n.toLocaleString().padStart(7)} 筆 | 下週平均 ${b.sum/b.n>=0?'+':''}${(b.sum/b.n).toFixed(2)}% | 上漲比例 ${(100*b.win/b.n).toFixed(1)}%`;
  console.log(`  大戶增加(≥+0.3pp): ${fmt(buckets.up)}`);
  console.log(`  大戶持平(±0.3pp ): ${fmt(buckets.flat)}`);
  console.log(`  大戶減少(≤-0.3pp): ${fmt(buckets.down)}`);
  console.log('');
  console.log('若「增加」組下週漲幅明顯 > 「減少」組 → 你的假說成立(正相關)');
}

main().catch(e => { console.error(e); process.exit(1); });
