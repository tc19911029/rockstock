/**
 * 陸股板塊排行（/cn-sectors 熱門板塊視圖）— 2026-06-19
 *
 * 純顯示層，與台股 /sectors 同性質：板塊強弱「描述性」呈現，**不參與選股 gate**（鐵則 #5）。
 * 板塊分類用東方財富現成（行業 ~496 / 概念 ~494），盤後 cn-agents-eod cron 已每日抓存
 * data/cn-agents/boards/{date}.json，本模組只在讀取時加掛兩個衍生欄：
 *
 *   1. 輪動（rotation）：今日 vs 約 5 個交易日前的「5 日漲幅排名」變化（鏡像台股 themeRotation）：
 *      rankDelta = 前次名次 − 今日名次（正 = 名次爬升 = 資金轉入）；分桶 ≥3 轉入 / ≤-3 轉出 / 其餘主流。
 *      ⚠️ 描述性，非買賣訊號。
 *   2. 階段（stage）：用手上欄位 pct(今日%)、pct5d(5日%)、mainNetCny(主力淨流入) 的顯示用
 *      heuristic 分類，**非回測驗證**，僅供盯盤一眼分辨「剛啟動/主升/高潮/退潮/盤整」。
 *
 * rotation / stage 兩個 pure 函式有單元測試（__tests__/cn-board-ranking.test.ts）守。
 */

import path from 'path';
import { promises as fs } from 'fs';
import type { BoardEntry } from './types';
import { readBoardsDay, listBoardsDates } from './storage';
import { INST_PERIODS } from '@/lib/themes/perfPeriods';

/** 板塊卡片日視窗（對齊個股卡 CN_RET_COLS = INST_PERIODS [1,2,3,4,5,10,20]） */
const BOARD_WIN = INST_PERIODS as readonly number[];
/** 板塊衍生視窗：漲幅（複利串接每日 pct）＋主力（累加每日 mainNetCny），index 對齊 BOARD_WIN。 */
export interface CnBoardWindows {
  rets: (number | null)[];
  mainFlow: (number | null)[];
}

export type CnBoardStage = '剛啟動' | '主升段' | '高潮噴出' | '退潮' | '盤整';

export type CnRotationBucket = 'in' | 'mid' | 'out';

export interface CnBoardRotation {
  /** 今日 5 日強弱名次（1 = 最強；同 kind 內） */
  rankNow: number;
  /** 約 5 日前名次；無 prior = null */
  rankPrev: number | null;
  /** 名次變化（prior − now；正 = 爬升）；無 prior = null */
  rankDelta: number | null;
  bucket: CnRotationBucket;
}

export interface CnRankedBoard extends BoardEntry {
  rotation: CnBoardRotation | null;
  stage: CnBoardStage;
  /** 漲幅 N 日（複利串接每日 pct），index 對齊 BOARD_WIN；歷史不足 → null */
  rets?: (number | null)[];
  /** 主力 N 日累計（累加每日 mainNetCny，元），index 對齊 BOARD_WIN；歷史不足 → null */
  mainFlow?: (number | null)[];
}

export interface CnBoardRankingFile {
  date: string;
  /** 算輪動用的前一檔日期（約 5 交易日前）；無 = null */
  priorDate: string | null;
  /** 原始東財板塊快照抓取時間；不可用排行重算時間冒充。 */
  snapshotUpdatedAt: string;
  generatedAt: string;
  concepts: CnRankedBoard[];
  industries: CnRankedBoard[];
}

const RANK_DELTA_TH = 3;
/** 輪動比較跨幾個交易日（取 listBoardsDates 的索引回退量）。2026-06-19 改日線＝1（昨天）。 */
const ROTATION_LOOKBACK = 1;

/**
 * 風格/大盤/寬基指數「非題材」板塊濾除 — 2026-06-20（2026-06-22 從紀錄復原）
 *
 * 東財 m:90+t:3 把「風格板塊（科技風格…）、市值規模（大盤股/中盤股…）、寬基指數成份
 * （HS300/MSCI/富時羅素/深成500/創業板綜…）、資金通道（融資融券/滬股通/深股通）、
 * 估值規模分組（破淨股/百元股/茅指數…）」全塞進「概念」。這些是「一籃子股票的大指數」，
 * 不是像「先進封裝/CPO」那種可操作題材；東財 App 的概念排行不顯示它們。
 * /cn-sectors 概念排行用本濾除對齊 App（顯示層，鐵則 #5，不參與選股）。
 *
 * 判定 = 不規則命名走代碼黑名單 ∪ 命名穩定者（風格/大中小盤）走名稱規則。
 * 刻意保留東財也當概念的行為型板塊（次新股、ST股、昨日漲停/高振幅…）。
 */
