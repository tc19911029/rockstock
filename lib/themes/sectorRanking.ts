/**
 * 板塊（題材）強弱排名 + 題材 6 階段顯示分類（2026-06-12 A2）
 *
 * 資料來源：themeMap 成分股（~120 檔去重）逐檔讀本地 L1 日K + chips inst 日序列。
 * 不掃全市場（成分股清單固定且小），跑在盤後 cron（17:10 CST，L1 14:30 已封）。
 *
 * 紅線：輸出是「顯示/排序參考」，不接選股 gate、不入 pool 分數（鐵則 #5）。
 * 6 階段分類是顯示用 heuristic（門檻寫死在 classifyStage，非書本規則、未經回測）—
 * 要升級成排序權重必須先走 backtest-unified-leaderboard 變體驗證（計畫 Phase 6）。
 *
 * 儲存：data/sectors/TW/{date}.json（日檔不互覆，遵守 L4 主鍵精神）。
 */
import fs from 'fs/promises';
import path from 'path';
import { THEME_MAP, type ThemeStock } from './themeMap';
import { PERF_PERIODS, INST_PERIODS } from './perfPeriods';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readInstStock } from '@/lib/chips/ChipStorage';
import { readMarginStock } from '@/lib/chips/ChipExtrasStorage';

const SECTORS_DIR = path.join(process.cwd(), 'data', 'sectors', 'TW');

export type ThemeStage = '剛啟動' | '主升段' | '高潮噴出' | '震盪換手' | '退潮' | '補跌' | '盤整';

export interface ThemeStockPerf {
  code: string;
  name: string;
  /** % 報酬（最新收盤 vs N 根前收盤；資料不足 = null） */
  d1: number | null;
  d5: number | null;
  d20: number | null;
  d60: number | null;
  /** 最新量 / 前 5 根均量 */
  volRatio: number | null;
  /** 今日成交金額（元 = 量張×1000×收盤；無資料 = null） */
  turnover: number | null;
  /** 三大法人（外資+投信+自營）近 5 日合計買賣超（張；無資料 = null） */
  instNet5: number | null;
  /** 過去 N 日漲幅 %（對齊 PERF_PERIODS = 1,2,…,10,20；資料不足 = null） */
  rets: (number | null)[];
  /** 外資+投信過去 N 日買超「金額」(元；對齊 INST_PERIODS=1,3,5,10；逐日張×1000×當日收盤) */
  instAmt: (number | null)[];
  /** 散戶(融資)過去 N 日淨變化金額 (元；融資淨變化張×1000×當日收盤；對齊 INST_PERIODS) */
  retailAmt: (number | null)[];
}

export interface ThemeRank {
  theme: string;
  stockCount: number;
  /** 成分股平均（缺資料股跳過） */
  avgD1: number | null;
  avgD5: number | null;
  avgD20: number | null;
  avgD60: number | null;
  avgVolRatio: number | null;
  /** 今日上漲家數比例 0-1 */
  breadth: number | null;
  /** 外資+投信近 5 日合計（張） */
  instNet5: number | null;
  /** 外資+投信近 5 日買超金額合計（元；成分股加總） */
  instAmt5: number | null;
  stage: ThemeStage;
  /** 當日最強成分股（d1 最大） */
  topStock: { code: string; name: string; d1: number } | null;
  members: ThemeStockPerf[];
}

export interface SectorRankingFile {
  date: string;
  generatedAt: string;
  themes: ThemeRank[];
}

// ── 個股報酬計算 ──────────────────────────────────────────────────────────────

