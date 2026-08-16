'use client';

// 三色資金（陸股自創策略）掃描側欄 — 首頁右側 panel 版。
// 與 /cn-sanse 頁共用同一支 /api/cn-sanse/scan + scanStorage；這裡只負責「掃描清單」，
// 走圖交給首頁主圖 Tab（點卡片 → onSelectStock 帶 symbol/date/chartTab）。
//
// 三策略（嚴格/中等/寬鬆）各自獨立：點哪個 pill 只顯示該 level 命中清單，互不混合。
// 多策略徽章：同一股若同時命中多個 level，卡片標示「嚴/中/寬」高亮。

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { RefreshCw } from 'lucide-react';
import { ForwardPerfRow } from './ForwardPerfRow';
import { useWatchlistStore } from '@/store/watchlistStore';
import type { SelectedStock } from './ScanChartPanel';
import type { StockForwardPerformance } from '@/lib/scanner/types';
import { STAGE_LABEL, STAGE_ICON, COMBO_LABEL, COMBO_HINT, type ConditionReport, type ComboGrade } from '@/lib/cn-sanse/conditions';
import { matchedStrategies, getStrategy, type SanSeScanLevel } from '@/lib/cn-sanse/namedStrategies';
import { buyScore } from '@/lib/cn-sanse/buyScore';
import { CnBoardBadge } from '@/components/shared/CnBoardBadge';
import type { ThemeRef } from '@/lib/theme-sanse/types';
import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { useYouTubeMentionMap } from '@/lib/hooks/useYouTubeMentionMap';
import { YouTubeMentionBadge, resonanceTags } from '@/components/youtube/YouTubeMentionBadge';
import { SortControl } from '@/components/shared';
import { ThemeTag } from '@/components/ThemeTag';
import { applySort, type SortValue } from '@/lib/sorting/sortEngine';
import { UNIVERSAL_SORT_OPTIONS, type SortDir } from '@/lib/sorting/registry';
import { DatePicker } from '@/components/ui/DatePicker';

type ScanLevel = 'strict' | 'medium' | 'loose';       // 後端 results 的三個 level
type Level = SanSeScanLevel;                            // 嚴/中/寬 + 具名策略 id（底反/全共振/紅+黃+觸發/紅+雙B…）；策略 = 從 records 衍生

/** 三色盤中即時掃描活躍時段 = 該市場開盤 或 盤後窗口。TW + CN 共用同一判斷。 */
function isIntradayActive(market: 'TW' | 'CN'): boolean {
  return isMarketOpen(market) || isPostCloseWindow(market);
}

interface Hit {
  symbol: string; name: string; industry: string; price: number; changePct: number;
  shortAttack: number; midStrength: number; midControl: number; kongPan: number;
  shortOversold?: number; // 短線超跌（舊固化資料可能沒有此欄 → undefined）
  turnoverRank?: number;  // 當日成交額名次（1=最大；舊固化資料無此欄）
}
interface RecordRow {
  symbol: string; name?: string; industry?: string; price?: number; changePct?: number; turnoverRank?: number;
  report: ConditionReport;
  /** 朱六條件確認（core=前5核心全過；台股交集回測有效、陸股僅參考；舊固化無此欄）。 */
  zhuSix?: { core: boolean; total: number };
}
interface ScanResp {
  ok: boolean; lastDate: string; evaluated: number; staleSkipped?: number;
  counts: Record<ScanLevel, number>; results: Record<ScanLevel, Hit[]>;
  records?: RecordRow[]; sessionType?: 'post_close' | 'intraday'; cached?: boolean; error?: string;
  turnoverCap?: number;       // 成交額粗篩上限（TW 500 / CN 800）
  turnoverFiltered?: number;  // 被粗篩剔除的冷門薄量股檔數
}

/** records 列 → 畫面 Hit（底反/具名策略衍生清單共用，避免欄位漂移）。 */
function recToHit(r: RecordRow): Hit {
  return {
    symbol: r.symbol, name: r.name ?? r.symbol, industry: r.industry ?? '',
    price: r.price ?? 0, changePct: r.changePct ?? 0,
    shortAttack: r.report.scores.shortAttack, midStrength: r.report.scores.midStrength,
    midControl: r.report.scores.midControl, kongPan: r.report.scores.kongPan,
    turnoverRank: r.turnoverRank,
  };
}

/** 使用順序評級 badge 配色（回測推導；強→弱）。*/
const COMBO_BADGE: Record<ComboGrade, string> = {
  top: 'bg-gradient-to-r from-rose-500/25 to-fuchsia-500/25 text-fuchsia-100 border-fuchsia-400/50',
  prime: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  mid: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  watch: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  weak: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/40',
};

