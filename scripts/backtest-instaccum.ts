/**
 * 「法人吸·融資退」誠實 edge 回測
 *
 * 進場 = 命中日隔日開盤，持有 {5,10,20} 根 close 出場，報酬 − 來回成本（lib/portfolio/fees）。
 * vs 大盤 = 對 ^TWII 同期 close→close 報酬算超額。train/test 按日期中點切。
 * 北極星：除了「贏不贏大盤」，一起印「絕對勝率 + 平均/中位漲幅 + MFE/MAE(最大會賠多少)」。
 * 反向驗證：train+test 都負 = 系統性偏弱 → 當「避雷/別碰」訊號（記憶 factor_grid_search_buy_vs_avoid）。
 *
 * grid sweep：instMode(consec/magnitude) × marginDropPct × priceMaxRisePct。
 * 用法：npx tsx scripts/backtest-instaccum.ts
 */
import { promises as fs } from 'fs';
import path from 'path';
import { evaluateAt } from '../lib/instaccum/signal';
import { InstAccumParams, DEFAULT_PARAMS, InstBuyMode } from '../lib/instaccum/types';
import { FEE_RATES } from '../lib/portfolio/fees';

const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const MARGIN_DIR = path.join(process.cwd(), 'data/chips/TW/margin');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const TWII = path.join(process.cwd(), 'data/candles/TW/^TWII.json');

const COST_PCT = (FEE_RATES.TW.buy + FEE_RATES.TW.sell) * 100; // 來回成本（百分點）
const HOLD_DAYS = [5, 10, 20];
const MFE_WIN = 20; // MFE/MAE 觀察窗（進場後 N 根高低）
const COOLDOWN = 5; // 同檔上次進場後 N 個交易日內不重複計

interface RawCandle { date: string; open: number; high: number; low: number; close: number; volume: number }

function readJson(p: string): any | null {
  try { return JSON.parse(require('fs').readFileSync(p, 'utf8')); } catch { return null; }
}

