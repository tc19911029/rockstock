/**
 * 批次B 出場側回測：CH8-3「賺10%才切換停利」通用化 + CH3-4 三/四線多排出場分流（2026-07-05）
 *
 * Q-A（進場-CH8-2）：「獲利<10% 跌破 MA5 續抱、≥10% 才停利」目前只開給 A/B/P，
 *   其餘短線字母跌破 MA5 即出。用同一池順勢進場公平比：即出 vs 10%切換（±停損-10%）。
 *   若切換版 train/test 期望皆不輸且最大賠不變差 → 通用化到所有短線 MA5 軌。
 *
 * Q-B（大工程-4 / CH3-04）：課程「三線多排短多沿5均 vs 四線多排長多守20均」兩條分流。
 *   進場放寬到三線多排，按進場日是否四線多排分兩組，各組比守 MA5 / MA10 / MA20：
 *   若「四線組守MA20 優於守MA5」且「三線組守MA5 優於守MA20」→ 分流有理。
 *
 * 進場（沿 backtest-ch8-momentum-exits 順勢口徑，唯放寬為三線多排）：
 *   三線多排 + 股價在 MA20 上 + MA20 上彎 + 收盤突破前一日最高 + 量 > 5日均量×1.2 + 乖離≤25%
 *   進場 = 次日開盤；MAXHOLD 40 天；絕對口徑（賺機率/平均賺賠/期望/最大賠），不比大盤。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2023-01-01', MAXHOLD = 40;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { date: string; turnover: number; entryIdx: number; csRef: OHLC[]; fourAlign: boolean }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function smaAt(cs: OHLC[], i: number, n: number): number { if (i < n - 1) return 0; let s = 0; for (let k = i - n + 1; k <= i; k++) s += cs[k].close; return s / n; }
function volSmaAt(cs: OHLC[], i: number, n: number): number { if (i < n - 1) return 0; let s = 0; for (let k = i - n + 1; k <= i; k++) s += cs[k].volume; return s / n; }

type ExitFn = (cs: OHLC[], e: number) => { ret: number; days: number };
function lastClose(cs: OHLC[], e: number) { const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e }; }

/** 整批：收盤跌破 MA_n 全出（±硬停損）*/
function maExit(n: number, stopPct: number | null): ExitFn {
  return (cs, e) => {
    const entry = cs[e].open, end = Math.min(e + MAXHOLD, cs.length - 1);
    const stop = stopPct != null ? entry * (1 - stopPct) : null;
    for (let d = e + 1; d <= end; d++) {
      if (stop != null && cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / entry - 1) * 100, days: d - e }; }
      const ma = smaAt(cs, d, n);
      if (ma > 0 && cs[d].close < ma) return { ret: (cs[d].close / entry - 1) * 100, days: d - e };
    }
    return lastClose(cs, e);
  };
}

/** CH8-3 10% 切換：獲利 <10% 跌破 MA5 續抱（洗盤條款）、≥10% 跌破 MA5 停利（±硬停損）*/
function switchExit(stopPct: number | null): ExitFn {
  return (cs, e) => {
    const entry = cs[e].open, end = Math.min(e + MAXHOLD, cs.length - 1);
    const stop = stopPct != null ? entry * (1 - stopPct) : null;
    for (let d = e + 1; d <= end; d++) {
      if (stop != null && cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / entry - 1) * 100, days: d - e }; }
      const ma5 = smaAt(cs, d, 5);
      if (ma5 > 0 && cs[d].close < ma5 && (cs[d].close / entry - 1) >= 0.10) {
        return { ret: (cs[d].close / entry - 1) * 100, days: d - e };
      }
    }
    return lastClose(cs, e);
  };
}

const QA_EXITS: Record<string, ExitFn> = {
  'MA5跌破即出(現狀他字母)': maExit(5, null),
  'MA5即出+停損-10%': maExit(5, 0.10),
  '10%切換(B/P現狀)': switchExit(null),
  '10%切換+停損-10%': switchExit(0.10),
};
const QB_EXITS: Record<string, ExitFn> = {
  '守MA5': maExit(5, 0.10),
  '守MA10': maExit(10, 0.10),
  '守MA20(長多)': maExit(20, 0.10),
};

