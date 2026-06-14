/**
 * 法人偷買(原) 誠實 edge 回測
 *
 * 進場 = 命中日隔日開盤，持有 {5,10,20} 根 close 出場，報酬 − 來回成本（lib/portfolio/fees）。
 * vs 大盤 = 對 ^TWII 同期 close→close 報酬算超額。train/test 按日期中點切。
 * sweep dropMax / concRiseBack。
 *
 * 用法：npx tsx scripts/backtest-inststeal.ts
 */
import { promises as fs } from 'fs';
import path from 'path';
import { evaluateAt } from '../lib/inststeal/signal';
import { InstStealParams, DEFAULT_PARAMS } from '../lib/inststeal/types';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

const COST_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100; // 來回成本（百分點）
const HOLD_DAYS = [5, 10, 20];
const COOLDOWN = 5; // 同檔上次進場後 N 個交易日內不重複計（降序列相關）

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

function readJson(p: string): any | null {
  try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch { return null; }
}

interface Trade { code: string; date: string; entryDate: string; holdDays: number; gross: number; net: number; excess: number }

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const winPct = (xs: number[]) => (xs.length ? 100 * xs.filter(x => x > 0).length / xs.length : NaN);

function fmt(xs: number[]): string {
  return `n=${String(xs.length).padStart(5)}  平均 ${mean(xs).toFixed(2).padStart(6)}%  中位 ${median(xs).toFixed(2).padStart(6)}%  勝率 ${winPct(xs).toFixed(1).padStart(5)}%`;
}

async function main() {
  // 大盤 close by date
  const twiiRaw = readJson(TWII);
  const twiiCandles: RawCandle[] = twiiRaw?.candles || twiiRaw || [];
  const twiiClose = new Map<string, number>();
  for (const c of twiiCandles) twiiClose.set(c.date, c.close);

  const files = (await fs.readdir(INST_DIR)).filter(f => f.endsWith('.json'));

  // sweep grid
  const dropMaxes = [0, -2, -3, -5];
  const riseBacks = [3, 5, 10];

  for (const dropMax of dropMaxes) {
    for (const concRiseBack of riseBacks) {
      const params: InstStealParams = { ...DEFAULT_PARAMS, dropMax, concRiseBack };
      const need = Math.max(params.concWin + params.concRiseBack, 20, params.dropWin, params.instWin);
      const byHold: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };

      for (const f of files) {
        const code = f.replace('.json', '');
        if (!/^\d{4,}$/.test(code)) continue;
        const inst = readJson(path.join(INST_DIR, f));
        const broker = readJson(path.join(BROKER_DIR, f));
        const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`));
        if (!inst || !broker || !cdl) continue;
        const candles: RawCandle[] = (cdl.candles || []).filter((c: RawCandle) => c.close > 0);
        if (candles.length < need + 25) continue;

        const brokerByDate = new Map<string, number>();
        for (const d of broker.data || []) brokerByDate.set(d.date, d.netDifference ?? 0);
        const instByDate = new Map<string, number>();
        for (const d of inst.data || []) instByDate.set(d.date, d.total ?? 0);

        let lastEntryIdx = -COOLDOWN - 1;
        for (let t = need; t < candles.length - 1; t++) {
          if (t - lastEntryIdx <= COOLDOWN) continue;
          const ev = evaluateAt(candles as any, brokerByDate, instByDate, t, params);
          if (!ev || !ev.isHit) continue;

          const entry = candles[t + 1];
          const entryClose = candles[t].close;
          if (!(entry?.open > 0)) continue;
          // 一字鎖死 / 隔夜跳 >25% 污染守衛
          if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) continue;
          if (entryClose > 0 && Math.abs(entry.open / entryClose - 1) > 0.25) continue;

          lastEntryIdx = t;
          for (const h of HOLD_DAYS) {
            const exitIdx = t + 1 + h;
            const exit = candles[exitIdx];
            if (!exit || !(exit.close > 0)) continue;
            const gross = (exit.close / entry.open - 1) * 100;
            const net = gross - COST_PCT;
            // 大盤同期（entry.date → exit.date）close→close
            const tw0 = twiiClose.get(entry.date);
            const tw1 = twiiClose.get(exit.date);
            const idxRet = tw0 && tw1 ? (tw1 / tw0 - 1) * 100 : NaN;
            const excess = Number.isFinite(idxRet) ? net - idxRet : NaN;
            byHold[h].push({ code, date: candles[t].date, entryDate: entry.date, holdDays: h, gross, net, excess });
          }
        }
      }

      console.log(`\n========== dropMax=${dropMax}%  concRiseBack=${concRiseBack}日  (cost ${COST_PCT.toFixed(2)}%) ==========`);
      for (const h of HOLD_DAYS) {
        const trades = byHold[h].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
        if (!trades.length) { console.log(`  持有${h}日：無交易`); continue; }
        const mid = trades[Math.floor(trades.length / 2)].entryDate;
        const train = trades.filter(t => t.entryDate < mid);
        const test = trades.filter(t => t.entryDate >= mid);
        const netAll = trades.map(t => t.net);
        const exAll = trades.map(t => t.excess).filter(Number.isFinite);
        const exTrain = train.map(t => t.excess).filter(Number.isFinite);
        const exTest = test.map(t => t.excess).filter(Number.isFinite);
        const beatMkt = exAll.length ? 100 * exAll.filter(x => x > 0).length / exAll.length : NaN;
        console.log(`  持有${h}日淨報酬   ${fmt(netAll)}`);
        console.log(`  持有${h}日超額(全) ${fmt(exAll)}  贏大盤 ${beatMkt.toFixed(1)}%`);
        console.log(`     超額 train 平均 ${mean(exTrain).toFixed(2)}%  /  test 平均 ${mean(exTest).toFixed(2)}%`);
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
