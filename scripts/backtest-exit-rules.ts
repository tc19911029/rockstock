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

// 任意期 SMA（用於 8-5 三條均線分批）
function smaAt(cs: OHLC[], i: number, n: number): number {
  if (i < n - 1) return 0;
  let s = 0; for (let k = i - n + 1; k <= i; k++) s += cs[k].close; return s / n;
}

// CH8 8-5 三條均線分批出場：部位拆 3 份，收盤跌破 MA5/MA10/MA20 各出 1/3（階梯式，外層先出）。
// 賺 >20% 跌破 MA5 → 剩餘全出（總停利）。stopPct≠null 時，盤中破 -stop% 剩餘一次全出（絕對停損）。
// 報酬 = 3 份各自 (出場價/進場open−1) 的等權平均。不模擬站回加碼（加碼會引入接回價噪音，先只驗分批「出」的賠少效果）。
function partialMAExit(cs: OHLC[], e: number, stopPct: number | null): { ret: number; days: number } {
  const entry = cs[e].open;
  const end = Math.min(e + MAXHOLD, cs.length - 1);
  const stop = stopPct != null ? entry * (1 - stopPct) : null;
  const sold = [false, false, false]; // [MA5層, MA10層, MA20層]
  let held = 3; const rets: number[] = []; let lastDay = e;
  for (let d = e + 1; d <= end && held > 0; d++) {
    lastDay = d;
    if (stop != null && cs[d].low <= stop) { const px = Math.min(cs[d].open, stop); while (held > 0) { rets.push(px / entry - 1); held--; } break; }
    const c = cs[d].close;
    const ma5 = smaAt(cs, d, 5), ma10 = smaAt(cs, d, 10), ma20 = smaAt(cs, d, 20);
    if (!sold[0] && ma5 > 0 && c < ma5) { sold[0] = true; rets.push(c / entry - 1); held--; }
    if (held > 0 && !sold[1] && ma10 > 0 && c < ma10) { sold[1] = true; rets.push(c / entry - 1); held--; }
    if (held > 0 && !sold[2] && ma20 > 0 && c < ma20) { sold[2] = true; rets.push(c / entry - 1); held--; }
    if (held > 0 && (c / entry - 1) >= 0.20 && ma5 > 0 && c < ma5) { while (held > 0) { rets.push(c / entry - 1); held--; } break; }
  }
  while (held > 0) { rets.push(cs[end].close / entry - 1); held--; }
  return { ret: (rets.reduce((s, x) => s + x, 0) / rets.length) * 100, days: lastDay - e };
}

// 整批跌破單一均線全出（與分批對照的基準）
function fullMAExit(cs: OHLC[], e: number, n: number): { ret: number; days: number } {
  const end = Math.min(e + MAXHOLD, cs.length - 1);
  for (let d = e + 1; d <= end; d++) { const ma = smaAt(cs, d, n); if (ma > 0 && cs[d].close < ma) return { ret: (cs[d].close / cs[e].open - 1) * 100, days: d - e }; }
  return { ret: (cs[end].close / cs[e].open - 1) * 100, days: end - e };
}

// ── 課程 CH9-3(二)(三)（2026-07-04）：爆量反轉分批停利 ────────────────────────
// 訊號 bar 判定（鏡像 lib/agents/holdingsActionEngine.detectCh9BlowoffReversalBar）：
// 爆大量（前5日均量×1.5）長黑吞噬 或 長上影（上影>50%全長），且收盤未破前日低。
function ch9Kind(cs: OHLC[], i: number): 'engulf' | 'upper' | null {
  if (i < 6) return null;
  const bar = cs[i], prev = cs[i - 1];
  if (bar.close < prev.low) return null;
  let s = 0, n = 0; for (let k = i - 5; k <= i - 1; k++) { if (cs[k].volume > 0) { s += cs[k].volume; n++; } }
  if (n === 0 || bar.volume / (s / n) < 1.5) return null;
  if (prev.close > prev.open && bar.close < bar.open && bar.open > prev.close && bar.close < prev.open) return 'engulf';
  const full = bar.high - bar.low, upper = bar.high - Math.max(bar.open, bar.close);
  if (full > 0 && upper / full > 0.5) return 'upper';
  return null;
}
// 基線 = 固定停損-10%；持有中訊號日（獲利>15%）收盤出1/2、次日收黑再全出，否則回基線。
function ch9PartialTpExit(cs: OHLC[], e: number): { ret: number; days: number } {
  const entry = cs[e].open, stop = entry * 0.90;
  const end = Math.min(e + MAXHOLD, cs.length - 1);
  let half = false, halfRet = 0, sigIdx = -1;
  for (let d = e + 1; d <= end; d++) {
    if (cs[d].low <= stop) {
      const px = Math.min(cs[d].open, stop); const r = px / entry - 1;
      return { ret: (half ? (halfRet + r) / 2 : r) * 100, days: d - e };
    }
    if (half && d === sigIdx + 1 && cs[d].close < cs[sigIdx].close) {
      return { ret: ((halfRet + (cs[d].close / entry - 1)) / 2) * 100, days: d - e };
    }
    if (!half) {
      const kind = ch9Kind(cs, d);
      if (kind && cs[d].close / entry - 1 > 0.15) { half = true; halfRet = cs[d].close / entry - 1; sigIdx = d; }
    }
  }
  const tail = cs[end].close / entry - 1;
  return { ret: (half ? (halfRet + tail) / 2 : tail) * 100, days: end - e };
}