/** 精簡 chip：使用順序評級 + 六條件確認 + 共振N/3 + 賣出警示。觸發明細(雙B/主力/捕撈)＋判讀收進 badge hover。*/
function CondChips({ rep, zhu, market }: { rep?: ConditionReport; zhu?: { core: boolean; total: number }; market?: 'TW' | 'CN' }) {
  if (!rep) return null;
  const trigs = [
    ...rep.doubleB.buy.filter((c) => c.kind === 'signal' && c.met).map((c) => '雙B ' + c.label),
    ...(rep.mainforce.buyHit && rep.mainStage ? ['主力' + STAGE_LABEL[rep.mainStage] + STAGE_ICON[rep.mainStage]] : []),
    ...rep.catch.buy.filter((c) => c.kind === 'signal' && c.met).map((c) => '捕撈 ' + c.label),
  ].join('、');
  const comboTitle = rep.combo ? `${COMBO_HINT[rep.combo.grade]}${trigs ? `\n觸發：${trigs}` : ''}` : '';
  return (
    <div className="flex flex-wrap items-center gap-1 mb-1 text-[9px]">
      {rep.combo && (
        <span className={cn('px-1 py-0.5 rounded border font-medium', COMBO_BADGE[rep.combo.grade])} title={comboTitle}>
          {COMBO_LABEL[rep.combo.grade]}{rep.combo.bottomReversal ? '·底部' : ''}
        </span>
      )}
      {zhu?.core && (
        <span
          className="px-1 py-0.5 rounded border bg-sky-500/15 text-sky-200 border-sky-400/40 font-medium"
          title={`朱六條件確認：核心5條全過（總分 ${zhu.total}/6）。${market === 'CN' ? '⚠️ 陸股交集回測無效，僅供參考' : '台股回測：六條件∩三色 5日 +0.31% 優於兩者單獨'}`}
        >
          六✓{zhu.total}
        </span>
      )}
      {rep.sellWarnings.length > 0 && <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">⚠️{rep.sellWarnings.join('、')}</span>}
    </div>
  );
}
interface DateEntry { date: string; counts: Record<ScanLevel, number>; scannedAt: string }

// 三色買進訊號篩選：分 3 組、每組照書本順序排。點哪個 chip 就要該訊號亮（多個 = AND）。
type FilterGroup = 'doubleB' | 'mainforce' | 'catch';
const FILTER_GROUPS: { group: FilterGroup; title: string; activeCls: string; conds: { id: string; label: string }[] }[] = [
  { group: 'doubleB', title: '🟦雙B', activeCls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', conds: [
    { id: 'b_break', label: '突破交易線' },
    { id: 'b_gold', label: '黃紅金叉' },
    { id: 'b_resonance', label: '雙B共振' },
  ] },
  { group: 'mainforce', title: '🟪主力', activeCls: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40', conds: [
    { id: 'm_short', label: '做短線(紅+紫)' },
    { id: 'm_mid', label: '做中線(紅+黃)' },
    { id: 'm_three', label: '三色戰法' },
  ] },
  { group: 'catch', title: '🟩捕撈', activeCls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', conds: [
    { id: 'c_gold_bear', label: '空頭區金叉' },
    { id: 'c_gold_bull', label: '多頭區金叉' },
    { id: 'c_gold_vol', label: '量價強勢' },
  ] },
];
// 使用順序評級篩選（回測推導；衍生自 report.combo）。
const COMBO_FILTERS: { id: string; label: string; tip: string }[] = [
  { id: 'cf_top', label: '最稀有⭐', tip: '只看三組齊發（雙B＋主力＋捕撈 三組都出＝共振3/3）：台股短線期望值最高但很稀有(一天個位數)；平時看「主進場」級就夠、機會多，陸股牛市那段 3/3 反而輸大盤' },
  { id: 'cf_redGate', label: '紅當前提', tip: '只看紅色(中線機構)在場的＝勝出順序的前提（過濾掉純紫/純指標的低勝率組）' },
  { id: 'cf_prime', label: '主進場', tip: '只看「紅當前提＋觸發」與「三組齊發」（評級 prime/top）' },
  { id: 'cf_bottom', label: '底部反彈', tip: '只看捕撈 0 軸下空頭區金叉（底部反彈，回測勝率較高）' },
];
function passFilters(report: ConditionReport | undefined, active: Set<string>): boolean {
  if (active.size === 0) return true;
  if (!report) return false;
  if (active.has('hideConflict') && report.conflict) return false;
  // 趨勢＝相對多空線（季線 MA60）的位置：空頭=跌破、多頭=站上（與「0軸下空頭區金叉」的動能不同層次）
  if (active.has('trend_bear') && !report.doubleB.sell.some((c) => c.id === 'b_below' && c.met)) return false;
  if (active.has('trend_bull') && !report.doubleB.buy.some((c) => c.id === 'b_above' && c.met)) return false;
  if (active.has('cf_top') && report.combo?.grade !== 'top') return false;
  if (active.has('cf_redGate') && !report.combo?.redGate) return false;
  if (active.has('cf_prime') && !(report.combo?.grade === 'top' || report.combo?.grade === 'prime')) return false;
  if (active.has('cf_bottom') && !report.combo?.bottomReversal) return false;
  for (const { group, conds } of FILTER_GROUPS) {
    for (const c of conds) {
      if (active.has(c.id) && !report[group].buy.some((x) => x.id === c.id && x.met)) return false;
    }
  }
  return true;
}

/**
 * 最應該買進排序分數（回測推導的使用順序）：
 * 評級 grade 為主軸（top>prime>mid>watch>weak，每級差 100），同級再比共振組數(×10)、
 * 有賣出警示降一點、捕撈底部反彈加一點、最後用短攻做不跨級的細排。缺 combo（舊固化）回 -1 排最後。
 */
