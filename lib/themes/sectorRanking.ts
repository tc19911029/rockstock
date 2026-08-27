/**
 * TWSE／TPEx 官方產業強弱排名 + 6 階段顯示分類。
 *
 * 產業母體只使用兩交易所的公司基本資料 OpenAPI；逐檔讀本地 L1 日K + chips inst 日序列。
 * 不混入手工 AI、CPO、CoWoS 等市場題材，跑在盤後 cron（17:10 CST，L1 14:30 已封）。
 *
 * 紅線：輸出是「顯示/排序參考」，不接選股 gate、不入 pool 分數（鐵則 #5）。
 * 6 階段分類是顯示用 heuristic（門檻寫死在 classifyStage，非書本規則、未經回測）—
 * 要升級成排序權重必須先走 backtest-unified-leaderboard 變體驗證（計畫 Phase 6）。
 *
 * 儲存：data/sectors/TW/{date}.json（日檔不互覆，遵守 L4 主鍵精神）。
 */
import fs from 'fs/promises';
import path from 'path';
import {
  TW_OFFICIAL_CLASSIFICATION,
  fetchTwOfficialIndustryRoster,
  groupOfficialIndustryStocks,
  officialIndustryGroupId,
  officialIndustryName,
  type TwOfficialMarket,
  type TwOfficialIndustryStock,
} from '@/lib/datasource/TWOfficialIndustry';
import { isValidYmd } from '@/lib/utils/ymd';
import { isTradingDay } from '@/lib/utils/tradingDay';
import { getLastTradingDay } from '@/lib/datasource/marketHours';
import { PERF_PERIODS, INST_PERIODS } from './perfPeriods';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readInstStock } from '@/lib/chips/ChipStorage';
import { readMarginStock } from '@/lib/chips/ChipExtrasStorage';
import { readRecentInstitutionalDaysTW } from '@/lib/storage/institutionalStorage';

const SECTORS_DIR = path.join(process.cwd(), 'data', 'sectors', 'TW');

export type ThemeStage = '剛啟動' | '主升段' | '高潮噴出' | '震盪換手' | '退潮' | '補跌' | '盤整';

export interface ThemeStockPerf {
  code: string;
  name: string;
  symbol: string;
  market: TwOfficialMarket;
  industryCode: string;
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
  industryId: string;
  industryCode: string;
  markets: TwOfficialMarket[];
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
  /** 具備完整近 5 日法人資料的成分股比例（0-1） */
  instCoverage: number;
  stage: ThemeStage;
  /** 當日最強成分股（d1 最大） */
  topStock: { code: string; name: string; symbol: string; d1: number } | null;
  members: ThemeStockPerf[];
}

export interface SectorRankingFile {
  date: string;
  generatedAt: string;
  classification: typeof TW_OFFICIAL_CLASSIFICATION;
  universe: {
    source: 'TWSE_TPEx_company_info';
    rosterAsOf: string;
    pointInTime: boolean;
    stockCount: number;
  };
  themes: ThemeRank[];
}

// ── 個股報酬計算 ──────────────────────────────────────────────────────────────

interface InstitutionalFallbackDay {
  date: string;
  sharesByCode: Map<string, number>;
  readyMarkets: Set<TwOfficialMarket>;
}

async function loadInstitutionalFallback(
  roster: TwOfficialIndustryStock[],
  date: string,
): Promise<InstitutionalFallbackDay[]> {
  const days = await readRecentInstitutionalDaysTW(date, Math.max(...INST_PERIODS));
  const rosterByMarket = {
    TWSE: new Set(roster.filter((stock) => stock.market === 'TWSE').map((stock) => stock.code)),
    TPEx: new Set(roster.filter((stock) => stock.market === 'TPEx').map((stock) => stock.code)),
  };
  return days.map((day) => {
    const sharesByCode = new Map<string, number>();
    for (const record of day.records) {
      const code = record.symbol.trim();
      if (/^[1-9]\d{3}$/.test(code) && Number.isFinite(record.total)) sharesByCode.set(code, record.total);
    }
    const readyMarkets = new Set<TwOfficialMarket>();
    for (const market of ['TWSE', 'TPEx'] as const) {
      const universe = rosterByMarket[market];
      let covered = 0;
      for (const code of universe) if (sharesByCode.has(code)) covered++;
      if (universe.size > 0 && covered / universe.size >= 0.75) readyMarkets.add(market);
    }
    return { date: day.date, sharesByCode, readyMarkets };
  });
}

