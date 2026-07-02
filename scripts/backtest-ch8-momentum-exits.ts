/**
 * CH8 操作戰法「順勢進場」出場回測 — 公平驗 8-5 三條均線分批 vs 整批 vs 固定停損（2026-06-27）。
 *
 * 為什麼新寫：backtest-exit-rules.ts 的進場是「法人接刀（跌深買）」逆勢單，
 * 但 CH8 戰法（8-2~8-5）是設計給**強勢飆股順勢**用的，進場不對盤會冤枉 MA 移動停利。
 * 這支用書本/課程的順勢進場：多頭排列 + 股價在 MA20 之上 + 收盤突破前一日最高（轉折上漲確認）。
 *
 * 進場 = 觸發日次一交易日開盤；最多持有 MAXHOLD 交易日（給波段空間，讓移動停利自己決定何時出）。
 * 報「絕對」指標（不比大盤，對齊使用者北極星）：賺機率 / 平均賺 / 平均賠 / 期望 / 最大單筆賠 / 抱天數。train/test 各半。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const FROM = '2023-01-01', MAXHOLD = 40;

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { date: string; turnover: number; entryIdx: number; csRef: OHLC[]; }
async function readJ(p: string) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function isoWeek(d: string) { const dt = new Date(d + 'T00:00:00Z'); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return dt.getUTCFullYear() + '-' + Math.round((dt.getTime() - f.getTime()) / 6048e5); }
function smaAt(cs: OHLC[], i: number, n: number): number { if (i < n - 1) return 0; let s = 0; for (let k = i - n + 1; k <= i; k++) s += cs[k].close; return s / n; }
function volSmaAt(cs: OHLC[], i: number, n: number): number { if (i < n - 1) return 0; let s = 0; for (let k = i - n + 1; k <= i; k++) s += cs[k].volume; return s / n; }

// ── 出場策略（與 backtest-exit-rules.ts 同口徑）──
type Exit = (cs: OHLC[], e: number) => { ret: number; days: number };
function lastClose(cs: OHLC[], e: number) { const x = Math.min(e + MAXHOLD, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e }; }

function fullMAExit(cs: OHLC[], e: number, n: number): { ret: number; days: number } {
  const end = Math.min(e + MAXHOLD, cs.length - 1);
  for (let d = e + 1; d <= end; d++) { const ma = smaAt(cs, d, n); if (ma > 0 && cs[d].close < ma) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e }; }
  return lastClose(cs, e);
}
// 8-5 三條均線分批：3 份，收盤跌破 MA5/10/20 各出 1/3（階梯式）。賺>20% 跌破 MA5 剩餘全出。
// stopPct≠null：盤中破 -stop% 剩餘一次全出。報酬 = 3 份等權平均。不模擬站回加碼（接回價噪音）。
function partialMAExit(cs: OHLC[], e: number, stopPct: number | null): { ret: number; days: number } {
  const entry = cs[e].open, end = Math.min(e + MAXHOLD, cs.length - 1);
  const stop = stopPct != null ? entry * (1 - stopPct) : null;
  const sold = [false, false, false]; let held = 3; const rets: number[] = []; let lastDay = e;
  for (let d = e + 1; d <= end && held > 0; d++) {
    lastDay = d;
    if (stop != null && cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); while (held > 0) { rets.push(px / entry - 1); held--; } break; }
    const c = cs[d].close, ma5 = smaAt(cs, d, 5), ma10 = smaAt(cs, d, 10), ma20 = smaAt(cs, d, 20);
    if (!sold[0] && ma5 > 0 && c < ma5) { sold[0] = true; rets.push(c / entry - 1); held--; }
    if (held > 0 && !sold[1] && ma10 > 0 && c < ma10) { sold[1] = true; rets.push(c / entry - 1); held--; }
    if (held > 0 && !sold[2] && ma20 > 0 && c < ma20) { sold[2] = true; rets.push(c / entry - 1); held--; }
    if (held > 0 && (c / entry - 1) >= 0.20 && ma5 > 0 && c < ma5) { while (held > 0) { rets.push(c / entry - 1); held--; } break; }
  }
  while (held > 0) { rets.push(cs[end].close / entry - 1); held--; }
  return { ret: (rets.reduce((s, x) => s + x, 0) / rets.length) * 100, days: lastDay - e };
}

const exits: Record<string, Exit> = {
  '死抱40天(不停損)': (cs, e) => lastClose(cs, e),
  '固定停損-7%': (cs, e) => { const stop = cs[e].open * 0.93; for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) if (cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / cs[e].open - 1) * 100, days: d - e }; } return lastClose(cs, e); },
  '固定停損-10%': (cs, e) => { const stop = cs[e].open * 0.90; for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) if (cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); return { ret: (px / cs[e].open - 1) * 100, days: d - e }; } return lastClose(cs, e); },
  '移動停利(回落8%)': (cs, e) => { let peak = cs[e].open; for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) { peak = Math.max(peak, cs[d].close); if (cs[d].close <= peak * 0.92) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e }; } return lastClose(cs, e); },
  '8-2前一日最低出': (cs, e) => { for (let d = e + 1; d <= Math.min(e + MAXHOLD, cs.length - 1); d++) if (cs[d].close < cs[d - 1].low) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e }; return lastClose(cs, e); },
  '整批跌破MA5全出': (cs, e) => fullMAExit(cs, e, 5),
  '整批跌破MA10全出': (cs, e) => fullMAExit(cs, e, 10),
  '整批跌破MA20全出': (cs, e) => fullMAExit(cs, e, 20),
  '8-5分批MA5/10/20': (cs, e) => partialMAExit(cs, e, null),
  '8-5分批+停損5%': (cs, e) => partialMAExit(cs, e, 0.05),
};

function report(label: string, rets: { ret: number; days: number }[]) {
  if (rets.length < 25) { console.log(`  ${label.padEnd(20)} ${rets.length}筆(太少)`); return; }
  const r = rets.map(x => x.ret), win = r.filter(x => x > 0), lose = r.filter(x => x <= 0);
  const avg = r.reduce((s, x) => s + x, 0) / r.length;
  const avgWin = win.length ? win.reduce((s, x) => s + x, 0) / win.length : 0;
  const avgLose = lose.length ? lose.reduce((s, x) => s + x, 0) / lose.length : 0;
  const worst = Math.min(...r), days = rets.reduce((s, x) => s + x.days, 0) / rets.length;
  console.log(`  ${label.padEnd(20)} 賺${(100 * win.length / r.length).toFixed(0)}% | 平均賺+${avgWin.toFixed(1)}% 平均賠${avgLose.toFixed(1)}% | 期望${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% | 最大賠${worst.toFixed(1)}% | 抱${days.toFixed(0)}天`);
}

async function main() {
  const files = (await fs.readdir(C)).filter(f => /^\d{4}\.TW\.json$/.test(f));
  const trades: Trade[] = [];
  let scanned = 0;
  for (const f of files) {
    const cdl = await readJ(path.join(C, f)); if (!cdl) continue;
    const cs: OHLC[] = (cdl.candles || []).filter((c: OHLC) => c.close > 0 && c.high > 0); if (cs.length < 80) continue;
    scanned++;
    for (let t = 60; t + 1 + MAXHOLD < cs.length; t++) {
      if (cs[t].date < FROM || !(cs[t + 1].open > 0)) continue;
      const ma5 = smaAt(cs, t, 5), ma10 = smaAt(cs, t, 10), ma20 = smaAt(cs, t, 20), ma60 = smaAt(cs, t, 60);
      if (!(ma5 && ma10 && ma20 && ma60)) continue;
      // 順勢進場：多頭排列 + 股價在 MA20 之上 + MA20 上彎
      if (!(ma5 > ma10 && ma10 > ma20 && ma20 > ma60)) continue;
      if (!(cs[t].close > ma20)) continue;
      if (!(ma20 > smaAt(cs, t - 5, 20))) continue;            // MA20 上彎
      // 8-2 轉折上漲確認：收盤突破前一日最高
      if (!(cs[t].close > cs[t - 1].high)) continue;
      // 大量攻擊：量 > 5 日均量 1.2 倍
      const vma5 = volSmaAt(cs, t, 5);
      if (!(vma5 > 0 && cs[t].volume > vma5 * 1.2)) continue;
      // 不追末升段過熱：乖離 MA20 ≤ 25%
      if ((cs[t].close - ma20) / ma20 > 0.25) continue;
      trades.push({ date: cs[t + 1].date, turnover: cs[t].close * (cs[t].volume || 0), entryIdx: t + 1, csRef: cs });
    }
  }
  // 液態 top500/週
  const byW = new Map<string, Trade[]>(); for (const r of trades) { const w = isoWeek(r.date); (byW.get(w) || byW.set(w, []).get(w)!).push(r); }
  const liq: Trade[] = []; for (const arr of byW.values()) { arr.sort((a, b) => b.turnover - a.turnover); for (const r of arr.slice(0, 500)) liq.push(r); }
  liq.sort((a, b) => a.date < b.date ? -1 : 1);
  if (liq.length < 50) { console.log(`進場太少（${liq.length}）`); return; }
  const mid = liq[Math.floor(liq.length / 2)].date;

  const run = (name: string, pool: Trade[]) => {
    console.log(`\n===== ${name}（${pool.length} 筆順勢進場）=====`);
    for (const [label, fn] of Object.entries(exits)) report(label, pool.map(tr => fn(tr.csRef, tr.entryIdx)));
  };
  console.log('================================================');
  console.log(`CH8 順勢進場出場回測 — ${scanned} 檔掃描 | 公平驗 8-5 分批 vs 整批 vs 固定停損（絕對，不比大盤）`);
  console.log('================================================');
  run('前段 train', liq.filter(r => r.date < mid));
  run('後段 test', liq.filter(r => r.date >= mid));
  console.log('\n判讀：分批要被採用，須 train/test 都「最大賠/平均賠較小」且「期望」不輸整批/固定停損。');
}
main().catch(e => { console.error(e); process.exit(1); });
