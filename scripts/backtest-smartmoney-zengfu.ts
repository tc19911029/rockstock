/**
 * 「增幅」回測 — 徐黎芳影片畫面顯示她按「籌碼集中度增幅」排序（非集中度高低）
 *   增幅 = 今日5日集中度 比 昨日5日集中度 跳多少
 *
 * 用法人資料(代理主力分點)比較三種排序，看哪個準：
 *   A. 集中度「高低」(我們現在用的)
 *   B. 增幅「絕對」(pp) = 今日集中度 − 昨日集中度
 *   C. 增幅「百分比」(她畫面那欄) = (今日−昨日)/|昨日| ×100
 * 進場隔日開盤、持有5日、算贏大盤(^TWII)
 */
import { promises as fs } from 'fs';
import path from 'path';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const FWD = 5;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Row { conc: number; zfPP: number; zfRatio: number; dip5: number; ret: number; excess: number }

function stat(label: string, rows: Row[]) {
  if (rows.length < 5) { console.log(`  ${label.padEnd(34)} 樣本太少(${rows.length})`); return; }
  const n = rows.length;
  const avg = rows.reduce((s, r) => s + r.ret, 0) / n;
  const win = 100 * rows.filter(r => r.ret > 0).length / n;
  const exc = rows.reduce((s, r) => s + r.excess, 0) / n;
  const winM = 100 * rows.filter(r => r.excess > 0).length / n;
  const g = rows.filter(r => r.ret > 0).reduce((s, r) => s + r.ret, 0);
  const l = rows.filter(r => r.ret < 0).reduce((s, r) => s + Math.abs(r.ret), 0);
  const pf = l > 0 ? g / l : Infinity;
  console.log(`  ${label.padEnd(34)} ${String(n).padStart(4)}筆 | 報酬${avg>=0?'+':''}${avg.toFixed(2)}% | 勝${win.toFixed(0)}% | 超額${exc>=0?'+':''}${exc.toFixed(2)}% | 贏大盤${winM.toFixed(0)}% | PF${pf===Infinity?'∞':pf.toFixed(2)}`);
}

function topByKey(rows: Row[], key: (r: Row) => number, frac: number): Row[] {
  const sorted = [...rows].sort((a, b) => key(b) - key(a));
  return sorted.slice(0, Math.max(5, Math.floor(rows.length * frac)));
}

async function main() {
  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));
  const twii: OHLC[] = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, '^TWII.json'), 'utf8')).candles;
  const td = twii.map(c => c.date);
  const twAt = (d: string): number | null => { let lo=0,hi=td.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(td[m]<=d){a=m;lo=m+1}else hi=m-1} return a<0?null:twii[a].close; };

  const rows: Row[] = [];
  let minD='9999', maxD='0';

  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;
    let inst: any, cdl: any;
    try {
      inst = JSON.parse(await fs.readFile(path.join(INST_DIR, f), 'utf8'));
      cdl = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${code}.TW.json`), 'utf8'));
    } catch { continue; }
    const idays: any[] = inst.data || [];
    const candles: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0);
    if (idays.length < 10 || candles.length < 30) continue;
    const im = new Map<string, number>();
    for (const d of idays) im.set(d.date, d.total ?? 0);

    const conc5 = (t: number): number | null => {
      let inst5 = 0, vol5 = 0;
      for (let k = t - 4; k <= t; k++) {
        if (!im.has(candles[k].date)) return null;
        inst5 += im.get(candles[k].date)!; vol5 += candles[k].volume || 0;
      }
      return vol5 > 0 ? inst5 / vol5 * 100 : null;
    };

    for (let t = 6; t + FWD < candles.length; t++) {
      if (!im.has(candles[t].date)) continue;
      const cT = conc5(t), cY = conc5(t - 1);
      if (cT == null || cY == null) continue;
      const zfPP = cT - cY;
      const zfRatio = (cT - cY) / Math.max(Math.abs(cY), 0.5) * 100; // 0.5% 底防爆
      const dip5 = (candles[t].close / candles[t - 5].close - 1) * 100;

      const entry = candles[t + 1].open;
      if (!(entry > 0)) continue;
      const exit = candles[Math.min(t + 1 + FWD, candles.length - 1)].close;
      const ret = (exit / entry - 1) * 100;
      if (Math.abs(ret) > 50) continue;
      const tE = twAt(candles[t + 1].date), tX = twAt(candles[Math.min(t + 1 + FWD, candles.length - 1)].date);
      const mkt = tE && tX ? (tX / tE - 1) * 100 : 0;
      rows.push({ conc: cT, zfPP, zfRatio, dip5, ret, excess: ret - mkt });
      if (candles[t].date < minD) minD = candles[t].date;
      if (candles[t].date > maxD) maxD = candles[t].date;
    }
  }

  console.log('================================================');
  console.log('「增幅」回測：集中度高低 vs 增幅 哪個準');
  console.log(`期間 ${minD}~${maxD}  全體 ${rows.length} 筆  進場隔日開盤持有${FWD}日`);
  console.log('================================================');
  stat('全體基準', rows);
  console.log('\n【純排序：取前 10% 看下週】(她的方式=按增幅排前面)');
  stat('A 按集中度高低 top10%', topByKey(rows, r => r.conc, 0.1));
  stat('B 按增幅(絕對pp) top10%', topByKey(rows, r => r.zfPP, 0.1));
  stat('C 按增幅(百分比) top10%', topByKey(rows, r => r.zfRatio, 0.1));
  console.log('\n【加「在跌」前提（她招牌：跌+主力逆勢買）】');
  const dipRows = rows.filter(r => r.dip5 < -3);
  stat('現行 跌+集中度>8%', dipRows.filter(r => r.conc > 8));
  stat('跌+增幅(pp) top25%', topByKey(dipRows, r => r.zfPP, 0.25));
  stat('跌+增幅(百分比) top25%', topByKey(dipRows, r => r.zfRatio, 0.25));
  console.log('\n判讀：超額>0 且贏大盤>55% 才算有效；比現行「集中度>8%」高才值得換。');
}

main().catch(e => { console.error(e); process.exit(1); });
