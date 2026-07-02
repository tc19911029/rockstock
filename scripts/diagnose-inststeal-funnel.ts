/**
 * Y軌（法人偷買/inststeal）漏斗診斷 — 看是「池子不夠 / 資料不齊 / 條件太苛」哪一關卡住。
 * 用法：npx tsx scripts/diagnose-inststeal-funnel.ts 2026-06-17 2026-06-16 2026-06-12
 */
import { promises as fs } from 'fs';
import path from 'path';
import { evaluateLatest, Candle } from '../lib/inststeal/signal';
import { DEFAULT_PARAMS } from '../lib/inststeal/types';

const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const INST_DIR = path.join(process.cwd(), 'data/chips/TW/inst');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const minBars = Math.max(DEFAULT_PARAMS.concWin + DEFAULT_PARAMS.concRiseBack, 20, DEFAULT_PARAMS.dropWin, DEFAULT_PARAMS.instWin) + 1;

async function loadMap(dir: string, code: string, field: string): Promise<Map<string, number> | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(dir, `${code}.json`), 'utf8'));
    return new Map((j.data || []).map((d: Record<string, number | string>) => [d.date as string, (d[field] as number) ?? 0]));
  } catch { return null; }
}

async function loadCandles(symbol: string, date: string): Promise<Candle[] | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(CANDLE_DIR, `${symbol}.json`), 'utf8'));
    return (j.candles || []).filter((c: { date: string }) => c.date <= date);
  } catch { return null; }
}

async function main() {
  const dates = process.argv.slice(2);
  if (!dates.length) { console.error('給日期'); process.exit(1); }

  const { TaiwanScanner } = await import('../lib/scanner/TaiwanScanner');
  const { computeTurnoverRankAsOfDate } = await import('../lib/scanner/TurnoverRank');
  const scanner = new TaiwanScanner();
  const allStocks = await scanner.getStockList();

  for (const date of dates) {
    const rankMap = await computeTurnoverRankAsOfDate('TW', allStocks, date, 500);
    const pool = allStocks.filter((s: { symbol: string }) => rankMap.has(s.symbol));

    const f = { pool: pool.length, hasBroker: 0, hasInst: 0, hasBoth: 0, enoughBars: 0, evalAtDate: 0,
      cond1_drop: 0, cond2_concRise: 0, cond3_instBuy: 0, c1c3: 0, allHit: 0,
      cond3_relaxed: 0, c1c3_relaxed: 0, allHit_relaxed: 0 };

    for (const { symbol } of pool) {
      const code = symbol.split('.')[0];
      const broker = await loadMap(BROKER_DIR, code, 'netDifference');
      const inst = await loadMap(INST_DIR, code, 'total');
      if (broker) f.hasBroker++;
      if (inst) f.hasInst++;
      if (!broker || !inst) continue;
      f.hasBoth++;
      const candles = await loadCandles(symbol, date);
      if (!candles || candles.length < minBars) continue;
      f.enoughBars++;
      // 評估在「<=date 的最後一根同時有 broker+inst 的日K」（broker 簡化公式，非 FinMind）
      const ev = evaluateLatest(candles, broker, inst, DEFAULT_PARAMS);
      if (!ev) continue;
      if (ev.date === date) f.evalAtDate++;
      if (ev.isDropping) f.cond1_drop++;
      if (ev.isConcRising) f.cond2_concRise++;
      if (ev.isInstBuying) f.cond3_instBuy++;
      if (ev.isDropping && ev.isInstBuying) f.c1c3++;
      if (ev.isHit) f.allHit++;
      // 放寬版：條件3 只要「近5日法人淨買 > 0」(不要求連買2天)
      const cond3relax = ev.instSumK > 0;
      if (cond3relax) f.cond3_relaxed++;
      if (ev.isDropping && cond3relax) f.c1c3_relaxed++;
      if (ev.isDropping && ev.isConcRising && cond3relax) f.allHit_relaxed++;
    }

    console.log(`\n===== ${date} =====`);
    console.log(`成交額前500池子            : ${f.pool}`);
    console.log(`├ 有主力分點(broker)資料    : ${f.hasBroker}`);
    console.log(`├ 有法人(inst)資料          : ${f.hasInst}`);
    console.log(`├ 兩種都有                 : ${f.hasBoth}   ← 資料齊備的才會被評估`);
    console.log(`├ K棒足夠(≥${minBars})          : ${f.enoughBars}`);
    console.log(`│  (其中評估點剛好落在當天 : ${f.evalAtDate})`);
    console.log(`條件1 在跌(5日<-2%)         : ${f.cond1_drop}`);
    console.log(`條件2 集中度在爬           : ${f.cond2_concRise}`);
    console.log(`條件3 法人連買≥2天         : ${f.cond3_instBuy}`);
    console.log(`條件1∩條件3 (粗篩過)       : ${f.c1c3}`);
    console.log(`三條件全中(broker公式)     : ${f.allHit}   ← 再經 FinMind 嚴格集中度會更少`);
    console.log(`--- 若把條件3改「5日淨買>0」(不要求連買2天) ---`);
    console.log(`條件3(放寬)                : ${f.cond3_relaxed}  (原連買版 ${f.cond3_instBuy})`);
    console.log(`條件1∩條件3(放寬)          : ${f.c1c3_relaxed}  (原 ${f.c1c3})`);
    console.log(`三條件全中(放寬,broker公式): ${f.allHit_relaxed}  (原 ${f.allHit})`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