function report(label: string, rets: { ret: number; days: number }[]) {
  if (rets.length < 25) { console.log(`  ${label.padEnd(22)} ${rets.length}筆(太少)`); return; }
  const r = rets.map(x => x.ret), win = r.filter(x => x > 0), lose = r.filter(x => x <= 0);
  const avg = r.reduce((s, x) => s + x, 0) / r.length;
  const avgWin = win.length ? win.reduce((s, x) => s + x, 0) / win.length : 0;
  const avgLose = lose.length ? lose.reduce((s, x) => s + x, 0) / lose.length : 0;
  const worst = Math.min(...r), days = rets.reduce((s, x) => s + x.days, 0) / rets.length;
  console.log(`  ${label.padEnd(22)} 賺${(100 * win.length / r.length).toFixed(0)}% | 平均賺+${avgWin.toFixed(1)}% 平均賠${avgLose.toFixed(1)}% | 期望${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | 最大賠${worst.toFixed(1)}% | 抱${days.toFixed(0)}天`);
}

async function main() {
  const files = (await fs.readdir(C)).filter(f => /^\d{4,6}\.(TW|TWO)\.json$/.test(f));
  const trades: Trade[] = [];
  for (const f of files) {
    const cdl = await readJ(path.join(C, f)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0 && c.high > 0); if (cs.length < 80) continue;
    for (let t = 60; t + 1 + MAXHOLD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ma5 = smaAt(cs, t, 5), ma10 = smaAt(cs, t, 10), ma20 = smaAt(cs, t, 20), ma60 = smaAt(cs, t, 60);
      if (!(ma5 && ma10 && ma20 && ma60)) continue;
      if (!(ma5 > ma10 && ma10 > ma20)) continue;                 // 三線多排（Q-B 放寬）
      if (!(cs[t].close > ma20)) continue;
      if (!(ma20 > smaAt(cs, t - 5, 20))) continue;               // MA20 上彎
      if (!(cs[t].close > cs[t - 1].high)) continue;              // 轉折上漲確認
      const vma5 = volSmaAt(cs, t, 5);
      if (!(vma5 > 0 && cs[t].volume > vma5 * 1.2)) continue;     // 攻擊量
      if ((cs[t].close - ma20) / ma20 > 0.25) continue;           // 不追過熱
      trades.push({
        date: cs[t + 1].date, turnover: cs[t].close * (cs[t].volume || 0),
        entryIdx: t + 1, csRef: cs, fourAlign: ma20 > ma60,
      });
    }
  }
  // 液態 top500/週
  const byW = new Map<string, Trade[]>(); for (const r of trades) { const w = isoWeek(r.date); (byW.get(w) || byW.set(w, []).get(w)!).push(r); }
  const liq: Trade[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;
  console.log(`順勢進場 ${liq.length} 筆（三線多排池；其中四線多排 ${liq.filter(t => t.fourAlign).length} 筆）  train/test 分界 ${mid}`);

  for (const [seg, pool] of [['train', liq.filter(r => r.date < mid)], ['test ', liq.filter(r => r.date >= mid)]] as const) {
    console.log(`\n===== Q-A 10%切換通用化 [${seg}]（n=${pool.length}）=====`);
    for (const [label, fn] of Object.entries(QA_EXITS)) report(label, pool.map(tr => fn(tr.csRef, tr.entryIdx)));

    console.log(`----- Q-B 三/四線分流 [${seg}] -----`);
    for (const [gname, gpool] of [['三線多排(未四線)', pool.filter(t => !t.fourAlign)], ['四線多排', pool.filter(t => t.fourAlign)]] as const) {
      console.log(`  【${gname}】 n=${gpool.length}`);
      for (const [label, fn] of Object.entries(QB_EXITS)) report('  ' + label, gpool.map(tr => fn(tr.csRef, tr.entryIdx)));
    }
  }
  console.log('\n判讀：Q-A 切換版 train/test 期望皆 ≥ 即出且最大賠不變差 → 通用化；');
  console.log('      Q-B 四線組守MA20 優且三線組守MA5 優 → 出場按排列分流有理。');
}
main().catch(e => { console.error(e); process.exit(1); });