async function loadStockPerf(stock: ThemeStock, date: string): Promise<ThemeStockPerf> {
  const empty: ThemeStockPerf = {
    code: stock.code, name: stock.name,
    d1: null, d5: null, d20: null, d60: null, volRatio: null, turnover: null, instNet5: null,
    rets: PERF_PERIODS.map(() => null),
    instAmt: INST_PERIODS.map(() => null),
    retailAmt: INST_PERIODS.map(() => null),
  };
  // 檔名格式 {code}.TW.json / {code}.TWO.json
  const file = (await readCandleFile(`${stock.code}.TW`, 'TW'))
    ?? (await readCandleFile(`${stock.code}.TWO`, 'TW'));
  if (!file?.candles?.length) return empty;

  const candles = file.candles;
  // 找 date 當根（或之前最近一根）— 排除未來資料，歷史日期也可重算
  let idx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date <= date) { idx = i; break; }
  }
  if (idx < 1) return empty;

  const close = candles[idx].close;
  const ret = (n: number): number | null => {
    if (idx - n < 0) return null;
    const base = candles[idx - n].close;
    return base > 0 ? +(((close - base) / base) * 100).toFixed(1) : null;
  };
  let volRatio: number | null = null;
  if (idx >= 5) {
    let s = 0;
    for (let i = idx - 5; i < idx; i++) s += candles[i].volume;
    const avg = s / 5;
    volRatio = avg > 0 ? +(candles[idx].volume / avg).toFixed(2) : null;
  }
  // 今日成交金額（元）= 量(張)×1000×收盤
  const turnover = candles[idx].volume > 0 ? Math.round(candles[idx].volume * 1000 * close) : null;

  // 外資+投信近 5 日合計（張）+ 過去 1/3/5/10 日買超「金額」(逐日張×1000×當日收盤)
  let instNet5: number | null = null;
  let instAmt: (number | null)[] = INST_PERIODS.map(() => null);
  try {
    const inst = await readInstStock(stock.code);
    if (inst?.data?.length) {
      const past = inst.data.filter(r => r.date <= date);
      const rows5 = past.slice(-5);
      if (rows5.length > 0) {
        instNet5 = rows5.reduce((acc, r) => acc + (r.foreign ?? 0) + (r.trust ?? 0) + (r.dealer ?? 0), 0);
      }
      const closeByDate = new Map(candles.map(c => [c.date, c.close]));
      instAmt = INST_PERIODS.map((n) => {
        const rows = past.slice(-n);
        if (rows.length === 0) return null;
        let amt = 0; let any = false;
        for (const r of rows) {
          const c = closeByDate.get(r.date);
          if (c == null) continue;
          amt += ((r.foreign ?? 0) + (r.trust ?? 0) + (r.dealer ?? 0)) * 1000 * c; // 三大法人 張×1000股×元 = 元
          any = true;
        }
        return any ? Math.round(amt) : null;
      });
    }
  } catch { /* 無籌碼資料不影響報酬欄 */ }

  // 融資過去 N 日淨變化「金額」（逐日 張×1000股×當日收盤＝元；正=融資加碼、負=融資減）
  let retailAmt: (number | null)[] = INST_PERIODS.map(() => null);
  try {
    const margin = await readMarginStock(stock.code);
    if (margin?.data?.length) {
      const past = margin.data.filter(r => r.date <= date);
      const marginCloseByDate = new Map(candles.map(c => [c.date, c.close]));
      retailAmt = INST_PERIODS.map((n) => {
        const rows = past.slice(-n);
        if (rows.length === 0) return null;
        let amt = 0; let any = false;
        for (const r of rows) {
          if (r.marginNet == null) continue;
          const c = marginCloseByDate.get(r.date);
          if (c == null) continue;
          amt += r.marginNet * 1000 * c; // 融資淨變化 張×1000股×當日收盤 = 元
          any = true;
        }
        return any ? Math.round(amt) : null;
      });
    }
  } catch { /* 無融資資料不影響其他欄 */ }

  return {
    code: stock.code, name: stock.name,
    d1: ret(1), d5: ret(5), d20: ret(20), d60: ret(60), volRatio, turnover, instNet5,
    rets: PERF_PERIODS.map((n) => ret(n)),
    instAmt, retailAmt,
  };
}

// ── 題材 6 階段（顯示用 heuristic，門檻單一事實在此）────────────────────────────

export function classifyStage(r: { avgD5: number | null; avgD20: number | null; avgVolRatio: number | null }): ThemeStage {
  const d5 = r.avgD5;
  const d20 = r.avgD20;
  const vol = r.avgVolRatio;
  if (d5 == null || d20 == null) return '盤整';
  if (d20 <= -10) return '補跌';
  if (d5 >= 8 && (vol ?? 0) >= 2) return '高潮噴出';
  if (d20 >= 10 && d5 > 0) return '主升段';
  if (d20 >= 10 && Math.abs(d5) <= 3) return '震盪換手';
  if (d5 >= 3 && d20 < 10) return '剛啟動';
  if (d5 <= -3 && d20 < 5) return '退潮';
  return '盤整';
}

