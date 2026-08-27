/**
 * 今日全市場官方產業熱點。
 *
 * 與 sectorRanking 的差別：
 *   - sectorRanking =「正著算」：依 TWSE／TPEx 官方產業完整母體計算多日表現。
 *   - hotThemeScan =「反著做」：先掃全市場 L2 快照（~2000 檔）找出今天在熱的股
 *     （漲幅 + 爆量 + 法人買超），再依官方產業別分組。
 *
 * 分類來源：TWSE／TPEx 公司基本資料 OpenAPI；官方資料缺漏時才落到「未分類」。
 *
 * 紅線：純顯示/排序參考，不接選股 gate、不入 pool 分數（鐵則 #5）。
 * 熱度公式 + 排名分是顯示用 heuristic（門檻寫死在此檔，未經回測）。
 * 讀的是單一 L2 全市場快照（鐵則 #3 的「快照粗掃」），不逐檔讀 Blob。
 */

import { readIntradaySnapshot, readMABase } from '@/lib/datasource/IntradayCache';
import { isLimitUp as isLimitUpPrice } from '@/lib/utils/limitRules';
import { fetchTWIndustryMap } from '@/lib/scanner/conceptMap';
import { TW_OFFICIAL_CLASSIFICATION } from '@/lib/datasource/TWOfficialIndustry';
import { readCandleFile } from '@/lib/datasource/CandleStorageAdapter';
import { readInstStock } from '@/lib/chips/ChipStorage';
import { readMarginStock } from '@/lib/chips/ChipExtrasStorage';
import { PERF_PERIODS, INST_PERIODS } from './perfPeriods';
import { getTWChineseName } from '@/lib/datasource/TWSENames';
import { isPlaceholderStockName, stockDisplayName } from '@/lib/stocks/stockIdentity';

export type ThemeLabelSource = 'concept' | 'industry' | 'other';

export interface HotStock {
  code: string;
  name: string;
  /** 漲跌幅 % */
  changePercent: number;
  /** 今日成交量（張） */
  volume: number;
  /** 今日量 / 前 5 日均量（無 MA base = null） */
  volRatio: number | null;
  /** 今日成交金額（元 = 量張×1000×收盤；buildHotThemeScan 才補，純聚合時 undefined） */
  turnover?: number | null;
  /** 三大法人淨買賣（有當日全市場資料才有，否則 null） */
  instNet: number | null;
  /** 漲停（TW ±10%，≥9.5% 視為漲停） */
  isLimitUp: boolean;
  /** 注意股（警示，不剔除） */
  isNotice: boolean;
  /** 熱度合成分 0-100 */
  heat: number;
  theme: string;
  themeSource: ThemeLabelSource;
  /** 過去 N 日漲幅 %（對齊 PERF_PERIODS = 1,2,…,10,20；buildHotThemeScan 才補，純聚合時 undefined） */
  rets?: (number | null)[];
  /** 外資+投信過去 N 日買超金額 (元；對齊 INST_PERIODS=1,3,5,10) */
  instAmt?: (number | null)[];
  /** 散戶(融資)過去 N 日淨變化金額 (元；融資淨變化張×1000×當日收盤；對齊 INST_PERIODS) */
  retailAmt?: (number | null)[];
}

export interface HotTheme {
  theme: string;
  source: ThemeLabelSource;
  /** 該題材的熱門股數 */
  hotCount: number;
  /** 熱門成分平均漲幅 % */
  avgChange: number;
  /** 熱門成分最大漲幅 % */
  maxChange: number;
  /** 熱門成分平均熱度分 */
  avgHeat: number;
  /** 排名分（avgHeat + 參與廣度 bonus） */
  score: number;
  topStock: { code: string; name: string; changePercent: number } | null;
  /** 該題材的熱門股（按熱度 desc） */
  members: HotStock[];
}

export interface HotThemeScanFile {
  date: string;
  generatedAt: string;
  market: 'TW';
  classification: typeof TW_OFFICIAL_CLASSIFICATION;
  /** 快照總檔數（含被濾掉的指數/ETF） */
  totalScanned: number;
  /** 通過熱度門檻的個股數 */
  hotStockCount: number;
  /** 熱門但歸不到細題材/產業（落到「其他」）的檔數 */
  uncategorizedCount: number;
  /** 法人買超資料是否為當日（過期則熱度不含法人加分） */
  instFresh: boolean;
  themes: HotTheme[];
}

// ── 熱度公式（顯示用 heuristic，門檻單一事實在此）──────────────────────────────
// 漲幅最多 60 分（+10% 封頂）、爆量最多 25 分（量比 3x 封頂）、法人買超 15 分（有買超就給）。
// 沒有法人資料時上限 85；有則 100。純相對排序用，絕對值不代表勝率。