const META_BOARD_CODES = new Set<string>([
  'BK0596', // 融资融券
  'BK0707', // 沪股通
  'BK0804', // 深股通
  'BK0821', // MSCI中国
  'BK0867', // 富时罗素
  'BK0879', // 标准普尔
  'BK0500', // HS300_
  'BK0568', // 深成500
  'BK0638', // 创业成份
  'BK0742', // 创业板综
  'BK0683', // 央国企改革
  'BK0999', // 茅指数
  'BK1000', // 宁组合
  'BK1112', // 破净股
  'BK1635', // 长期破净
  'BK1636', // 红利破净股
  'BK1059', // 百元股
]);

/** 風格板塊（科技/消費/金融地产/先进制造/医药医疗 风格）＋ 市值規模（大中小盘×成长/价值/股）。命名穩定 → 規則抓，順帶接住未來同型新增。 */
const META_NAME_RE = /风格$|^(大盘|中盘|小盘)(成长|价值|股)$/;

/** 是否為「非題材」的風格/大盤/寬基指數板塊（→ 概念排行不顯示）。 */
export function isMetaStyleBoard(b: Pick<BoardEntry, 'code' | 'name'>): boolean {
  return META_BOARD_CODES.has(b.code) || (b.name != null && META_NAME_RE.test(b.name));
}

/** 濾掉風格/大盤/寬基指數，只留真題材；並依今日漲幅重排回填 rank（顯示用名次）。 */
export function filterRealConcepts(boards: BoardEntry[]): BoardEntry[] {
  return boards
    .filter((b) => !isMetaStyleBoard(b))
    .sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity))
    .map((b, i) => ({ ...b, rank: i + 1 }));
}

/**
 * 盤口/行為/財務/指數型「概念」板塊 — 2026-06-22（盤中即時「純題材」視圖用）
 *
 * 東財 m:90+t:3 除了真題材（CPO/先進封裝/固態電池…），還塞了一堆「不是可操作產業題材」的
 * 盤面板塊：盤口行為（昨日漲停/連板/打二板/炸板/高換手/新高、東方財富熱股、題材股、趨勢股、
 * 反轉股、週期股、行業龍頭、微盤/低價/超跌/價值/權重/紅利股）、籌碼（基金/機構/社保/QFII重倉、
 * 證金持股）、財報預告（XX季報/年報預增…）、事件（並購重組、轉債標的、舉牌、股權激勵/轉讓、
 * 破發、IPO受益、首發經濟、科創板做市、北交所概念、參股XX、創投）、寬基指數（上證50/中證500…）、
 * 次新股 / ST / B股 / GDR。這些 filterRealConcepts 沒擋（它只擋風格/大盤/寬基大指數）。
 *
 * 盤中「即時題材」視圖只想看可操作產業題材 → 用 filterThemeConcepts 再濾掉這類盤面板塊。
 * 刻意保留地域/政策題材（一帶一路/雄安/自貿…），那是 A 股真實題材，非盤面。
 */
const BEHAVIORAL_NAME_RE = /^昨日|多板$|新高$|^东方财富热股$|^题材股$|^趋势股$|^反转股$|^周期股$|^行业龙头$|^微利股$|^超跌股$|^价值股$|^权重股$|^红利股$|微盘|^低价股$|次新股$|ST股$|^B股$|^AB股$|^AH股$|^GDR$|重仓$|^证金持股$|^独角兽$|季报|年报|^并购重组概念$|^转债标的$|^举牌$|^股权激励$|^股权转让$|破增发价股$|^破发股$|^IPO受益$|^首发经济$|科创板做市|^北交所概念$|^参股|^创投$|^(上证|深证|中证|央视|沪深)\d+[R_]?$/;

/** 是否為盤口/行為/財務/指數型「非題材」概念板塊（→ 純題材視圖不顯示）。 */
export function isBehavioralBoard(b: Pick<BoardEntry, 'name'>): boolean {
  return b.name != null && BEHAVIORAL_NAME_RE.test(b.name);
}

/** 純題材概念（盤中即時題材用）：filterRealConcepts 後再濾盤口/行為/財務/指數型 → 只留可操作產業題材，依今日漲幅重排名次。 */
export function filterThemeConcepts(boards: BoardEntry[]): BoardEntry[] {
  return filterRealConcepts(boards)
    .filter((b) => !isBehavioralBoard(b))
    .map((b, i) => ({ ...b, rank: i + 1 }));
}

