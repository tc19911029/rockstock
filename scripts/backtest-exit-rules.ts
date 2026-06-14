/**
 * 出場/停損端到端回測 — 證明「停損真的能賠少」（P0②，2026-06-14）。
 * 進場 = X 法人接刀（在跌/長黑 + 法人買，剔除大戶超高）；對每筆試多種出場，比賺多賠少。
 * 全市場液態股、隔日開盤進場、最多持有 20 交易日。報「絕對」指標（不比大盤，對齊使用者目標）：
 *   賺的機率 / 平均賺(贏家) / 平均賠(輸家) / 期望值 / 最大單筆賠 / 平均持有天數。train/test 各半。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const BROKER = path.join(process.cwd(), 'data/chips/TW/broker');
const INST = path.join(process.cwd(), 'data/chips/TW/inst');
const TDCC = path.join(process.cwd(), 'data/chips/TW/tdcc');
const FROM = '2024-07-20', MAXHOLD = 20;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { date: string; turnover: number; entryIdx: number; csRef: OHLC[]; ma10: number[]; }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }

// 出場策略：回傳 (報酬%, 持有天數)
type Exit = (cs: OHLC[], e: number, ma10: number[]) => { ret: number; days: number };
const exits: Record<string, Exit> = {
  '死抱20天(不停損)': (cs, e) => { const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e }; },
  '固定停損-7%': (cs, e) => {
    const stop = cs[e].open * 0.93;
    for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) {
      if (cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / cs[e].open - 1) * 100, days: d - e }; }
    }
    const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e };
  },
  '固定停損-10%': (cs, e) => {
    const stop = cs[e].open * 0.90;
    for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) {
      if (cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / cs[e].open - 1) * 100, days: d - e }; }
    }
    const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e };
  },
  '跌破MA10收盤出': (cs, e, ma10) => {
    for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) {
      if (ma10[d] > 0 && cs[d].close < ma10[d]) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e };
    }
    const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e };
  },
  '移動停利(回落8%)': (cs, e) => {
    let peak = cs[e].open;
    for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) {
      peak = Math.max(peak, cs[d].close);
      if (cs[d].close <= peak * 0.92) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e };
    }
    const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e };
  },
  '停損-7%+移動停利8%': (cs, e) => {
    const stop = cs[e].open * 0.93; let peak = cs[e].open;
    for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) {
      if (cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / cs[e].open - 1) * 100, days: d - e }; }
      peak = Math.max(peak, cs[d].close);
      if (cs[d].close <= peak * 0.92) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e };
    }
    const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e };
  },
};

function report(label: string, rets: { ret: number; days: number }[]) {
  if (rets.length < 25) { console.log(`  ${label.padEnd(22)} ${rets.length}筆(太少)`); return; }
  const r = rets.map(x => x.ret);
  const win = r.filter(x => x > 0), lose = r.filter(x => x <= 0);
  const avg = r.reduce((s, x) => s + x, 0) / r.length;
  const avgWin = win.length ? win.reduce((s, x) => s + x, 0) / win.length : 0;
  const avgLose = lose.length ? lose.reduce((s, x) => s + x, 0) / lose.length : 0;
  const worst = Math.min(...r);
  const days = rets.reduce((s, x) => s + x.days, 0) / rets.length;
  console.log(`  ${label.padEnd(22)} 賺${(100 * win.length / r.length).toFixed(0)}% | 平均賺+${avgWin.toFixed(1)}% 平均賠${avgLose.toFixed(1)}% | 期望${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | 最大賠${worst.toFixed(1)}% | 抱${days.toFixed(0)}天`);
}

async function main() {
  const files = (await fs.readdir(BROKER)).filter(f => /^\d{4}\.json$/.test(f));
  const trades: Trade[] = [];
  // 大戶水位超高門檻
  const HH = { h100: 88, h400: 86, h1000: 80 };
  for (const f of files) {
    const code = f.replace('.json', '');
    const cdl = await readJ(path.join(C, `${code}.TW.json`)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0); if (cs.length < 50) continue;
    const [bk, ins, tj] = await Promise.all([readJ(path.join(BROKER, f)), readJ(path.join(INST, f)), readJ(path.join(TDCC, f))]);
    const bm = new Map<string, number>(); for (const d of (bk?.data || [])) bm.set(d.date, d.netDifference ?? 0);
    const im = new Map<string, number>(); for (const d of (ins?.data || [])) im.set(d.date, d.total ?? 0);
    const tdcc = (tj?.data || []).filter((r: any) => r).sort((a: any, b: any) => a.date < b.date ? -1 : 1);
    const ma10: number[] = cs.map((_, i) => { if (i < 9) return 0; let s = 0; for (let k = i - 9; k <= i; k++) s += cs[k].close; return s / 10; });
    for (let t = 25; t + 1 + MAXHOLD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      // X 進場：在跌/長黑 + 法人買，剔除大戶超高
      const dip5 = (cs[t].close / cs[t - 5].close - 1) * 100;
      const todayChg = cs[t].open > 0 ? (cs[t].close / cs[t].open - 1) * 100 : 0;
      let inst5 = 0, ok = true; for (let k = t - 4; k <= t; k++) { if (!im.has(cs[k].date)) { ok = false; break; } inst5 += im.get(cs[k].date)!; }
      if (!ok) continue;
      const weak = dip5 < -3 || todayChg < -3;
      if (!(weak && inst5 > 0)) continue;
      // 剔除大戶超高
      const px = cs[t].close; let hl: number | null = null;
      for (let i = tdcc.length - 1; i >= 0; i--) { if (tdcc[i].date <= cs[t].date) { hl = px >= 250 ? tdcc[i].holder100Pct : px >= 50 ? tdcc[i].holder400Pct : tdcc[i].holder1000Pct; break; } }
      const th = px >= 250 ? HH.h100 : px >= 50 ? HH.h400 : HH.h1000;
      if (hl != null && hl > th) continue;
      trades.push({ date: cs[t + 1].date, turnover: cs[t].close * (cs[t].volume || 0), entryIdx: t + 1, csRef: cs, ma10 });
    }
  }
  // 液態 top500/週
  const byW = new Map<string, Trade[]>(); for (const r of trades) { (byW.get(isoWeek(r.date)) || byW.set(isoWeek(r.date), []).get(isoWeek(r.date))!).push(r); }
  const liq: Trade[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  const mid = liq[Math.floor(liq.length / 2)].date;

  const run = (name: string, pool: Trade[]) => {
    console.log(`\n===== ${name}（${pool.length} 筆 X 進場）=====`);
    for (const [label, fn] of Object.entries(exits)) {
      report(label, pool.map(tr => fn(tr.csRef, tr.entryIdx, tr.ma10)));
    }
  };
  console.log('================================================');
  console.log('出場/停損回測 — 進場=X法人接刀，看哪種出場最賺多賠少（絕對，不比大盤）');
  console.log('================================================');
  run('前一年 train', liq.filter(r => r.date < mid));
  run('後一年 test', liq.filter(r => r.date >= mid));
  console.log('\n判讀：重點看「平均賠」「最大賠」有沒有被停損壓小（賠少），同時「期望值」沒掉太多（賺多）。');
}
main().catch(e => { console.error(e); process.exit(1); });