export const HOT_MIN_HEAT = 25; // 熱度門檻：約 +4.2% 單漲、或 +2.5% 帶量
export const HOT_MIN_CHANGE = 1; // 至少要上漲（濾掉量爆但價平/下跌的雜訊）

export function computeHeat(
  changePercent: number,
  volRatio: number | null,
  instNet: number | null,
): number {
  const up = Math.max(0, changePercent);
  const chgPart = Math.min(60, up * 6); // +10% → 60
  const volPart = volRatio != null ? Math.min(25, Math.max(0, volRatio - 1) * 12.5) : 0; // 3x → 25
  const instPart = instNet != null && instNet > 0 ? 15 : 0;
  return Math.round(chgPart + volPart + instPart);
}

function labelOf(
  code: string,
  industryOf: (code: string) => string | undefined,
): { theme: string; source: ThemeLabelSource } {
  const ind = industryOf(code);
  if (ind) return { theme: ind, source: 'industry' };
  return { theme: '未分類', source: 'other' };
}

/** 只看真正的個股 4 碼（1xxx-9xxx）：自動排除指數(^)、ETF/權證(00xxxx/5-6 碼) */
function isRealStock(code: string): boolean {
  return /^[1-9]\d{3}$/.test(code);
}

// ── 純聚合（無 IO，可測）─────────────────────────────────────────────────────

export interface AggregateParams {
  date: string;
  quotes: Array<{
    symbol: string;
    name: string;
    changePercent: number;
    volume: number;
    close: number;
    prevClose: number;
  }>;
  volRatioOf: (code: string) => number | null;
  instOf: (code: string) => number | null;
  industryOf: (code: string) => string | undefined;
  isDisposal: (code: string) => boolean;
  isNotice: (code: string) => boolean;
  instFresh: boolean;
}

export function aggregateHotThemes(params: AggregateParams): HotThemeScanFile {
  const { date, quotes, volRatioOf, instOf, industryOf, isDisposal, isNotice, instFresh } = params;

  // 1. 全市場 → 個股熱度
  const hot: HotStock[] = [];
  for (const q of quotes) {
    const code = q.symbol.replace(/\.(TW|TWO)$/i, '');
    if (!isRealStock(code)) continue;          // 濾指數/ETF/權證
    if (isDisposal(code)) continue;            // 處置股不可交易，排除（鐵則）
    if (q.changePercent < HOT_MIN_CHANGE) continue;
    const volRatio = volRatioOf(code);
    const instNet = instOf(code);
    const heat = computeHeat(q.changePercent, volRatio, instNet);
    if (heat < HOT_MIN_HEAT) continue;
    const { theme, source } = labelOf(code, industryOf);
    hot.push({
      code,
      name: stockDisplayName(q.name, q.symbol),
      changePercent: q.changePercent,
      volume: q.volume,
      volRatio,
      instNet,
      // 用真實漲停價判斷（前收 × 1.10 + tick 容忍），不再用 +9.5% 寬估誤判
      isLimitUp: q.close > 0 && q.prevClose > 0 && isLimitUpPrice(q.close, q.prevClose, 'TW', code),
      isNotice: isNotice(code),
      heat,
      theme,
      themeSource: source,
    });
  }

  // 2. 按題材分組
  const byTheme = new Map<string, HotStock[]>();
  for (const s of hot) {
    const arr = byTheme.get(s.theme);
    if (arr) arr.push(s);
    else byTheme.set(s.theme, [s]);
  }

  // 3. 題材聚合 + 排名
  const themes: HotTheme[] = [];
  for (const [theme, members] of byTheme) {
    members.sort((a, b) => b.heat - a.heat);
    const hotCount = members.length;
    const avgChange = +(members.reduce((a, m) => a + m.changePercent, 0) / hotCount).toFixed(2);
    const maxChange = +Math.max(...members.map((m) => m.changePercent)).toFixed(2);
    const avgHeat = +(members.reduce((a, m) => a + m.heat, 0) / hotCount).toFixed(1);
    // 排名分：個股強度（avgHeat）+ 參與廣度 bonus（最多 8 檔封頂，避免大產業靠數量輾壓）
    const score = +(avgHeat + Math.min(hotCount, 8) * 4).toFixed(1);
    const top = members.reduce((best, m) => (m.changePercent > best.changePercent ? m : best));
    themes.push({
      theme,
      source: members[0].themeSource,
      hotCount,
      avgChange,
      maxChange,
      avgHeat,
      score,
      topStock: { code: top.code, name: top.name, changePercent: top.changePercent },
      members,
    });
  }

  themes.sort((a, b) => b.score - a.score);

  return {
    date,
    generatedAt: new Date().toISOString(),
    market: 'TW',
    classification: TW_OFFICIAL_CLASSIFICATION,
    totalScanned: quotes.length,
    hotStockCount: hot.length,
    uncategorizedCount: hot.filter((s) => s.themeSource === 'other').length,
    instFresh,
    themes,
  };
}