// ── 聚合 ─────────────────────────────────────────────────────────────────────

function avg(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x != null);
  if (v.length === 0) return null;
  return +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1);
}

export async function buildSectorRanking(date: string): Promise<SectorRankingFile> {
  // 全題材去重股票先各算一次，再按題材聚合（同股多題材不重算）
  const perfCache = new Map<string, ThemeStockPerf>();
  const allStocks = new Map<string, ThemeStock>();
  for (const stocks of Object.values(THEME_MAP)) {
    for (const s of stocks) allStocks.set(s.code, s);
  }
  const CONCURRENCY = 16;
  const entries = [...allStocks.values()];
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(s => loadStockPerf(s, date)));
    for (const p of results) perfCache.set(p.code, p);
  }

  const themes: ThemeRank[] = Object.entries(THEME_MAP).map(([theme, stocks]) => {
    const members = stocks.map(s => perfCache.get(s.code)!).filter(Boolean);
    const avgD1 = avg(members.map(m => m.d1));
    const avgD5 = avg(members.map(m => m.d5));
    const avgD20 = avg(members.map(m => m.d20));
    const avgD60 = avg(members.map(m => m.d60));
    const avgVolRatio = avg(members.map(m => m.volRatio));
    const withD1 = members.filter(m => m.d1 != null);
    const breadth = withD1.length > 0
      ? +(withD1.filter(m => (m.d1 ?? 0) > 0).length / withD1.length).toFixed(2)
      : null;
    const instVals = members.map(m => m.instNet5).filter((x): x is number => x != null);
    const instNet5 = instVals.length > 0 ? instVals.reduce((a, b) => a + b, 0) : null;
    // 5 日買超金額 = 成分股 instAmt[5日] 加總（INST_PERIODS 索引 2 = 5 日）
    const amtVals = members.map(m => m.instAmt?.[INST_PERIODS.indexOf(5)]).filter((x): x is number => x != null);
    const instAmt5 = amtVals.length > 0 ? amtVals.reduce((a, b) => a + b, 0) : null;
    const top = withD1.length > 0
      ? withD1.reduce((best, m) => ((m.d1 ?? -Infinity) > (best.d1 ?? -Infinity) ? m : best))
      : null;
    return {
      theme,
      stockCount: members.length,
      avgD1, avgD5, avgD20, avgD60, avgVolRatio, breadth, instNet5, instAmt5,
      stage: classifyStage({ avgD5, avgD20, avgVolRatio }),
      topStock: top && top.d1 != null ? { code: top.code, name: top.name, d1: top.d1 } : null,
      members,
    };
  });

  // 預設排序：5 日平均報酬 desc（資金近期流向），null 沉底
  themes.sort((a, b) => (b.avgD5 ?? -Infinity) - (a.avgD5 ?? -Infinity));

  return { date, generatedAt: new Date().toISOString(), themes };
}

// ── 儲存 ─────────────────────────────────────────────────────────────────────

export async function saveSectorRanking(file: SectorRankingFile): Promise<void> {
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await fs.mkdir(SECTORS_DIR, { recursive: true });
  await atomicFsPut(path.join(SECTORS_DIR, `${file.date}.json`), JSON.stringify(file));
}

export async function readSectorRanking(date: string): Promise<SectorRankingFile | null> {
  try {
    const raw = await fs.readFile(path.join(SECTORS_DIR, `${date}.json`), 'utf-8');
    return JSON.parse(raw) as SectorRankingFile;
  } catch {
    return null;
  }
}

/** 列出所有已產生的題材排名日期（升冪） */
export async function listSectorDates(): Promise<string[]> {
  try {
    const files = await fs.readdir(SECTORS_DIR);
    return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace('.json', '')).sort();
  } catch {
    return [];
  }
}

/** 最近一個有檔的日期（往回找 maxBack 個日曆日） */
export async function readLatestSectorRanking(maxBack = 7): Promise<SectorRankingFile | null> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i <= maxBack; i++) {
    const iso = new Date(d.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const file = await readSectorRanking(iso);
    if (file) return file;
  }
  return null;
}
