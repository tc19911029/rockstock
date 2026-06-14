/**
 * smartmoney 掃描引擎 — 讀本地主力分點/日K，算出「主力分點剛開始偷買」清單（refined）。
 * 只讀檔不打外部 API，安全在 Node route / 腳本內跑。
 */
import { promises as fs } from 'fs';
import path from 'path';
import { SmartMoneyParams, SmartMoneyHit, SmartMoneyDay, DEFAULT_PARAMS } from './types';
import { evaluateLatest, Candle } from './signal';

const BROKER_DIR = path.join(process.cwd(), 'data/chips/TW/broker');
const CANDLE_DIR = path.join(process.cwd(), 'data/candles/TW');
const NAMES = path.join(process.cwd(), 'data/youtube/stock-master.json');

async function loadNames(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const j = JSON.parse(await fs.readFile(NAMES, 'utf8'));
    for (const e of j.entries || []) m.set(e.code, e.name);
  } catch {}
  return m;
}

async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

/** 跑一次全掃描，回傳當日結果（依 20 日集中度由高到低排序） */
export async function runScan(params: SmartMoneyParams = DEFAULT_PARAMS): Promise<SmartMoneyDay> {
  const names = await loadNames();
  const files = (await fs.readdir(BROKER_DIR)).filter(f => f.endsWith('.json'));

  const hits: SmartMoneyHit[] = [];
  let universe = 0;
  let latestDate = '0';
  const need = params.longWin + params.turnBack;

  for (const f of files) {
    const code = f.replace('.json', '');
    if (!/^\d{4}$/.test(code)) continue;

    const broker = await readJson(path.join(BROKER_DIR, f));
    const cdl = await readJson(path.join(CANDLE_DIR, `${code}.TW.json`));
    if (!broker || !cdl) continue;

    const bdays: any[] = broker.data || [];
    const candles: Candle[] = (cdl.candles || []).filter((c: Candle) => c.close > 0);
    if (bdays.length < need + 1 || candles.length < need + 1) continue;

    const brokerByDate = new Map<string, number>();
    for (const d of bdays) brokerByDate.set(d.date, d.netDifference ?? 0);

    const ev = evaluateLatest(candles, brokerByDate, params);
    if (!ev) continue;
    universe++;
    if (ev.date > latestDate) latestDate = ev.date;
    if (!ev.isHit) continue;

    hits.push({
      code,
      name: names.get(code) || code,
      price: ev.price,
      conc20: ev.conc20,
      conc20prev: ev.conc20prev,
      conc5: ev.conc5,
      volRatio: ev.volRatio,
      drop5: +ev.drop5.toFixed(2),
    });
  }

  hits.sort((a, b) => b.conc20 - a.conc20); // 20日集中度最高排前

  return {
    date: latestDate,
    generatedAt: new Date().toISOString(),
    params,
    universe,
    hits,
  };
}