// ── 載入 + 建構（IO）─────────────────────────────────────────────────────────

/** 過去 N 日漲幅 %（對齊 PERF_PERIODS），讀 L1 日K；與 sectorRanking 同公式（trailing）。 */
async function memberPerfTW(code: string, date: string): Promise<{ rets: (number | null)[]; instAmt: (number | null)[]; retailAmt: (number | null)[]; turnover: number | null }> {
  const noRets = PERF_PERIODS.map(() => null);
  const noAmt: (number | null)[] = INST_PERIODS.map(() => null);
  const file = (await readCandleFile(`${code}.TW`, 'TW'))
    ?? (await readCandleFile(`${code}.TWO`, 'TW'));
  if (!file?.candles?.length) return { rets: noRets, instAmt: noAmt, retailAmt: noAmt, turnover: null };
  const candles = file.candles;
  let idx = -1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date <= date) { idx = i; break; }
  }
  if (idx < 0) return { rets: noRets, instAmt: noAmt, retailAmt: noAmt, turnover: null };
  const close = candles[idx].close;
  // 今日成交金額（元）= 量(張)×1000×收盤
  const turnover = candles[idx].volume > 0 ? Math.round(candles[idx].volume * 1000 * close) : null;
  const rets = PERF_PERIODS.map((n) => {
    if (idx - n < 0) return null;
    const base = candles[idx - n].close;
    return base > 0 ? +(((close - base) / base) * 100).toFixed(1) : null;
  });
  const closeByDate = new Map(candles.map((c) => [c.date, c.close]));
  // 外資+投信過去 N 日買超金額 = 逐日(張×1000×當日收盤)
  let instAmt = noAmt;
  try {
    const inst = await readInstStock(code);
    if (inst?.data?.length) {
      const past = inst.data.filter((r) => r.date <= date);
      instAmt = INST_PERIODS.map((n) => {
        const rows = past.slice(-n);
        if (rows.length === 0) return null;
        let amt = 0; let any = false;
        for (const r of rows) {
          const c = closeByDate.get(r.date);
          if (c == null) continue;
          amt += ((r.foreign ?? 0) + (r.trust ?? 0) + (r.dealer ?? 0)) * 1000 * c; // 三大法人
          any = true;
        }
        return any ? Math.round(amt) : null;
      });
    }
  } catch { /* 法人 optional */ }
  // 融資過去 N 日淨變化「金額」= 逐日(張×1000×當日收盤)＝元
  let retailAmt = noAmt;
  try {
    const margin = await readMarginStock(code);
    if (margin?.data?.length) {
      const past = margin.data.filter((r) => r.date <= date);
      retailAmt = INST_PERIODS.map((n) => {
        const rows = past.slice(-n);
        if (rows.length === 0) return null;
        let amt = 0; let any = false;
        for (const r of rows) {
          if (r.marginNet == null) continue;
          const c = closeByDate.get(r.date);
          if (c == null) continue;
          amt += r.marginNet * 1000 * c; // 融資淨變化 張×1000股×當日收盤 = 元
          any = true;
        }
        return any ? Math.round(amt) : null;
      });
    }
  } catch { /* 融資 optional */ }
  return { rets, instAmt, retailAmt, turnover };
}

/**
 * 算指定日期的全市場熱門題材。讀單一 L2 快照（鐵則 #3），無快照回 null。
 *
 * opts.enrich（預設 true）：補每檔熱門成分股「過去 N 日漲幅 + 法人/融資金額」。
 *   - true  = 盤後完整版（/api/themes/hot），會逐檔讀 L1+籌碼，較重。
 *   - false = 盤中即時輕量版（/api/themes/live），只回純聚合（題材/即時漲跌/熱度/領漲股/廣度），
 *             跳過逐檔 L1 讀取 → 快、適合 60s 輪詢。
 */