async function loadStockPerf(
  stock: TwOfficialIndustryStock,
  date: string,
  institutionalDays: InstitutionalFallbackDay[],
): Promise<ThemeStockPerf> {
  const empty: ThemeStockPerf = {
    code: stock.code, name: stock.name, symbol: stock.symbol, market: stock.market, industryCode: stock.industryCode,
    d1: null, d5: null, d20: null, d60: null, volRatio: null, turnover: null, instNet5: null,
    rets: PERF_PERIODS.map(() => null),
    instAmt: INST_PERIODS.map(() => null),
    retailAmt: INST_PERIODS.map(() => null),
  };
  // 官方市場別已知，直接讀正確後綴，避免全市場逐檔試兩次。
  const suffix = stock.market === 'TWSE' ? 'TW' : 'TWO';
  const file = await readCandleFile(`${stock.code}.${suffix}`, 'TW');
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

  // 三大法人近 5 日合計（張）+ 過去 1/2/3/4/5/10/20 日買超金額。
  // 優先採官方全市場日檔（股），逐股 ChipStorage（張）只補來源未就緒的日期。
  let instNet5: number | null = null;
  let instAmt: (number | null)[] = INST_PERIODS.map(() => null);
  try {
    const inst = await readInstStock(stock.code);
    const chipByDate = new Map((inst?.data ?? []).filter((row) => row.date <= date).map((row) => [
      row.date,
      ((row.foreign ?? 0) + (row.trust ?? 0) + (row.dealer ?? 0)) * 1000,
    ]));
    const rows: Array<{ date: string; netShares: number }> = [];
    for (const day of institutionalDays) {
      const officialShares = day.sharesByCode.get(stock.code);
      if (officialShares != null) rows.push({ date: day.date, netShares: officialShares });
      else if (day.readyMarkets.has(stock.market)) rows.push({ date: day.date, netShares: 0 });
      else {
        const chipShares = chipByDate.get(day.date);
        if (chipShares != null) rows.push({ date: day.date, netShares: chipShares });
      }
    }
    if (rows.length === 0) {
      for (const [rowDate, netShares] of [...chipByDate].sort(([a], [b]) => a.localeCompare(b))) {
        rows.push({ date: rowDate, netShares });
      }
    }
    const rows5 = rows.slice(-5);
    if (rows5.length === 5) instNet5 = rows5.reduce((sum, row) => sum + row.netShares, 0) / 1000;
    const closeByDate = new Map(candles.map(c => [c.date, c.close]));
    instAmt = INST_PERIODS.map((n) => {
      const window = rows.slice(-n);
      if (window.length !== n) return null;
      let amount = 0;
      for (const row of window) {
        if (row.netShares === 0) continue;
        const rowClose = closeByDate.get(row.date);
        if (rowClose == null) return null;
        amount += row.netShares * rowClose;
      }
      return Math.round(amount);
    });
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
    code: stock.code, name: stock.name, symbol: stock.symbol, market: stock.market, industryCode: stock.industryCode,
    d1: ret(1), d5: ret(5), d20: ret(20), d60: ret(60), volRatio, turnover, instNet5,
    rets: PERF_PERIODS.map((n) => ret(n)),
    instAmt, retailAmt,
  };
}

// ── 產業 6 階段（顯示用 heuristic，門檻單一事實在此）────────────────────────────

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
  if (!isValidYmd(date)) throw new Error(`invalid sector ranking date: ${date}`);
  if (!isTradingDay(date, 'TW')) throw new Error(`not a TW trading day: ${date}`);
  const lastClosedDate = getLastTradingDay('TW');
  if (date > lastClosedDate) throw new Error(`sector ranking date is not closed yet: ${date}`);
  const roster = await fetchTwOfficialIndustryRoster();
  const industryGroups = groupOfficialIndustryStocks(roster);
  const institutionalDays = await loadInstitutionalFallback(roster, date);

  // 官方分類一檔只屬一個產業；先算全市場個股績效，再按產業聚合。
  const perfCache = new Map<string, ThemeStockPerf>();
  const CONCURRENCY = 16;
  const entries = roster;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(s => loadStockPerf(s, date, institutionalDays)));
    for (const p of results) perfCache.set(p.code, p);
  }

  const themes: ThemeRank[] = industryGroups.map(({ id: industryId, industryCode, industry: theme, markets, stocks }) => {
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
    const instCovered = members.filter((member) => member.instNet5 != null && member.instAmt[INST_PERIODS.indexOf(5)] != null);
    const instVals = instCovered.map((member) => member.instNet5 as number);
    const instCoverage = members.length > 0 ? +(instCovered.length / members.length).toFixed(4) : 0;
    const instNet5 = instCoverage >= 0.8 ? instVals.reduce((a, b) => a + b, 0) : null;
    // 5 日買超金額 = 成分股 instAmt[5日] 加總（INST_PERIODS 索引 2 = 5 日）
    const amtVals = instCovered.map((member) => member.instAmt[INST_PERIODS.indexOf(5)] as number);
    const instAmt5 = instCoverage >= 0.8 ? amtVals.reduce((a, b) => a + b, 0) : null;
    const top = withD1.length > 0
      ? withD1.reduce((best, m) => ((m.d1 ?? -Infinity) > (best.d1 ?? -Infinity) ? m : best))
      : null;
    return {
      industryId,
      industryCode,
      markets,
      theme,
      stockCount: members.length,
      avgD1, avgD5, avgD20, avgD60, avgVolRatio, breadth, instNet5, instAmt5, instCoverage,
      stage: classifyStage({ avgD5, avgD20, avgVolRatio }),
      topStock: top && top.d1 != null ? { code: top.code, name: top.name, symbol: top.symbol, d1: top.d1 } : null,
      members,
    };
  });

  // 預設排序：5 日平均報酬 desc（資金近期流向），null 沉底
  themes.sort((a, b) => (b.avgD5 ?? -Infinity) - (a.avgD5 ?? -Infinity));

  const generatedAtDate = new Date();
  const generatedAt = generatedAtDate.toISOString();
  const rosterAsOf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(generatedAtDate);
  return {
    date,
    generatedAt,
    classification: TW_OFFICIAL_CLASSIFICATION,
    universe: {
      source: 'TWSE_TPEx_company_info',
      rosterAsOf,
      pointInTime: date === rosterAsOf,
      stockCount: roster.length,
    },
    themes,
  };
}