// buyScore 抽至 lib/cn-sanse/buyScore.ts（2026-06-12 單一事實 — 今日最優先卡/paper-trade 共用）

const stripSuffix = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
/** 該股所屬「最熱題材」的名次（1=最熱）；不在任何排名題材 → Infinity（排最後）。 */
function bestHeatRank(themeHeatMap: Map<string, ThemeRef[]>, symbol: string): number {
  const refs = themeHeatMap.get(stripSuffix(symbol)); // 已按 heatRank 升冪
  return refs && refs.length > 0 ? refs[0].heatRank : Infinity;
}

// 排序值取法（id 走 lib/sorting/registry 中央清單；缺值/升降序由 sortEngine 統一處理）。
// 畫面清單 + 漲幅抓取目標共用 accessor，確保顯示的股票就是有抓漲幅的股票。
function sanseSortValue(
  h: Hit,
  id: string,
  perf: Record<string, StockForwardPerformance>,
  reportMap: Map<string, ConditionReport>,
  themeHeatMap: Map<string, ThemeRef[]>,
): SortValue {
  const fwdField = FWD_FIELD[id];
  if (fwdField) {
    return (perf[h.symbol]?.[fwdField] as number | null | undefined) ?? null;
  }
  switch (id) {
    case 'score.sanseCombo': {
      // 既有 buyScore 綜合分；< 0（舊固化無 combo）視為缺值排最後
      const s = buyScore(reportMap.get(h.symbol));
      return s < 0 ? null : s;
    }
    case 'heat.theme': {
      // 所屬最熱題材名次（低名次=更熱）→ 取負，desc 時最熱排前；無題材回 null 排最後
      const rank = bestHeatRank(themeHeatMap, h.symbol);
      return rank === Infinity ? null : -rank;
    }
    case 'mkt.turnover':
      return -(h.turnoverRank ?? 999_999); // rank 1 = 最大 → 取負，desc 時排最前
    case 'sanse.shortAttack':  return h.shortAttack ?? 0;
    case 'sanse.midStrength':  return h.midStrength ?? 0;
    case 'sanse.midControl':   return h.midControl ?? 0;
    case 'sanse.shortOversold': return h.shortOversold ?? 0;
    case 'mkt.change':         return h.changePct ?? 0;
    case 'mkt.price':          return h.price ?? 0;
    default: return null;
  }
}

const LEVELS: { key: Level; label: string; desc: string }[] = [
  { key: 'strict', label: '嚴格', desc: '三色資金共振 — 短攻>2.8 + 中強>3.9 + 金叉/牛熊線/控盤>80 全到位' },
  { key: 'medium', label: '中等', desc: '更新版 — 短攻 / 中強 / 中控 三個分數都 > 0' },
  { key: 'loose', label: '寬鬆', desc: '游資資金翻正 — 短線動能今天剛由負轉正' },
  { key: 'reversal', label: '底反', desc: '底反該買 — 該買(紅機構在場＋雙B/捕撈觸發) ＋ 捕撈0軸下空頭區金叉；回測兩市場 OOS 最高把握' },
  // 具名策略（從 records 衍生、全市場命中；由工具列「三色(全共振⭐)…」按鈕經 level 驅動）
  { key: 'resonance', label: '全共振⭐', desc: '🔴🟣🟡三燈全亮 ＋ 雙B金叉 ＋ 捕撈金叉 同日（三組齊發，回測漲幅最大但稀有）' },
  { key: 'red_yellow_trigger', label: '紅+黃+觸發', desc: '🔴紅 ＋ 🟡黃 中線骨架 ＋ 一個觸發（雙B金叉/突破 或 捕撈金叉）' },
  { key: 'red_dualb_gold', label: '紅+雙B金叉', desc: '🔴紅在場 ＋ 黃線穿紅線（只認金叉、較乾淨）' },
  { key: 'red_dualb_any', label: '紅+雙B金叉/突破', desc: '🔴紅在場 ＋（黃紅金叉 或 收盤突破智能交易線）' },
];

const fmt = (n: number | undefined) => (n != null && Number.isFinite(n) ? n.toFixed(2) : '—');

// 此面板提供的排序選項（id 走 lib/sorting/registry 中央清單）：
// 該頁專屬（應買/三色細項/今日熱點）+ '|' 分隔線 + 共用區（全 UNIVERSAL_SORT_OPTIONS）。
const SANSE_SORT_OPTIONS = [
  'score.sanseCombo', 'sanse.shortAttack', 'sanse.midStrength', 'sanse.midControl', 'sanse.shortOversold', 'heat.theme',
  '|', ...UNIVERSAL_SORT_OPTIONS,
];

const FWD_FIELD: Record<string, keyof StockForwardPerformance> = {
  'fwd.open': 'openReturn', 'fwd.d1': 'd1Return', 'fwd.d5': 'd5Return',
  'fwd.d10': 'd10Return', 'fwd.d20': 'd20Return', 'fwd.maxGain': 'maxGain', 'fwd.maxLoss': 'maxLoss',
};