export async function buildHotThemeScan(
  date: string,
  opts: { enrich?: boolean } = {},
): Promise<HotThemeScanFile | null> {
  const { enrich = true } = opts;
  const snapshot = await readIntradaySnapshot('TW', date);
  if (!snapshot || snapshot.quotes.length === 0) return null;

  // 行情 provider 可能在降級時把代號塞進 name；只補這些占位名稱，正常快照零額外成本。
  const placeholderCodes = [...new Set(snapshot.quotes
    .filter(q => isPlaceholderStockName(q.name, q.symbol))
    .map(q => q.symbol.replace(/\.(TW|TWO)$/i, ''))
    .filter(isRealStock))];
  const resolvedNames = new Map<string, string>();
  await Promise.all(placeholderCodes.map(async code => {
    const name = await getTWChineseName(code);
    if (name) resolvedNames.set(code, name);
  }));

  // 量比：MA base（最近 N 根收/量）。前 5 日均量為基準，今日量 = 快照量。
  const maBase = await readMABase('TW', snapshot.date);
  const volRatioOf = (code: string): number | null => {
    const entry = maBase?.data[code];
    if (!entry || entry.volumes.length < 5) return null;
    const last5 = entry.volumes.slice(-5);
    const avg = last5.reduce((a, b) => a + b, 0) / last5.length;
    const today = snapshot.quotes.find((q) => q.symbol.replace(/\.(TW|TWO)$/i, '') === code)?.volume;
    if (!avg || avg <= 0 || today == null) return null;
    return +(today / avg).toFixed(2);
  };

  // 官方產業別（TWSE/TPEx OpenAPI，24h cache；失敗時誠實落「未分類」）
  let industryMap = new Map<string, string>();
  try {
    industryMap = await fetchTWIndustryMap();
  } catch {
    /* 網路失敗不以人工題材替代官方分類 */
  }
  const industryOf = (code: string) => industryMap.get(code);

  // 法人買超（全市場單檔，可能過期）— 有資料且日期吻合才當熱度加分
  let instMap: Map<string, number> | null = null;
  let instFresh = false;
  try {
    const { readInstitutionalTW } = await import('@/lib/storage/institutionalStorage');
    const inst = await readInstitutionalTW(snapshot.date);
    if (inst && inst.length > 0) {
      instMap = new Map(inst.map((r) => [r.symbol, r.total]));
      instFresh = true;
    }
  } catch {
    /* 法人資料 optional */
  }
  const instOf = (code: string) => instMap?.get(code) ?? null;

  // 處置/注意名單
  let isDisposal = (_code: string) => false;
  let isNotice = (_code: string) => false;
  try {
    const { getActiveDisposalSet, getRecentNoticeSet } = await import('@/lib/market/attentionList');
    const [disposal, notice] = await Promise.all([
      getActiveDisposalSet(snapshot.date),
      getRecentNoticeSet(snapshot.date, 5),
    ]);
    isDisposal = (code: string) => disposal.has(code);
    isNotice = (code: string) => notice.has(code);
  } catch {
    /* 名單 optional */
  }

  const result = aggregateHotThemes({
    date: snapshot.date,
    quotes: snapshot.quotes.map((q) => ({
      symbol: q.symbol,
      name: resolvedNames.get(q.symbol.replace(/\.(TW|TWO)$/i, '')) ?? q.name,
      changePercent: q.changePercent,
      volume: q.volume,
      close: q.close,
      prevClose: q.prevClose,
    })),
    volRatioOf,
    instOf,
    industryOf,
    isDisposal,
    isNotice,
    instFresh,
  });

  // 每檔熱門成分股補「過去 1~10,20 日漲幅」+「法人 1/3/5/10 日買超金額」（讀 L1+inst，併發 16）。
  // 即時輕量版（enrich=false）跳過這段重活，只回純聚合結果。
  if (enrich) {
    const members = result.themes.flatMap((t) => t.members);
    const uniqCodes = [...new Set(members.map((m) => m.code))];
    const perfMap = new Map<string, { rets: (number | null)[]; instAmt: (number | null)[]; retailAmt: (number | null)[]; turnover: number | null }>();
    const CONC = 16;
    for (let i = 0; i < uniqCodes.length; i += CONC) {
      const batch = uniqCodes.slice(i, i + CONC);
      const rows = await Promise.all(batch.map((c) => memberPerfTW(c, snapshot.date)));
      batch.forEach((c, j) => perfMap.set(c, rows[j]));
    }
    for (const m of members) {
      const p = perfMap.get(m.code);
      m.rets = p?.rets;
      m.instAmt = p?.instAmt;
      m.retailAmt = p?.retailAmt;
      m.turnover = p?.turnover ?? null;
    }
  }

  return result;
}

/** 最近一個有 L2 快照的交易日（往回找 maxBack 個日曆日） */
export async function buildLatestHotThemeScan(
  maxBack = 7,
  opts: { enrich?: boolean } = {},
): Promise<HotThemeScanFile | null> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const base = new Date(`${today}T00:00:00Z`);
  for (let i = 0; i <= maxBack; i++) {
    const iso = new Date(base.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const file = await buildHotThemeScan(iso, opts);
    if (file && file.hotStockCount > 0) return file;
  }
  return null;
}