// ── 儲存 ─────────────────────────────────────────────────────────────────────

const isNullableFiniteNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

/** 防止只改 classification 標頭的舊人工檔或半寫入檔冒充官方產業快照。 */
export function isSectorRankingFile(value: unknown, expectedDate?: string): value is SectorRankingFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<SectorRankingFile>;
  if (!isValidYmd(file.date) || !isTradingDay(file.date, 'TW') || (expectedDate != null && file.date !== expectedDate)) return false;
  if (file.date > getLastTradingDay('TW')) return false;
  if (typeof file.generatedAt !== 'string' || Number.isNaN(Date.parse(file.generatedAt))) return false;
  const generatedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(file.generatedAt));
  if (generatedDate < file.date) return false;
  if (
    file.classification?.kind !== TW_OFFICIAL_CLASSIFICATION.kind
    || file.classification?.version !== TW_OFFICIAL_CLASSIFICATION.version
    || file.classification?.label !== TW_OFFICIAL_CLASSIFICATION.label
    || file.classification?.sources?.length !== TW_OFFICIAL_CLASSIFICATION.sources.length
    || !file.classification.sources.every((source, index) => source === TW_OFFICIAL_CLASSIFICATION.sources[index])
    || !Array.isArray(file.themes)
    || file.themes.length === 0
  ) return false;
  if (
    file.universe?.source !== 'TWSE_TPEx_company_info'
    || !isValidYmd(file.universe.rosterAsOf)
    || file.universe.rosterAsOf !== generatedDate
    || file.universe.pointInTime !== (file.universe.rosterAsOf === file.date)
    || !Number.isInteger(file.universe.stockCount)
    || file.universe.stockCount <= 0
  ) return false;

  const industryIds = new Set<string>();
  const symbols = new Set<string>();
  for (const theme of file.themes) {
    if (!theme || typeof theme !== 'object') return false;
    if (!theme.industryCode || !theme.theme || !Array.isArray(theme.markets) || theme.markets.length === 0) return false;
    if (!theme.markets.every((market) => market === 'TWSE' || market === 'TPEx')) return false;
    const markets = [...new Set(theme.markets)].sort() as TwOfficialMarket[];
    if (markets.length !== theme.markets.length) return false;
    if (!markets.every((market) => officialIndustryName(market, theme.industryCode) === theme.theme)) return false;
    let expectedId: string;
    try {
      expectedId = officialIndustryGroupId(theme.industryCode, theme.theme, markets);
    } catch {
      return false;
    }
    if (theme.industryId !== expectedId || industryIds.has(theme.industryId)) return false;
    industryIds.add(theme.industryId);
    if (!Array.isArray(theme.members) || theme.stockCount !== theme.members.length || theme.members.length === 0) return false;
    if (![theme.avgD1, theme.avgD5, theme.avgD20, theme.avgD60, theme.avgVolRatio, theme.breadth, theme.instNet5, theme.instAmt5, theme.instCoverage]
      .every(isNullableFiniteNumber)) return false;
    if (theme.instCoverage < 0 || theme.instCoverage > 1) return false;
    if (!['剛啟動', '主升段', '高潮噴出', '震盪換手', '退潮', '補跌', '盤整'].includes(theme.stage)) return false;

    const memberSymbols = new Set<string>();
    for (const member of theme.members) {
      if (!member || typeof member !== 'object' || !/^[1-9]\d{3}$/.test(member.code) || !member.name) return false;
      if (member.market !== 'TWSE' && member.market !== 'TPEx') return false;
      if (member.industryCode !== theme.industryCode || officialIndustryName(member.market, member.industryCode) !== theme.theme) return false;
      const expectedSymbol = `${member.code}.${member.market === 'TWSE' ? 'TW' : 'TWO'}`;
      if (member.symbol !== expectedSymbol || !markets.includes(member.market)) return false;
      if (symbols.has(member.symbol) || memberSymbols.has(member.symbol)) return false;
      symbols.add(member.symbol);
      memberSymbols.add(member.symbol);
      if (![member.d1, member.d5, member.d20, member.d60, member.volRatio, member.turnover, member.instNet5]
        .every(isNullableFiniteNumber)) return false;
      if (
        !Array.isArray(member.rets) || member.rets.length !== PERF_PERIODS.length || !member.rets.every(isNullableFiniteNumber)
        || !Array.isArray(member.instAmt) || member.instAmt.length !== INST_PERIODS.length || !member.instAmt.every(isNullableFiniteNumber)
        || !Array.isArray(member.retailAmt) || member.retailAmt.length !== INST_PERIODS.length || !member.retailAmt.every(isNullableFiniteNumber)
      ) return false;
    }
    const instMembers = theme.members.filter((member) => member.instNet5 != null && member.instAmt[INST_PERIODS.indexOf(5)] != null);
    const expectedCoverage = +(instMembers.length / theme.members.length).toFixed(4);
    if (theme.instCoverage !== expectedCoverage) return false;
    if (expectedCoverage >= 0.8) {
      const expectedNet = instMembers.reduce((sum, member) => sum + (member.instNet5 ?? 0), 0);
      const expectedAmount = instMembers.reduce((sum, member) => sum + (member.instAmt[INST_PERIODS.indexOf(5)] ?? 0), 0);
      if (theme.instNet5 !== expectedNet || theme.instAmt5 !== expectedAmount) return false;
    } else if (theme.instNet5 !== null || theme.instAmt5 !== null) return false;

    if (theme.topStock != null) {
      const topMember = theme.members.find((member) => member.symbol === theme.topStock?.symbol);
      const maxD1 = Math.max(...theme.members.map((member) => member.d1 ?? -Infinity));
      if (
        !topMember
        || topMember.code !== theme.topStock.code
        || topMember.name !== theme.topStock.name
        || topMember.d1 !== theme.topStock.d1
        || theme.topStock.d1 !== maxD1
      ) return false;
    } else if (theme.members.some((member) => member.d1 != null)) return false;
  }
  return symbols.size === file.universe.stockCount;
}

