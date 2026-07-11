/**
 * 楊雲翔「特殊 EMA 區間濾網」回測 — 日K版（有統計意義的長歷史驗證）。
 *
 * 方法（來自公開整理，非其鎖碼指標）：
 *   - 均線：EMA23（收盤）
 *   - 濾網 = 均線上下 ±1% 與 ±3% 兩條緩衝帶，要「收盤確實穿越」才算訊號（過濾均線假交叉）
 *   - 做多進場：單根收盤 ≥ EMA×1.03，或連兩根收盤 ≥ EMA×1.01
 *   - 做多出場（=他的空方進場）：單根收盤 ≤ EMA×0.97，或連兩根收盤 ≤ EMA×0.99
 *   - long/flat 波段：金交叉濾網進、死交叉濾網出，可抱數月
 *
 * 本檔用「日K」測（他原版是 30 分K，但分鐘K無封存、回看僅 ~3 月無法長測）。
 * universe = 全期成交額中位數前 100 大（≈ 市值前 100 的流動性代理）。
 * 隔日開盤進/出場（不看未來）。TW 來回成本 0.6%。train/test 各半。
 * 對齊使用者北極星「賺多賠少」→ 報絕對指標；並去 beta（減同期 ^TWII 買抱）判有無真 alpha。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const COST = 0.006;          // 來回交易成本 0.6%
const EMA_N = 23;
const TOP_N = 100;           // universe 大小

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { sym: string; entryDate: string; exitDate: string; retGross: number; retNet: number; twii: number; excess: number; days: number }

async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

function ema(vals: number[], n: number): number[] {
  const k = 2 / (n + 1); const out: number[] = []; let prev = vals[0];
  for (let i = 0; i < vals.length; i++) { prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

const LIQ_FLOOR = 1e8;   // 進場當下往回 60 日成交額中位數需 ≥ 1 億（點時間門檻，不偷看未來）
const LIQ_WIN = 60;

// 濾網訊號：state machine，回傳完成的交易（隔日開盤進出）
// dual=true → EMA23+60 雙確認：進場要站上 EMA60(環境偏多)+觸發 EMA23 濾網；出場 EMA23 濾網跌破 或 收破 EMA60
function runFilter(cs: OHLC[], twiiOpen: Map<string, number>, sym: string, band1: number, band3: number, dual = false): Trade[] {
  const trades: Trade[] = [];
  if (cs.length < EMA_N + LIQ_WIN + 5) return trades;
  const e = ema(cs.map(c => c.close), EMA_N);
  const e60 = ema(cs.map(c => c.close), 60);
  // 點時間流動性：i 當下往回 LIQ_WIN 天成交額中位數
  const liqOk = (i: number) => {
    if (i < LIQ_WIN) return false;
    const t: number[] = [];
    for (let k = i - LIQ_WIN + 1; k <= i; k++) t.push(cs[k].close * (cs[k].volume || 0) * 1000); // volume 單位=張→×1000=股→實際NTD
    t.sort((a, b) => a - b);
    return t[Math.floor(t.length / 2)] >= LIQ_FLOOR;
  };
  let inPos = false; let entryIdx = -1;
  const ema23Long = (i: number) => cs[i].close >= e[i] * (1 + band3) ||
    (i >= 1 && cs[i].close >= e[i] * (1 + band1) && cs[i - 1].close >= e[i - 1] * (1 + band1));
  const longSig = (i: number) => liqOk(i) && ema23Long(i) && (!dual || cs[i].close >= e60[i]); // 雙確認：+站上EMA60
  const exitSig = (i: number) => cs[i].close <= e[i] * (1 - band3) ||
    (i >= 1 && cs[i].close <= e[i] * (1 - band1) && cs[i - 1].close <= e[i - 1] * (1 - band1)) ||
    (dual && cs[i].close < e60[i]); // 雙確認出場：EMA23濾網跌破 或 收破EMA60
  for (let i = EMA_N; i < cs.length - 1; i++) {
    if (!inPos) {
      if (longSig(i)) { inPos = true; entryIdx = i + 1; }   // 隔日開盤進
    } else {
      if (exitSig(i)) {
        const ex = i + 1;
        const entry = cs[entryIdx].open, exit = cs[ex].open;
        const retGross = (exit / entry - 1) * 100;
        const retNet = retGross - COST * 100;
        const t0 = twiiOpen.get(cs[entryIdx].date), t1 = twiiOpen.get(cs[ex].date);
        const twii = (t0 && t1) ? (t1 / t0 - 1) * 100 : 0;
        trades.push({ sym, entryDate: cs[entryIdx].date, exitDate: cs[ex].date, retGross, retNet, twii, excess: retNet - twii, days: ex - entryIdx });
        inPos = false;
      }
    }
  }
  // 期末仍持有 → 以最後一根收盤結算
  if (inPos && entryIdx < cs.length) {
    const last = cs.length - 1; const entry = cs[entryIdx].open, exit = cs[last].close;
    const retGross = (exit / entry - 1) * 100, retNet = retGross - COST * 100;
    const t0 = twiiOpen.get(cs[entryIdx].date), t1 = twiiOpen.get(cs[last].date);
    const twii = (t0 && t1) ? (t1 / t0 - 1) * 100 : 0;
    trades.push({ sym, entryDate: cs[entryIdx].date, exitDate: cs[last].date, retGross, retNet, twii, excess: retNet - twii, days: last - entryIdx });
  }
  return trades;
}

function report(label: string, ts: Trade[]) {
  if (!ts.length) { console.log(`  ${label}: 無交易`); return; }
  const n = ts.length;
  const wins = ts.filter(t => t.retNet > 0), losses = ts.filter(t => t.retNet <= 0);
  const avg = (a: number[]) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const winRate = wins.length / n * 100;
  const avgWin = avg(wins.map(t => t.retNet)), avgLoss = avg(losses.map(t => t.retNet));
  const exp = avg(ts.map(t => t.retNet));
  const avgExcess = avg(ts.map(t => t.excess));
  const beatMkt = ts.filter(t => t.excess > 0).length / n * 100;
  const maxLoss = Math.min(...ts.map(t => t.retNet));
  const avgDays = avg(ts.map(t => t.days));
  console.log(`  ${label}: ${n} 筆`);
  console.log(`    賺的機率 ${winRate.toFixed(1)}%  平均賺 +${avgWin.toFixed(2)}%  平均賠 ${avgLoss.toFixed(2)}%`);
  console.log(`    每筆期望(淨) ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}%  最大單筆賠 ${maxLoss.toFixed(1)}%  平均抱 ${avgDays.toFixed(0)} 天`);
  console.log(`    去beta: 平均超額(vs大盤) ${avgExcess >= 0 ? '+' : ''}${avgExcess.toFixed(2)}%  贏過大盤比率 ${beatMkt.toFixed(1)}%`);
}

async function main() {
  const files = (await fs.readdir(C)).filter(f => f.endsWith('.TW.json') && !f.startsWith('^'));
  // TWII benchmark
  const twiiRaw = await readJ(path.join(C, '^TWII.json'));
  const twiiOpen = new Map<string, number>();
  if (twiiRaw?.candles) for (const c of twiiRaw.candles) twiiOpen.set(c.date, c.open);

  // universe: 全部有足夠歷史的股票；流動性用「進場當下往回60天」點時間門檻（在 runFilter 內），不偷看未來
  const universe: { sym: string; cs: OHLC[] }[] = [];
  for (const f of files) {
    const j = await readJ(path.join(C, f));
    const cs: OHLC[] = j?.candles;
    if (!cs || cs.length < 200) continue;
    universe.push({ sym: f.replace('.json', ''), cs });
  }
  console.log(`Universe: 全 ${universe.length} 檔（進場當下往回60天成交額中位數 ≥ ${(LIQ_FLOOR / 1e8).toFixed(0)}億才進場）`);
  console.log(`成本假設: 來回 ${(COST * 100).toFixed(1)}%\n`);

  // 三組對照：楊氏濾網(單23) / 雙確認(23+60) / 純EMA交叉(無濾網)
  for (const [name, b1, b3, dual] of [
    ['楊氏濾網 EMA23 ±1%/±3%（單）', 0.01, 0.03, false],
    ['雙確認 EMA23+60（站上60才進）', 0.01, 0.03, true],
    ['純 EMA23 交叉(無濾網對照)', 0, 0, false],
  ] as const) {
    const all: Trade[] = [];
    for (const s of universe) all.push(...runFilter(s.cs, twiiOpen, s.sym, b1, b3, dual));
    all.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
    const mid = Math.floor(all.length / 2);
    console.log(`【${name}】 總 ${all.length} 筆`);
    report('全期', all);
    report('train(前半)', all.slice(0, mid));
    report('test (後半)', all.slice(mid));
    console.log('');
  }
}
main();