// ── 課程 CH10-1（2026-07-04）：套牢 10%+ 反彈遇壓不漲認賠（60 天視窗，對照死抱60天）──
// 反彈遇壓不漲（鏡像 lib/portfolio/trappedTier.detectReboundStallAtResistance）：
// 近30根波段低點反彈≥3% → 觸 MA20×0.98 被壓回 → 觸壓後連3日未創反彈新高。
const HOLD60 = 60;
function reboundStallAt(cs: OHLC[], d: number): boolean {
  if (d < 25) return false;
  const start = Math.max(0, d - 29);
  let lowIdx = start;
  for (let i = start; i <= d; i++) { if (cs[i].low < cs[lowIdx].low) lowIdx = i; }
  if (lowIdx >= d) return false;
  let reboundHigh = -Infinity;
  for (let i = lowIdx + 1; i <= d; i++) { if (cs[i].high > reboundHigh) reboundHigh = cs[i].high; }
  if (reboundHigh / cs[lowIdx].low - 1 < 0.03) return false;
  let touchIdx = -1;
  for (let i = lowIdx + 1; i <= d; i++) {
    const ma20 = smaAt(cs, i, 20);
    if (ma20 > 0 && cs[i].high >= ma20 * 0.98 && cs[i].close < ma20) { touchIdx = i; break; }
  }
  if (touchIdx < 0 || d - touchIdx < 3) return false;
  let highAtTouch = -Infinity;
  for (let i = lowIdx + 1; i <= touchIdx; i++) { if (cs[i].high > highAtTouch) highAtTouch = cs[i].high; }
  for (let i = touchIdx + 1; i <= d; i++) { if (cs[i].high > highAtTouch) return false; }
  return true;
}
// ── 課程 CH9-1 口述（2026-07-05 漏網-9）：長短單各半「長線保護短線」──────────
// 資金拆兩半：½ 守 MA5（短線）、½ 守 MA20（長線），兩半皆有 -10% 絕對停損。
// 60 天視窗（與死抱60對照）。報酬 = 兩半等權平均。
function halvesExit(cs: OHLC[], e: number): { ret: number; days: number } {
  const entry = cs[e].open, stop = entry * 0.90;
  const end = Math.min(e + HOLD60, cs.length - 1);
  let retA: number | null = null; // ½ 守 MA5
  let retB: number | null = null; // ½ 守 MA20
  let lastDay = e;
  for (let d = e + 1; d <= end && (retA === null || retB === null); d++) {
    lastDay = d;
    if (cs[d].low <= stop) {
      const px = Math.min(cs[d].open, stop) / entry - 1;
      if (retA === null) retA = px;
      if (retB === null) retB = px;
      break;
    }
    const c = cs[d].close;
    const ma5 = smaAt(cs, d, 5), ma20 = smaAt(cs, d, 20);
    if (retA === null && ma5 > 0 && c < ma5) retA = c / entry - 1;
    if (retB === null && ma20 > 0 && c < ma20) retB = c / entry - 1;
  }
  const tail = cs[end].close / entry - 1;
  if (retA === null) retA = tail;
  if (retB === null) retB = tail;
  return { ret: ((retA + retB) / 2) * 100, days: lastDay - e };
}

function trappedStallExit(cs: OHLC[], e: number): { ret: number; days: number } {
  const entry = cs[e].open;
  const end = Math.min(e + HOLD60, cs.length - 1);
  let trapped = false;
  for (let d = e + 1; d <= end; d++) {
    if (!trapped && cs[d].close / entry - 1 <= -0.10) trapped = true;
    if (trapped && reboundStallAt(cs, d)) return { ret: (cs[d].close / entry - 1) * 100, days: d - e };
  }
  return { ret: (cs[end].close / entry - 1) * 100, days: end - e };
}
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
  // ── CH8 8-5 三條均線分批 vs 整批對照 ──
  '整批跌破MA5全出': (cs, e) => fullMAExit(cs, e, 5),
  '整批跌破MA20全出': (cs, e) => fullMAExit(cs, e, 20),
  '分批MA5/10/20各1/3': (cs, e) => partialMAExit(cs, e, null),
  '分批+停損5%': (cs, e) => partialMAExit(cs, e, 0.05),
  // ── 課程 CH9-3（2026-07-04）：爆量反轉 15% 減半 + 次日下跌全出（基線=固定停損-10%）──
  'CH9爆量反轉15%減半': (cs, e) => ch9PartialTpExit(cs, e),
  // ── 課程 CH10-1（2026-07-04）：套牢反彈遇壓認賠 vs 死抱（60 天視窗，兩條一起看）──
  '死抱60天(對照)': (cs, e) => { const x = Math.min(e + HOLD60, cs.length - 1); return { ret: (cs[x].close / cs[e].open - 1) * 100, days: x - e }; },
  '套牢反彈遇壓認賠60天': (cs, e) => trappedStallExit(cs, e),
  // 課程 CH9-1 口述「長短各半、長線保護短線」（漏網-9 回測）
  '長短各半(½MA5+½MA20)60天': (cs, e) => halvesExit(cs, e),
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