export async function saveSectorRanking(file: SectorRankingFile): Promise<void> {
  const date = file.date;
  if (!isSectorRankingFile(file, date)) throw new Error(`refuse invalid official industry ranking: ${date}`);
  const { atomicFsPut } = await import('@/lib/storage/atomicFsPut');
  await fs.mkdir(SECTORS_DIR, { recursive: true });
  await atomicFsPut(path.join(SECTORS_DIR, `${file.date}.json`), JSON.stringify(file));
}

export async function readSectorRanking(date: string): Promise<SectorRankingFile | null> {
  if (!isValidYmd(date)) return null;
  try {
    const raw = await fs.readFile(path.join(SECTORS_DIR, `${date}.json`), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return isSectorRankingFile(parsed, date) ? parsed : null;
  } catch {
    return null;
  }
}

/** 列出所有已產生的產業排名日期（升冪） */
export async function listSectorDates(): Promise<string[]> {
  try {
    const files = await fs.readdir(SECTORS_DIR);
    return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.replace('.json', '')).sort();
  } catch {
    return [];
  }
}

/** 最近一個有效官方產業檔；跳過未來日期、舊 schema 與半寫入檔。 */
export async function readLatestSectorRanking(): Promise<SectorRankingFile | null> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const dates = (await listSectorDates()).filter((date) => date <= today).reverse();
  for (const date of dates) {
    const file = await readSectorRanking(date);
    if (file) return file;
  }
  return null;
}

/** 指定日期之前最近一個有效官方產業檔。 */
export async function readPriorSectorRanking(date: string): Promise<SectorRankingFile | null> {
  if (!isValidYmd(date)) return null;
  const dates = (await listSectorDates()).filter((candidate) => candidate < date).reverse();
  for (const candidate of dates) {
    const file = await readSectorRanking(candidate);
    if (file) return file;
  }
  return null;
}