/**
 * 板塊階段 heuristic（顯示用，非回測）。優先序由「最該標出的狀態」往下：
 *   退潮   ：近 5 日轉弱（pct5d ≤ -3）
 *   高潮噴出：近 5 日大漲且今天還在衝（pct5d ≥ 8 且 pct ≥ 2）
 *   主升段 ：近 5 日續強（pct5d ≥ 4 且 pct > 0）
 *   剛啟動 ：近 5 日剛轉強（pct5d ≥ 1.5 且 pct ≥ 0.5）
 *   盤整   ：其餘
 * pct5d 缺值（歷史不足）→ 只看今日 pct 粗分（≥2 剛啟動 / ≤-2 退潮 / 其餘盤整）。
 */
export function classifyBoardStage(b: Pick<BoardEntry, 'pct' | 'pct5d'>): CnBoardStage {
  const { pct, pct5d } = b;
  if (pct5d == null) {
    if (pct >= 2) return '剛啟動';
    if (pct <= -2) return '退潮';
    return '盤整';
  }
  if (pct5d <= -3) return '退潮';
  if (pct5d >= 8 && pct >= 2) return '高潮噴出';
  if (pct5d >= 4 && pct > 0) return '主升段';
  if (pct5d >= 1.5 && pct >= 0.5) return '剛啟動';
  return '盤整';
}

/** 同 kind 內按「今日漲幅 pct」（缺值沉底）排出名次 map：code → 1-based 名次。 */
function rankByTodayPct(boards: BoardEntry[]): Map<string, number> {
  const sorted = [...boards].sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
  const m = new Map<string, number>();
  sorted.forEach((e, i) => m.set(e.code, i + 1));
  return m;
}

/**
 * 算一組板塊（同 kind）的輪動：今日漲幅名次 vs 昨天（prior 傳前一交易日）。
 * 2026-06-19 改日線（原本用 5 日漲幅名次比 5 交易日前，反應太慢）。
 * prior 為 null（無前一檔）→ 全部 rankDelta=null、bucket='mid'。
 */
export function computeBoardRotation(
  today: BoardEntry[],
  prior: BoardEntry[] | null,
): Map<string, CnBoardRotation> {
  const nowRank = rankByTodayPct(today);
  const prevRank = prior ? rankByTodayPct(prior) : null;
  const out = new Map<string, CnBoardRotation>();
  for (const b of today) {
    const rankNow = nowRank.get(b.code)!;
    const rankPrev = prevRank?.get(b.code) ?? null;
    const rankDelta = rankPrev != null ? rankPrev - rankNow : null;
    let bucket: CnRotationBucket = 'mid';
    if (rankDelta != null) {
      if (rankDelta >= RANK_DELTA_TH) bucket = 'in';
      else if (rankDelta <= -RANK_DELTA_TH) bucket = 'out';
    }
    out.set(b.code, { rankNow, rankPrev, rankDelta, bucket });
  }
  return out;
}

type DaySeriesPt = { pct: number; mainNet: number | null };

/** 由一段升冪日序列算 BOARD_WIN 視窗（漲幅複利串接、主力累加）。 */
function windowsFromSeries(arr: DaySeriesPt[]): CnBoardWindows {
  const rets = BOARD_WIN.map((n) => {
    if (arr.length < n) return null;
    const last = arr.slice(arr.length - n);
    let f = 1;
    for (const x of last) f *= 1 + x.pct / 100;
    return +((f - 1) * 100).toFixed(1);
  });
  const mainFlow = BOARD_WIN.map((n) => {
    if (arr.length < n) return null;
    const last = arr.slice(arr.length - n);
    let s = 0; let any = false;
    for (const x of last) { if (x.mainNet != null) { s += x.mainNet; any = true; } }
    return any ? Math.round(s) : null;
  });
  return { rets, mainFlow };
}

/**
 * 算每個板塊的「漲幅 N 日（複利串接每日 pct）＋主力 N 日（累加 mainNetCny）」。
 * 板塊是 EM 指數（每日 pct = 當日漲跌幅），串接即得 N 日累積報酬。
 * 資料來源 merge：board-history.json（回補的東財歷史 K，補 10/20 日）＋ 我們每天的板塊快照（最近、權威）；
 * 同日以快照為準。板塊層沒有「兩融」（兩融是個股欄位、無板塊合計源）→ 板塊卡只有漲幅／主力兩排。
 */
