/**
 * 門檻掃描：「近5日跌 + 法人集中度 > X%」中，X 拉高是否效果更好
 * 對照 CMoney 教學「天期越短門檻要越高」的說法
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5;

interface Cdl { date: string; close: number; volume: number }
interface Row { conc: number; past5: number; fwd: number }

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const rows: Row[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst: any, cdl: any;
    try {
      inst = JSON.parse(await fs.readFile(path.join(INST_DIR, f), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }
    const idays: any[] = inst.data || [];
    const candles: Cdl[] = (cdl.candles || []).filter((c: Cdl) => c.close > 0);
    if (idays.length < 20 || candles.length < 30) continue;
    const instByDate = new Map<string, number>();
    for (const d of idays) instByDate.set(d.date, d.total ?? 0);
    for (let t = 5; t + FWD < candles.length; t++) {
      const d = candles[t].date;
      if (!instByDate.has(d)) continue;
      let inst5 = 0, vol5 = 0, miss = false;
      for (let k = t - 4; k <= t; k++) {
        const dk = candles[k].date;
        if (!instByDate.has(dk)) { miss = true; break; }
        inst5 += instByDate.get(dk)!; vol5 += candles[k].volume || 0;
      }
      if (miss || vol5 <= 0) continue;
      const conc = inst5 / vol5 * 100;
      const past5 = (candles[t].close / candles[t - 5].close - 1) * 100;
      const fwd = (candles[t + FWD].close / candles[t].close - 1) * 100;
      if (Math.abs(past5) > 40 || Math.abs(fwd) > 40) continue;
      rows.push({ conc, past5, fwd });
    }
  }

  const base = rows.reduce((s, r) => s + r.fwd, 0) / rows.length;
  const baseWin = 100 * rows.filter(r => r.fwd > 0).length / rows.length;
  console.log(`全體基準: ${rows.length} 筆 | 下週 +${base.toFixed(2)}% | 漲 ${baseWin.toFixed(0)}%\n`);
  console.log('近5日跌>3% + 法人集中度門檻掃描：');
  console.log('門檻      筆數    下週平均   勝率   贏基準');
  console.log('------------------------------------------------');
  for (const X of [1, 3, 5, 8, 10, 15, 20]) {
    const sub = rows.filter(r => r.past5 < -3 && r.conc > X);
    if (!sub.length) { console.log(`>${X}%`.padEnd(8) + '   (無)'); continue; }
    const avg = sub.reduce((s, r) => s + r.fwd, 0) / sub.length;
    const win = 100 * sub.filter(r => r.fwd > 0).length / sub.length;
    console.log(
      `>${X}%`.padEnd(8) + `  ${String(sub.length).padStart(5)}   ` +
      `+${avg.toFixed(2)}%`.padStart(8) + `   ${win.toFixed(0)}%`.padStart(5) +
      `   +${(avg - base).toFixed(2)}%`.padStart(8)
    );
  }
}
main().catch(e => { console.error(e); process.exit(1); });
