/**
 * 「楊雲翔特殊EMA濾網」當『選股掃描策略』的誠實驗證（不是持股一檔測，是全市場當 picker）。
 * 問題：把它做成選股策略可行嗎？＝扣成本、去大盤beta後，選出來的有沒有穩定淨 alpha、train/test 一不一致。
 *
 * 完整策略（與走圖同一套）：
 *   進場＝站上EMA60 +（單根收盤≥EMA23×1.03 或 連兩根≥EMA23×1.01）；隔日開盤買。
 *   出場三層擇一先到：移動停利(獲利+10%啟動、從最高獲利回落15個百分點) / 收破EMA60 / 跌破EMA23濾網；隔日開盤賣。
 * 全市場台股日K、進場當下往回60日流動性門檻(不偷看未來、無存活者偏誤)、來回成本0.6%。
 * 每筆算「淨報酬」與「同期 ^TWII 報酬」→ 超額(去beta)。train/test 各半驗一致性。
 */
import { promises as fs } from 'fs';
import path from 'path';

const C = path.join(process.cwd(), 'data/candles/TW');
const COST = 0.006, LIQ_FLOOR = 1e8, LIQ_WIN = 60;
const ARM = 0.10, GIVEBACK = 0.15; // 移動停利＝走圖現行預設

interface OHLC { date: string; open: number; high: number; low: number; close: number; volume: number }
interface Trade { retNet: number; twii: number; excess: number; days: number; reason: string }
async function readJ(p: string): Promise<any> { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }
function ema(v: number[], n: number): number[] { const k = 2 / (n + 1); const o: number[] = []; let p = NaN; for (let i = 0; i < v.length; i++) { p = i === 0 ? v[0] : v[i] * k + p * (1 - k); o[i] = p; } return o; }

function runStrategy(cs: OHLC[], e23: number[], e60: number[], twiiOpen: Map<string, number>, entryDate: string[]): Trade[] {
  const out: Trade[] = [];
  if (cs.length < LIQ_WIN + 65) return out;
  const liqOk = (i: number) => { if (i < LIQ_WIN) return false; const t: number[] = []; for (let k = i - LIQ_WIN + 1; k <= i; k++) t.push(cs[k].close * (cs[k].volume || 0) * 1000); t.sort((a, b) => a - b); return t[Math.floor(t.length / 2)] >= LIQ_FLOOR; };
  let inPos = false, entryIdx = -1, fill = 0, peakGain = 0;
  for (let i = 60; i < cs.length - 1; i++) {
    const c = cs[i], pc = cs[i - 1];
    if (!inPos) {
      const enter = liqOk(i) && c.close >= e60[i] && (c.close >= e23[i] * 1.03 || (c.close >= e23[i] * 1.01 && pc.close >= e23[i - 1] * 1.01));
      if (enter) { inPos = true; entryIdx = i + 1; fill = cs[i + 1].open; peakGain = 0; }
    } else {
      peakGain = Math.max(peakGain, (c.high - fill) / fill);
      const gain = (c.close - fill) / fill;
      let reason = '';
      if (peakGain >= ARM && gain <= peakGain - GIVEBACK) reason = '移利';
      else if (c.close < e60[i]) reason = '破60';
      else if (c.close <= e23[i] * 0.97 || (c.close <= e23[i] * 0.99 && pc.close <= e23[i - 1] * 0.99)) reason = '停損';
      if (reason) {
        const ex = i + 1, exit = cs[ex].open;
        const retNet = (exit / fill - 1) * 100 - COST * 100;
        const t0 = twiiOpen.get(cs[entryIdx].date), t1 = twiiOpen.get(cs[ex].date);
        const twii = (t0 && t1) ? (t1 / t0 - 1) * 100 : 0;
        out.push({ retNet, twii, excess: retNet - twii, days: ex - entryIdx, reason });
        entryDate.push(cs[entryIdx].date);
        inPos = false;
      }
    }
  }
  return out;
}

function report(label: string, ts: Trade[]) {
  if (!ts.length) { console.log(`  ${label}: 無交易`); return; }
  const n = ts.length, avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const wins = ts.filter(t => t.retNet > 0);
  const exp = avg(ts.map(t => t.retNet)), exc = avg(ts.map(t => t.excess)), beat = ts.filter(t => t.excess > 0).length / n * 100;
  console.log(`  ${label}: ${n} 筆  賺機率 ${(wins.length / n * 100).toFixed(1)}%  每筆淨 ${exp >= 0 ? '+' : ''}${exp.toFixed(2)}%  平均抱 ${avg(ts.map(t => t.days)).toFixed(0)}天`);
  console.log(`    ★去beta：平均超額(vs大盤) ${exc >= 0 ? '+' : ''}${exc.toFixed(2)}%  贏過大盤比率 ${beat.toFixed(1)}%`);
}

async function main() {
  const files = (await fs.readdir(C)).filter(f => f.endsWith('.TW.json') && !f.startsWith('^'));
  const twiiRaw = await readJ(path.join(C, '^TWII.json'));
  const twiiOpen = new Map<string, number>(); if (twiiRaw?.candles) for (const c of twiiRaw.candles) twiiOpen.set(c.date, c.open);

  const all: Trade[] = []; const dates: string[] = [];
  for (const f of files) {
    const j = await readJ(path.join(C, f)); const cs: OHLC[] = j?.candles;
    if (!cs || cs.length < 200) continue;
    const e23 = ema(cs.map(c => c.close), 23), e60 = ema(cs.map(c => c.close), 60);
    const d: string[] = [];
    const ts = runStrategy(cs, e23, e60, twiiOpen, d);
    all.push(...ts); dates.push(...d);
  }
  // 按進場日排序後 train/test 各半
  const idx = all.map((_, i) => i).sort((a, b) => dates[a].localeCompare(dates[b]));
  const sorted = idx.map(i => all[i]);
  const mid = Math.floor(sorted.length / 2);
  const reasons = new Map<string, number>(); for (const t of all) reasons.set(t.reason, (reasons.get(t.reason) || 0) + 1);

  console.log(`楊氏濾網「選股掃描」誠實驗證 — 全市場台股日K｜成本 ${(COST * 100).toFixed(1)}%｜移動停利 啟動${ARM * 100}%/回落${GIVEBACK * 100}pp\n`);
  console.log(`總 ${all.length} 筆交易；出場原因：${[...reasons].map(([k, v]) => `${k} ${v}`).join('、')}\n`);
  report('全期', sorted);
  report('train(前半)', sorted.slice(0, mid));
  report('test (後半)', sorted.slice(mid));
  console.log('\n判準（你系統誠實edge紀律）：選股策略要「可行」＝去beta超額須穩定為正且 train/test 同號。');
}
main();