function computeBoardWindows(
  dated: { date: string; boards: BoardEntry[] | null }[],
  history: Record<string, { date: string; pct: number; mainNet: number | null }[]>,
): Map<string, CnBoardWindows> {
  // 每日 code→{pct,mainNet} map（快照，權威），避免 O(板塊²)
  const dayMaps = dated.map((d) => ({
    date: d.date,
    map: new Map((d.boards ?? []).map((b) => [b.code, { pct: b.pct ?? 0, mainNet: b.mainNetCny }] as const)),
  }));
  const codes = new Set<string>();
  for (const dm of dayMaps) for (const c of dm.map.keys()) codes.add(c);
  for (const c of Object.keys(history)) codes.add(c);

  const out = new Map<string, CnBoardWindows>();
  for (const code of codes) {
    const byDate = new Map<string, DaySeriesPt>();
    for (const h of history[code] ?? []) byDate.set(h.date, { pct: h.pct, mainNet: h.mainNet }); // 先放回補歷史
    for (const dm of dayMaps) { const b = dm.map.get(code); if (b) byDate.set(dm.date, b); }      // 快照覆蓋同日
    const arr = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
    out.set(code, windowsFromSeries(arr));
  }
  return out;
}

/** 讀回補的板塊歷史（board-history.json）；無檔 → 空（板塊卡 10/20 日就空白，靠快照慢慢長）。 */
async function loadBoardHistory(): Promise<Record<string, { date: string; pct: number; mainNet: number | null }[]>> {
  try {
    const p = path.join(process.cwd(), 'data/cn-agents/board-history.json');
    const j = JSON.parse(await fs.readFile(p, 'utf8')) as { boards?: Record<string, { date: string; pct: number; mainNet: number | null }[]> };
    return j.boards ?? {};
  } catch {
    return {};
  }
}

/** 把一組板塊加掛 rotation + stage + 視窗（漲幅/主力）。 */
function enrich(
  boards: BoardEntry[],
  rot: Map<string, CnBoardRotation>,
  win: Map<string, CnBoardWindows>,
): CnRankedBoard[] {
  return boards.map((b) => ({
    ...b,
    rotation: rot.get(b.code) ?? null,
    stage: classifyBoardStage(b),
    rets: win.get(b.code)?.rets,
    mainFlow: win.get(b.code)?.mainFlow,
  }));
}

/**
 * 組某日板塊排行（含輪動 + 階段）。該日無 boards 檔 → null。
 * 輪動的 prior = listBoardsDates 中該日往前數 ROTATION_LOOKBACK 個有檔的日期（不足取最早）。
 */
export async function buildCnBoardRanking(date: string): Promise<CnBoardRankingFile | null> {
  const today = await readBoardsDay(date);
  if (!today) return null;

  const dates = await listBoardsDates();
  const idx = dates.indexOf(date);
  let priorDate: string | null = null;
  if (idx > 0) priorDate = dates[Math.max(0, idx - ROTATION_LOOKBACK)];
  const prior = priorDate && priorDate !== date ? await readBoardsDay(priorDate) : null;

  // 概念排行濾掉風格/大盤/寬基指數大指數（對齊東財 App），industries 是真行業不動
  const todayConcepts = filterRealConcepts(today.concepts);
  const priorConcepts = prior?.concepts ? filterRealConcepts(prior.concepts) : null;

  const conceptRot = computeBoardRotation(todayConcepts, priorConcepts);
  const industryRot = computeBoardRotation(today.industries, prior?.industries ?? null);

  // 漲幅/主力視窗：merge 回補歷史（board-history.json）+ 近 20 交易日板塊快照（升冪，快照同日為準）
  const history = await loadBoardHistory();
  const winStart = idx >= 0 ? Math.max(0, idx - 20) : 0;
  const winDates = idx >= 0 ? dates.slice(winStart, idx + 1) : [date];
  const winFiles = await Promise.all(winDates.map((d) => (d === date ? Promise.resolve(today) : readBoardsDay(d))));
  const conceptDated = winDates.map((d, i) => ({ date: d, boards: winFiles[i]?.concepts ?? null }));
  const industryDated = winDates.map((d, i) => ({ date: d, boards: winFiles[i]?.industries ?? null }));
  const conceptWin = computeBoardWindows(conceptDated, history);
  const industryWin = computeBoardWindows(industryDated, history);

  return {
    date,
    priorDate: prior ? priorDate : null,
    snapshotUpdatedAt: today.fetchedAt,
    generatedAt: new Date().toISOString(),
    concepts: enrich(todayConcepts, conceptRot, conceptWin),
    industries: enrich(today.industries, industryRot, industryWin),
  };
}

/** 最新有 boards 檔的那日排行；完全無資料 → null。 */
export async function buildLatestCnBoardRanking(): Promise<CnBoardRankingFile | null> {
  const dates = await listBoardsDates();
  if (dates.length === 0) return null;
  return buildCnBoardRanking(dates[dates.length - 1]);
}