interface Trade {
  code: string; entryDate: string; holdDays: number;
  gross: number; net: number; excess: number;
  mfe: number; mae: number; // 只在 holdDays===MFE_WIN 行填，其餘為 NaN
}

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

  const files = (await fs.readdir(INST_DIR)).filter(f => /^\d{4,}\.json$/.test(f));

  // 預載每檔資料一次（grid 多組共用，省 IO）
  type Loaded = { code: string; candles: RawCandle[]; instByDate: Map<string, number>; marginByDate: Map<string, number> };
  const loaded: Loaded[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    const inst = readJson(path.join(INST_DIR, f));
    const margin = readJson(path.join(MARGIN_DIR, f));
    const cdl = readJson(path.join(CANDLE_DIR, `${code}.TW.json`)) || readJson(path.join(CANDLE_DIR, `${code}.TWO.json`));
    if (!inst || !margin || !cdl) continue;
    const candles: RawCandle[] = (cdl.candles || []).filter((c: RawCandle) => c.close > 0);
    if (candles.length < 60) continue;
    const instByDate = new Map<string, number>();
    for (const d of inst.data || []) instByDate.set(d.date, d.total ?? 0);
    const marginByDate = new Map<string, number>();
    for (const d of margin.data || []) marginByDate.set(d.date, d.marginBalance ?? 0);
    loaded.push({ code, candles, instByDate, marginByDate });
  }
  console.error(`載入 ${loaded.length} 檔（inst+margin+candle 齊備）`);

  // grid
  const modes: InstBuyMode[] = ['consec', 'magnitude'];
  const marginDrops = [-2, -3, -5];
  const priceMaxes = [3, 5, 10];

  console.log(`來回成本 ${COST_PCT.toFixed(2)}%　|　固定：priceWin=5 marginWin=5 instWin=5 priceFloor=${DEFAULT_PARAMS.priceFloorPct}% (consec≥2天 / magnitude≥${DEFAULT_PARAMS.instToVolPct}%佔量)`);

  for (const instMode of modes) {
    for (const marginDropPct of marginDrops) {
      for (const priceMaxRisePct of priceMaxes) {
        const params: InstAccumParams = { ...DEFAULT_PARAMS, instMode, marginDropPct, priceMaxRisePct };
        const need = Math.max(params.priceWin, params.marginWin, params.instWin);
        const byHold: Record<number, Trade[]> = { 5: [], 10: [], 20: [] };

        for (const L of loaded) {
          const { code, candles, instByDate, marginByDate } = L;
          let lastEntryIdx = -COOLDOWN - 1;
          for (let t = need; t < candles.length - 1; t++) {
            if (t - lastEntryIdx <= COOLDOWN) continue;
            const ev = evaluateAt(candles, instByDate, marginByDate, t, params);
            if (!ev || !ev.isHit) continue;

            const entry = candles[t + 1];
            const entryClose = candles[t].close;
            if (!(entry?.open > 0)) continue;
            // 一字鎖死 / 隔夜跳 >25% 污染守衛
            if (entry.open === entry.high && entry.low > 0 && (entry.high - entry.low) / entry.low < 0.005) continue;
            if (entryClose > 0 && Math.abs(entry.open / entryClose - 1) > 0.25) continue;

            lastEntryIdx = t;

            // MFE/MAE：進場後 MFE_WIN 根高低 vs entry.open
            let mfe = NaN, mae = NaN;
            {
              let hi = -Infinity, lo = Infinity;
              for (let k = t + 1; k <= Math.min(t + MFE_WIN, candles.length - 1); k++) {
                if (candles[k].high > hi) hi = candles[k].high;
                if (candles[k].low < lo) lo = candles[k].low;
              }
              if (Number.isFinite(hi)) mfe = (hi / entry.open - 1) * 100;
              if (Number.isFinite(lo)) mae = (lo / entry.open - 1) * 100;
            }

            for (const h of HOLD_DAYS) {
              const exitIdx = t + 1 + h;
              const exit = candles[exitIdx];
              if (!exit || !(exit.close > 0)) continue;
              const gross = (exit.close / entry.open - 1) * 100;
              const net = gross - COST_PCT;
              const tw0 = twiiClose.get(entry.date);
              const tw1 = twiiClose.get(exit.date);
              const idxRet = tw0 && tw1 ? (tw1 / tw0 - 1) * 100 : NaN;
              const excess = Number.isFinite(idxRet) ? net - idxRet : NaN;
              byHold[h].push({ code, entryDate: entry.date, holdDays: h, gross, net, excess, mfe: h === MFE_WIN ? mfe : NaN, mae: h === MFE_WIN ? mae : NaN });
            }
          }
        }

        console.log(`\n========== mode=${instMode}  融資減≤${marginDropPct}%  漲幅≤${priceMaxRisePct}% ==========`);
        const total20 = byHold[20].length;
        if (!total20) { console.log('  無交易'); continue; }
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
          const consistent = (mean(exTrain) > 0 && mean(exTest) > 0) ? '✅一致正'
            : (mean(exTrain) < 0 && mean(exTest) < 0) ? '🚫一致負(避雷候選)' : '⚠️train/test不一致';
          console.log(`  持有${h}日淨報酬   ${fmt(netAll)}`);
          console.log(`  持有${h}日超額(全) ${fmt(exAll)}  贏大盤 ${beatMkt.toFixed(1)}%`);
          console.log(`     超額 train ${mean(exTrain).toFixed(2)}% / test ${mean(exTest).toFixed(2)}%  → ${consistent}`);
          if (h === MFE_WIN) {
            const maes = trades.map(t => t.mae).filter(Number.isFinite);
            const mfes = trades.map(t => t.mfe).filter(Number.isFinite);
            const worstNet = Math.min(...netAll);
            console.log(`     賠少檢查(20根內)：平均最深回檔(MAE) ${mean(maes).toFixed(2)}%  最慘單筆MAE ${Math.min(...maes).toFixed(2)}%  最慘單筆報酬 ${worstNet.toFixed(2)}%  平均最大衝高(MFE) ${mean(mfes).toFixed(2)}%`);
          }
        }
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