interface Props {
  onSelectStock?: (stock: SelectedStock) => void;
  /** 高亮目前主圖選中的代號（含或不含後綴皆可）*/
  selectedSymbol?: string | null;
  /** 由外部（工具列「三色(嚴格/中等/寬鬆)」按鈕）控制的 level；給定時隱藏內建 pill 列 */
  level?: Level;
  /** 市場：CN（預設，走 /api/cn-sanse）或 TW（走 /api/tw-sanse，無盤中即時）*/
  market?: 'TW' | 'CN';
}

export function SanSeScanCompact({ onSelectStock, selectedSymbol, level: controlledLevel, market = 'CN' }: Props) {
  const apiBase = market === 'TW' ? '/api/tw-sanse' : '/api/cn-sanse';
  const [data, setData] = useState<ScanResp | null>(null);
  const [dates, setDates] = useState<DateEntry[]>([]);
  const [session, setSession] = useState<'post_close' | 'intraday'>('post_close');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [internalLevel, setInternalLevel] = useState<Level>('medium');
  const level = controlledLevel ?? internalLevel;
  const [perf, setPerf] = useState<Record<string, StockForwardPerformance>>({});
  const [perfLoading, setPerfLoading] = useState(false);
  // 排序：預設「應買」(使用順序評級綜合分)高→低，最該買進的在最前；點同鍵切換高低
  const [sortKey, setSortKey] = useState<string>('score.sanseCombo');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // 裸碼 → 所屬熱門題材 refs（「🔥今日熱點」排序 + 卡片題材標籤用）；只在 lastDate 變時抓一次
  const [themeHeatMap, setThemeHeatMap] = useState<Map<string, ThemeRef[]>>(new Map());
  // 三色買進訊號篩選（cond id 集合；含 'hideConflict'）
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const toggleFilter = (k: string) => setFilters((prev) => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  // 近 7 天有 YouTube 提及（只台股；display-layer 篩選，切市場時重置）
  const [ytRecentOnly, setYtRecentOnly] = useState(false);

  // 切市場（apiBase 變）時，舊市場的 in-flight fetch 後到不可覆蓋新市場資料 → 用 ref 守門。
  const liveBaseRef = useRef(apiBase);

  // session='intraday' → 讀盤中即時快照（latest live，忽略 date）；否則讀盤後封存。
  const loadDate = useCallback(async (date?: string, sessionArg?: 'post_close' | 'intraday') => {
    const sess = sessionArg ?? session;
    const myBase = apiBase;
    setLoading(true); setErr(null);
    try {
      const url = sess === 'intraday'
        ? `${apiBase}/scan?session=intraday`
        : `${apiBase}/scan${date ? `?date=${date}` : ''}`;
      const r = await fetch(url);
      const j: ScanResp = await r.json();
      if (liveBaseRef.current !== myBase) return; // 已切到別的市場 → 丟棄這次結果
      if (!j.ok) throw new Error(j.error || (sess === 'intraday' ? '尚無盤中即時快照' : '讀取失敗'));
      setData(j);
    } catch (e) {
      if (liveBaseRef.current !== myBase) return;
      setErr(e instanceof Error ? e.message : '讀取失敗');
    } finally { if (liveBaseRef.current === myBase) setLoading(false); }
  }, [session, apiBase]);

  const switchSession = useCallback((s: 'post_close' | 'intraday') => {
    setSession(s);
    loadDate(undefined, s);
  }, [loadDate]);

  const loadDates = useCallback(async () => {
    const myBase = apiBase;
    try {
      const r = await fetch(`${apiBase}/scan/dates`);
      const j = await r.json();
      if (liveBaseRef.current === myBase && j.ok) setDates(j.dates ?? []);
    } catch { /* 日期列載不到不致命 */ }
  }, [apiBase]);

  const rescan = useCallback(async () => {
    const myBase = apiBase;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`${apiBase}/scan?force=1`);
      const j: ScanResp = await r.json();
      if (liveBaseRef.current !== myBase) return;
      if (!j.ok) throw new Error(j.error || '掃描失敗');
      setData(j);
      loadDates();
    } catch (e) {
      if (liveBaseRef.current !== myBase) return;
      setErr(e instanceof Error ? e.message : '掃描失敗');
    } finally { if (liveBaseRef.current === myBase) setLoading(false); }
  }, [loadDates, apiBase]);

  // 收盤後決策：今天盤後已固化 → 顯示盤後；今天盤後還沒生（lastDate 落後今天盤中，例如指數 16:39
  // 才封、盤後掃描要等 16:45）但今天盤中快照在 → 顯示今天的盤中、不退回昨天的盤後。
  // 等今天盤後一固化（lastDate 追平今天盤中）下次載入/重整自動切回盤後。
  const loadAfterClose = useCallback(async () => {
    const myBase = apiBase;
    setLoading(true); setErr(null);
    try {
      const [pcR, idR] = await Promise.all([
        fetch(`${apiBase}/scan`).then((r) => r.json()).catch(() => null),
        fetch(`${apiBase}/scan?session=intraday`).then((r) => r.json()).catch(() => null),
      ]);
      if (liveBaseRef.current !== myBase) return;
      const pc = pcR as ScanResp | null;
      const id = idR as ScanResp | null;
      // 今天盤中比盤後新（= 今天盤後還沒固化）→ 顯示今天盤中；否則盤後封存
      const preferIntraday = !!(id?.ok && (!pc?.ok || id.lastDate > pc.lastDate));
      if (preferIntraday && id) { setSession('intraday'); setData(id); }
      else if (pc?.ok) { setSession('post_close'); setData(pc); }
      else throw new Error(pc?.error || id?.error || '讀取失敗');
    } catch (e) {
      if (liveBaseRef.current !== myBase) return;
      setErr(e instanceof Error ? e.message : '讀取失敗');
    } finally { if (liveBaseRef.current === myBase) setLoading(false); }
  }, [apiBase]);

  // 進場：盤中活躍時段預設即時，否則交給 loadAfterClose（在 effect 內判斷避免 SSR/CSR hydration 不一致）
  useEffect(() => {
    liveBaseRef.current = apiBase; // 標記目前市場 → 舊市場 in-flight fetch 自我作廢
    setData(null); setDates([]); setPerf({}); setYtRecentOnly(false); setThemeHeatMap(new Map()); // 清掉前一市場殘留，避免短暫顯示錯市場
    loadDates();
    // 盤中/盤後窗口 → 即時；收盤後 → loadAfterClose（今天盤後沒生就顯示今天盤中，不退回昨天）
    if (isIntradayActive(market)) {
      setSession('intraday');
      loadDate(undefined, 'intraday');
    } else {
      loadAfterClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const onRefresh = useCallback(() => {
    if (session === 'intraday') loadDate(undefined, 'intraday'); // 重抓即時快照
    else rescan();                                               // 盤後即時重掃並固化
  }, [session, loadDate, rescan]);

  // 各 level 命中代號集合 → 用來算「多策略徽章」
  const levelSets = useMemo(() => ({
    strict: new Set((data?.results.strict ?? []).map((h) => h.symbol)),
    medium: new Set((data?.results.medium ?? []).map((h) => h.symbol)),
    loose: new Set((data?.results.loose ?? []).map((h) => h.symbol)),
  }), [data]);

  // symbol → 三色條件報告（雙B/主力/捕撈）
  const reportMap = useMemo(
    () => new Map((data?.records ?? []).map((r) => [r.symbol, r.report])),
    [data],
  );
  // symbol → 朱六條件確認（舊固化無此欄 → 不在 map；篩選時視為不過）
  const zhuMap = useMemo(
    () => new Map((data?.records ?? []).filter((r) => r.zhuSix).map((r) => [r.symbol, r.zhuSix!])),
    [data],
  );
  // 「∩六條件」篩選謂詞（display-layer；未開啟時全過）
  const passZhu = (h: Hit) => !filters.has('zhu_core') || zhuMap.get(h.symbol)?.core === true;

  /**
   * 當前 level 的來源清單：
   *  - 具名策略（底反/全共振/紅+黃+觸發/紅+雙B…）→ 從 records 衍生、全市場命中（不受嚴/中/寬主力閘限制，
   *    舊固化資料只要有 combo 就能算 → 免重跑 backfill）。
   *  - 嚴/中/寬 → 走後端 results[level]。
   */
  const levelRows = useMemo<Hit[]>(() => {
    const s = getStrategy(level);
    if (s) return (data?.records ?? []).filter((r) => s.match(r.report)).map(recToHit);
    return data?.results[level as ScanLevel] ?? [];
  }, [data, level]);
  const countFor = (k: Level): number | undefined => {
    const s = getStrategy(k);
    if (s) return (data?.records ?? []).filter((r) => s.match(r.report)).length;
    return data?.counts[k as ScanLevel];
  };

  // YouTube 提及（純展示 join）— 只台股有對應；陸股代號不重疊，傳 undefined 不發請求
  const { map: ytMap } = useYouTubeMentionMap(market === 'TW' ? data?.lastDate : undefined);
  const bare = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // 「近 7 天有 YouTube 提及」篩選謂詞（display-layer；ytRecentOnly 關閉時全過）
  const passYt = (h: Hit) => !ytRecentOnly || (ytMap.get(bare(h.symbol))?.count7d ?? 0) > 0;

  // 漲幅要抓「畫面實際會顯示的那 50 檔」(濾鏡+排序後)，否則改排序/濾鏡後顯示的股票沒抓到漲幅 → 空白。
  // 排序鍵用 perf-independent 版（依 fwd 漲幅排序本身需要 perf，退回 combo 序當抓取依據，避免循環依賴）。
  const fetchTargets = useMemo(() => {
    const rows = levelRows.filter((h) => passFilters(reportMap.get(h.symbol), filters) && passYt(h) && passZhu(h));
    // 依 fwd 漲幅排序本身需要 perf（尚未抓到）→ 退回 combo 序當抓取依據，避免循環依賴
    const baseKey = FWD_FIELD[sortKey] ? 'score.sanseCombo' : sortKey;
    return applySort(rows, baseKey, sortDir, (h, id) => sanseSortValue(h, id, {}, reportMap, themeHeatMap)).slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelRows, sortKey, sortDir, filters, reportMap, zhuMap, ytMap, ytRecentOnly, themeHeatMap]);
  const fetchKey = fetchTargets.map((h) => h.symbol).join(',');

  // 績效追蹤（複用主頁 /api/backtest/forward，支援 .SS/.SZ）— 只抓「會顯示的那 50 檔」，排序/濾鏡變動跟著重抓
  useEffect(() => {
    if (!data || fetchTargets.length === 0) { setPerf({}); return; }
    let alive = true;
    setPerfLoading(true);
    fetch('/api/backtest/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scanDate: data.lastDate,
        stocks: fetchTargets.map((h) => ({ symbol: h.symbol, name: h.name, scanPrice: h.price })),
      }),
    })
      .then((r) => r.json())
      .then((j: { performance?: StockForwardPerformance[] }) => {
        if (!alive) return;
        const m: Record<string, StockForwardPerformance> = {};
        for (const p of j.performance ?? []) m[p.symbol] = p;
        setPerf(m);
      })
      .catch(() => { /* 績效取不到不致命 */ })
      .finally(() => { if (alive) setPerfLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.lastDate, fetchKey]);

  // 題材熱度（「🔥今日熱點」排序 + 卡片標籤）— 只在封存日變時抓一次（非每次盤中輪詢）
  useEffect(() => {
    const d = data?.lastDate;
    if (!d) { setThemeHeatMap(new Map()); return; }
    let alive = true;
    const myBase = apiBase;
    fetch(`/api/theme-sanse/hot?market=${market}&date=${d}`)
      .then((r) => r.json())
      .then((j: { ok?: boolean; byCode?: Record<string, ThemeRef[]> }) => {
        if (!alive || liveBaseRef.current !== myBase) return; // 切市場後到的舊回應丟棄
        setThemeHeatMap(j.ok && j.byCode ? new Map(Object.entries(j.byCode)) : new Map());
      })
      .catch(() => { /* 熱度取不到不致命 — 排序退回無題材 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.lastDate, market]);

  const hits = useMemo(() => {
    const rows = levelRows.filter((h) => passFilters(reportMap.get(h.symbol), filters) && passYt(h) && passZhu(h));
    return applySort(rows, sortKey, sortDir, (h, id) => sanseSortValue(h, id, perf, reportMap, themeHeatMap)).slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelRows, sortKey, sortDir, perf, filters, reportMap, zhuMap, ytMap, ytRecentOnly, themeHeatMap]);
  const pureSelected = selectedSymbol?.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  return (
    <div className="flex flex-col min-h-0 h-full text-foreground text-xs">
      {/* 標題列 + 重掃 */}
      <div className="shrink-0 flex items-center justify-between gap-1 px-2.5 py-1.5 border-b border-border bg-card/40">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-semibold text-fuchsia-300 shrink-0">🎨 三色資金</span>
          <span className="text-[10px] text-muted-foreground truncate">
            {data ? `${data.lastDate}｜掃 ${data.evaluated} 檔${data.turnoverCap ? (data.turnoverCap >= 10000 ? '（全市場）' : `（成交額前 ${data.turnoverCap}）`) : ''}${session === 'intraday' ? ' · 盤中跳動' : ''}` : `${market === 'TW' ? '台股' : '陸股 A 股'}自創策略`}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* 盤後 / 盤中 切換（TW + CN 皆有） */}
          <div className="flex rounded border border-border overflow-hidden text-[9px]">
            <button
              onClick={() => switchSession('post_close')}
              disabled={loading}
              className={cn('px-1.5 py-0.5', session === 'post_close' ? 'bg-sky-600 text-sky-50' : 'text-muted-foreground hover:bg-secondary')}
              title="盤後封存（收盤定調，訊號穩定）"
            >盤後</button>
            <button
              onClick={() => switchSession('intraday')}
              disabled={loading}
              className={cn('px-1.5 py-0.5', session === 'intraday' ? 'bg-rose-600 text-rose-50' : 'text-muted-foreground hover:bg-secondary')}
              title="盤中即時：當下報價合成未收日K 重算；量能半根、訊號會跳動，收盤前才定調"
            >盤中</button>
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            title={session === 'intraday' ? '重抓盤中即時快照' : '即時重新掃描並固化當日'}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* 日期 chip 列 */}
      {dates.length > 0 && (
        <div className="shrink-0 px-2 py-1.5 border-b border-border bg-card/40">
          <DatePicker
            value={data?.lastDate ?? ''}
            onChange={(nextDate) => {
              if (loading) return;
              setSession('post_close');
              loadDate(nextDate, 'post_close');
            }}
            dates={dates.map(d => d.date)}
            meta={Object.fromEntries(dates.map(d => [d.date, { count: d.counts.medium }]))}
            size="sm"
            disabled={loading}
            ariaLabel="三色資金歷史日期"
          />
        </div>
      )}

      {/* 嚴格 / 中等 / 寬鬆 — 內建切換（受控時隱藏：改由工具列「三色」按鈕控制）*/}
      <div className="shrink-0 p-2 border-b border-border">
        {!controlledLevel && (
          <div className="flex gap-1">
            {LEVELS.map((l) => (
              <button
                key={l.key}
                onClick={() => setInternalLevel(l.key)}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors border',
                  level === l.key ? 'bg-sky-500/15 text-sky-400 border-sky-500/40' : 'text-muted-foreground border-transparent hover:bg-secondary',
                )}
              >
                {l.label}<span className="ml-1 opacity-70">{countFor(l.key) ?? '–'}</span>
              </button>
            ))}
          </div>
        )}
        <p className={cn('text-[11px] leading-snug text-muted-foreground', !controlledLevel && 'mt-1.5')}>
          {controlledLevel && <span className="font-semibold text-fuchsia-300 mr-1">{LEVELS.find((l) => l.key === level)?.label}（{countFor(level) ?? '–'}）·</span>}
          {LEVELS.find((l) => l.key === level)?.desc}
        </p>
      </div>

      {/* 排序 pills（點同鍵切換高/低）— 共用 SortControl + 中央排序清單 */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border flex flex-wrap gap-1 items-center">
        <SortControl
          options={SANSE_SORT_OPTIONS}
          value={sortKey}
          dir={sortDir}
          onChange={(id, d) => { setSortKey(id); setSortDir(d); }}
        />
        {sortKey === 'heat.theme' && (
          <span className="basis-full text-[9px] leading-snug mt-0.5 text-amber-400/90">
            {market === 'TW'
              ? '🔥 三色票按今日最熱題材排序。回測：最熱題材那段報酬約是後段 2 倍（台股有效）。'
              : '⚠ 陸股回測顯示這樣排「反而把較差的排前面」（最熱題材那段報酬最差）— 不建議用此排序選股，僅供觀察。'}
          </span>
        )}
      </div>

      {/* 三色買進訊號篩選：分 3 組、每組照書本順序；多個 chip = AND（同時滿足）*/}
      <div className="shrink-0 px-2 py-1.5 border-b border-border space-y-1">
        {FILTER_GROUPS.map(({ group, title, activeCls, conds }) => (
          <div key={group} className="flex items-center gap-1 flex-wrap">
            <span className="text-[9px] text-muted-foreground w-9 shrink-0">{title}</span>
            {conds.map((c) => (
              <button
                key={c.id}
                onClick={() => toggleFilter(c.id)}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
                  filters.has(c.id) ? activeCls : 'text-muted-foreground border-border hover:bg-secondary',
                )}
              >{c.label}</button>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[9px] text-muted-foreground w-9 shrink-0" title="使用順序評級（回測推導 data/sanse-combo-playbook.md）">🔢順序</span>
          {COMBO_FILTERS.map((c) => (
            <button
              key={c.id}
              onClick={() => toggleFilter(c.id)}
              title={c.tip}
              className={cn(
                'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
                filters.has(c.id) ? 'bg-rose-500/15 text-rose-200 border-rose-400/40' : 'text-muted-foreground border-border hover:bg-secondary',
              )}
            >{c.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[9px] text-muted-foreground w-9 shrink-0">其他</span>
          <button
            onClick={() => toggleFilter('hideConflict')}
            className={cn(
              'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
              filters.has('hideConflict') ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'text-muted-foreground border-border hover:bg-secondary',
            )}
          >隱藏衝突</button>
          <button
            onClick={() => toggleFilter('trend_bull')}
            title="只看站上多空線（季線 MA60）的股票 — 大趨勢仍多頭、屬多頭中的回檔底反；跌破多空線的會被濾掉"
            className={cn(
              'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
              filters.has('trend_bull') ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'text-muted-foreground border-border hover:bg-secondary',
            )}
          >多頭趨勢</button>
          <button
            onClick={() => toggleFilter('trend_bear')}
            title="只看跌破多空線（季線 MA60）的股票 — 大趨勢仍空頭、屬空頭中的底部反彈；站上多空線的回檔買點會被濾掉"
            className={cn(
              'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
              filters.has('trend_bear') ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'text-muted-foreground border-border hover:bg-secondary',
            )}
          >空頭趨勢</button>
          <button
            onClick={() => toggleFilter('zhu_core')}
            title={`只看「朱六條件核心5條全過」的股票（交集確認）。${market === 'CN' ? '⚠️ 陸股交集回測無效，僅供參考' : '台股回測：六條件∩三色紅+觸發 5日 +0.31%，優於兩者單獨'}`}
            className={cn(
              'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
              filters.has('zhu_core') ? 'bg-sky-500/15 text-sky-200 border-sky-400/40' : 'text-muted-foreground border-border hover:bg-secondary',
            )}
          >∩六條件</button>
          {market === 'TW' && (
            <button
              onClick={() => setYtRecentOnly((v) => !v)}
              title="只看近 7 天有被 YouTube 理財節目提到的股票"
              className={cn(
                'px-1.5 py-0.5 rounded text-[9px] border transition-colors',
                ytRecentOnly ? 'bg-purple-500/20 text-purple-200 border-purple-400/40' : 'text-muted-foreground border-border hover:bg-secondary',
              )}
            >近7天提及</button>
          )}
          {(filters.size > 0 || ytRecentOnly) && (
            <button onClick={() => { setFilters(new Set()); setYtRecentOnly(false); }} className="px-1.5 py-0.5 rounded text-[9px] border border-border text-muted-foreground hover:bg-secondary">清除</button>
          )}
        </div>
      </div>

      {/* 結果清單（卡片排版對齊書本買法 ScanResultsCompact）*/}
      <div className="flex-1 overflow-auto space-y-1.5 px-2 py-1.5">
        {err && <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>}
        {loading && !data && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
        {data && hits.length === 0 && !loading && <div className="p-4 text-sm text-muted-foreground">此策略該日無命中。</div>}
        {hits.map((h) => {
          const ticker = h.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const isSel = pureSelected && ticker === pureSelected;
          const inWatch = useWatchlistStore.getState().has(h.symbol);
          const ytSummary = ytMap.get(ticker);
          const ytResonance = resonanceTags(ytSummary);
          const rep = reportMap.get(h.symbol);
          // 精簡：原始分數 + 命中嚴/中/寬 收進卡片 hover（不佔版面）
          const lvHit = (['strict', 'medium', 'loose'] as ScanLevel[])
            .filter((lv) => levelSets[lv].has(h.symbol)).map((lv) => LEVELS.find((l) => l.key === lv)?.label).join('/');
          const stratHit = matchedStrategies(rep).map((s) => s.label).join('、');
          const detailTitle = `短攻 ${fmt(h.shortAttack)}｜中強 ${fmt(h.midStrength)}｜中控 ${fmt(h.midControl)}｜超短跌 ${fmt(h.shortOversold)}`
            + (rep ? `\n共振 ${rep.groupBuyCount}/3（雙B/主力/捕撈 中幾組）` : '')
            + (stratHit ? `\n命中型態：${stratHit}` : '')
            + (lvHit ? `\n命中策略：${lvHit}` : '');
          return (
            <div
              key={h.symbol}
              title={detailTitle}
              onClick={() => onSelectStock?.({
                symbol: h.symbol, name: h.name, market,
                date: data!.lastDate, chartTab: 'shuangb',
              })}
              className={cn(
                'rounded-lg border px-2.5 py-2 cursor-pointer transition-colors',
                isSel ? 'bg-secondary/60 border-fuchsia-700/50' : 'bg-card border-border/60 hover:bg-secondary/40',
              )}
            >
              {/* Row 1: 名稱 + 代號 + 漲跌%（名稱在前、股號在後；名稱不截斷，過長自動換行確保看到完整名稱）*/}
              <div className="flex items-baseline gap-1.5 mb-1">
                <div className="flex items-baseline gap-1.5 flex-wrap flex-1 min-w-0">
                  <span className="text-[11px] font-medium text-foreground/90 leading-tight break-words">{h.name}</span>
                  <CnBoardBadge symbol={h.symbol} />
                  <span className="font-mono text-[10px] text-muted-foreground">{ticker}</span>
                </div>
                <span className={cn('font-mono text-[11px] font-bold shrink-0', h.changePct >= 0 ? 'text-bull' : 'text-bear')}>
                  {h.changePct >= 0 ? '+' : ''}{fmt(h.changePct)}%
                </span>
              </div>

              {/* Row 2: 股價 + 產業 + YouTube 提及 + 成交量名次（三色分數收進卡片 hover）*/}
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                <span className="font-mono">{fmt(h.price)}</span>
                {h.industry && <span className="truncate max-w-[72px]">{h.industry}</span>}
                <ThemeTag market={market} code={bare(h.symbol)} hotMap={themeHeatMap} className="max-w-[120px]" />
                {(ytSummary || h.turnoverRank !== undefined) && (
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    {ytResonance[0] && (
                      <span
                        title={ytResonance[0].title}
                        className={`text-[8px] px-1 h-3.5 flex items-center rounded-sm border ${ytResonance[0].cls}`}
                      >
                        {ytResonance[0].label}
                      </span>
                    )}
                    {ytSummary && <YouTubeMentionBadge summary={ytSummary} bareCode={ticker} size="xs" />}
                    {h.turnoverRank !== undefined && (
                      <span
                        className="text-[9px] font-mono text-amber-400/80 bg-amber-900/20 px-1 py-px rounded"
                        title={data?.turnoverCap && data.turnoverCap < 10000 ? `當日成交額排名（全市場前 ${data.turnoverCap} 內）` : '當日成交額排名（全市場）'}
                      >
                        成交量第{h.turnoverRank}名
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Row 2.5: 使用順序評級 + 六條件確認 + 賣出警示（觸發/階段收進 badge hover）；判讀句只在選中卡顯示 */}
              <CondChips rep={rep} zhu={zhuMap.get(h.symbol)} market={market} />
              {isSel && rep?.combo && (
                <p className="text-[9px] leading-snug text-muted-foreground/90 mb-1">→ {COMBO_HINT[rep.combo.grade]}</p>
              )}

              {/* Row 3: 動作按鈕（命中嚴/中/寬 收進卡片 hover）*/}
              <div className="flex items-center gap-1 mb-1">
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStock?.({ symbol: h.symbol, name: h.name, market, date: data!.lastDate, chartTab: 'shuangb' });
                    }}
                    className="text-[9px] text-sky-400 hover:text-sky-300 px-1 py-0.5 rounded border border-sky-700/50 hover:bg-sky-900/30">
                    走圖
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      useWatchlistStore.getState().add(h.symbol, h.name, h.price);
                    }}
                    className="text-[9px] text-amber-400 hover:text-amber-300 px-1 py-0.5 rounded border border-amber-700/50 hover:bg-amber-900/30">
                    {inWatch ? '✓' : '+'}
                  </button>
                </div>
              </div>

              {/* Row 4: 掃描後表現追蹤 */}
              <ForwardPerfRow performance={perf[h.symbol]} isFetching={perfLoading} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
