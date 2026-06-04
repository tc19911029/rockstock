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
import { STAGE_LABEL, STAGE_ICON, COMBO_LABEL, COMBO_HINT, isReversalBuy, type ConditionReport, type ComboGrade } from '@/lib/cn-sanse/conditions';
import { isMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';
import { useYouTubeMentionMap } from '@/lib/hooks/useYouTubeMentionMap';
import { YouTubeMentionBadge, resonanceTags } from '@/components/youtube/YouTubeMentionBadge';

type ScanLevel = 'strict' | 'medium' | 'loose';       // 後端 results 的三個 level
type Level = ScanLevel | 'reversal';                   // UI 多一個「底反」= 從 records 衍生（非後端 level）

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
}
interface ScanResp {
  ok: boolean; lastDate: string; evaluated: number; staleSkipped?: number;
  counts: Record<ScanLevel, number>; results: Record<ScanLevel, Hit[]>;
  records?: RecordRow[]; sessionType?: 'post_close' | 'intraday'; cached?: boolean; error?: string;
  turnoverCap?: number;       // 成交額粗篩上限（TW 500 / CN 800）
  turnoverFiltered?: number;  // 被粗篩剔除的冷門薄量股檔數
}

/** 使用順序評級 badge 配色（回測推導；強→弱）。*/
const COMBO_BADGE: Record<ComboGrade, string> = {
  top: 'bg-gradient-to-r from-rose-500/25 to-fuchsia-500/25 text-fuchsia-100 border-fuchsia-400/50',
  prime: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  mid: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  watch: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  weak: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/40',
};

/** 精簡 chip：使用順序評級 + 共振N/3 + 賣出警示。觸發明細(雙B/主力/捕撈)＋判讀收進 badge hover。*/
function CondChips({ rep }: { rep?: ConditionReport }) {
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
function buyScore(rep?: ConditionReport): number {
  const c = rep?.combo;
  if (!c) return -1;
  let s = c.rank * 100 + (rep!.groupBuyCount ?? 0) * 10;
  if (rep!.conflict) s -= 5;
  if (c.bottomReversal) s += 1;
  const sa = rep!.scores?.shortAttack ?? 0;
  s += Math.min(Math.max(sa, 0), 99) / 100;
  return s;
}

/** 共用排序比較器（畫面清單 + 漲幅抓取目標共用，確保顯示的股票就是有抓漲幅的股票）。 */
function rowComparator(
  sortKey: SortKey,
  dir: number,
  perf: Record<string, StockForwardPerformance>,
  reportMap: Map<string, ConditionReport>,
) {
  const fwdField = FWD_FIELD[sortKey];
  return (a: Hit, b: Hit): number => {
    if (fwdField) {
      const va = perf[a.symbol]?.[fwdField];
      const vb = perf[b.symbol]?.[fwdField];
      if (va == null && vb == null) return 0;       // 缺值永遠排最後（不受 asc/desc 影響）
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir * ((vb as number) - (va as number));
    }
    if (sortKey === 'turnoverRank') {
      const ra = a.turnoverRank; const rb = b.turnoverRank;
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return dir * (ra - rb);
    }
    if (sortKey === 'combo') {
      const ra = buyScore(reportMap.get(a.symbol)); const rb = buyScore(reportMap.get(b.symbol));
      if (ra < 0 && rb < 0) return 0;
      if (ra < 0) return 1;
      if (rb < 0) return -1;
      if (ra === rb) return 0;
      return dir * (rb - ra);
    }
    const key = sortKey as 'shortAttack' | 'midStrength' | 'midControl' | 'shortOversold' | 'changePct' | 'price';
    return dir * ((b[key] ?? 0) - (a[key] ?? 0));
  };
}

const LEVELS: { key: Level; label: string; desc: string }[] = [
  { key: 'strict', label: '嚴格', desc: '三色資金共振 — 短攻>2.8 + 中強>3.9 + 金叉/牛熊線/控盤>80 全到位' },
  { key: 'medium', label: '中等', desc: '更新版 — 短攻 / 中強 / 中控 三個分數都 > 0' },
  { key: 'loose', label: '寬鬆', desc: '游資資金翻正 — 短線動能今天剛由負轉正' },
  { key: 'reversal', label: '底反', desc: '底反該買 — 該買(紅機構在場＋雙B/捕撈觸發) ＋ 捕撈0軸下空頭區金叉；回測兩市場 OOS 最高把握' },
];

const fmt = (n: number | undefined) => (n != null && Number.isFinite(n) ? n.toFixed(2) : '—');

type SortKey = 'combo' | 'shortAttack' | 'midStrength' | 'midControl' | 'shortOversold' | 'changePct' | 'price' | 'turnoverRank'
  | 'fwdOpen' | 'fwdD1' | 'fwdD5' | 'fwdD20' | 'fwdMaxGain' | 'fwdMaxLoss';

const SORT_PILLS: { key: SortKey; label: string; tip: string }[] = [
  { key: 'combo', label: '應買', tip: '最應該買進排序（回測推導）：三組齊發(3/3)>紅當前提+觸發>紅+黃中線>紅待觸發>無紅；同級再比共振組數/短攻，有賣出警示降級。⚠️三組齊發台股短線期望值最高但很稀有(一天個位數)，平時看「紅當前提+觸發」那級就夠用、機會多；陸股牛市那段 3/3 反而輸大盤' },
  { key: 'shortAttack', label: '短攻', tip: '短線上攻（游資資金）分數' },
  { key: 'midStrength', label: '中強', tip: '中線強勢（主力資金）分數' },
  { key: 'midControl', label: '中控', tip: '中線控盤（主力控盤）分數' },
  { key: 'shortOversold', label: '超短跌', tip: '短線超跌（跌破 MA20 後的超跌幅度）' },
  { key: 'changePct', label: '漲幅', tip: '掃描當日漲跌幅 %' },
  { key: 'price', label: '股價', tip: '當前股價' },
  { key: 'turnoverRank', label: '成交量', tip: '當日成交額排名（1=最大；缺值排最後）' },
  { key: 'fwdOpen', label: '漲跌·隔開', tip: '掃出後隔日開盤漲跌幅（缺值排最後）' },
  { key: 'fwdD1', label: '漲跌·1日', tip: '掃出後 1 日漲跌幅' },
  { key: 'fwdD5', label: '漲跌·5日', tip: '掃出後 5 日漲跌幅' },
  { key: 'fwdD20', label: '漲跌·20日', tip: '掃出後 20 日漲跌幅' },
  { key: 'fwdMaxGain', label: '漲跌·最高', tip: '掃出後 20 日內最大累計漲幅' },
  { key: 'fwdMaxLoss', label: '漲跌·最低', tip: '掃出後 20 日內最大累計跌幅' },
];

const FWD_FIELD: Partial<Record<SortKey, keyof StockForwardPerformance>> = {
  fwdOpen: 'openReturn', fwdD1: 'd1Return', fwdD5: 'd5Return',
  fwdD20: 'd20Return', fwdMaxGain: 'maxGain', fwdMaxLoss: 'maxLoss',
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
  const [sortKey, setSortKey] = useState<SortKey>('combo');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
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

  // 進場：盤中活躍時段預設即時，否則盤後（在 effect 內判斷避免 SSR/CSR hydration 不一致）
  useEffect(() => {
    liveBaseRef.current = apiBase; // 標記目前市場 → 舊市場 in-flight fetch 自我作廢
    setData(null); setDates([]); setPerf({}); setYtRecentOnly(false); // 清掉前一市場殘留，避免短暫顯示錯市場
    loadDates();
    // TW + CN 皆依該市場時段決定：盤中/盤後窗口 → 即時，否則盤後封存
    const initial = isIntradayActive(market) ? 'intraday' : 'post_close';
    setSession(initial);
    loadDate(undefined, initial);
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

  // 「底反」非後端 level — 從 records 衍生：grade top/prime ＋ 捕撈0軸下空頭區金叉 ＋ 無出場（isReversalBuy）。
  // 完整涵蓋底反該買（不受嚴/中/寬主力閘限制），舊固化資料只要有 combo 就能算 → 免重跑 backfill。
  const reversalRows = useMemo<Hit[]>(() =>
    (data?.records ?? [])
      .filter((r) => isReversalBuy(r.report))
      .map((r) => ({
        symbol: r.symbol, name: r.name ?? r.symbol, industry: r.industry ?? '',
        price: r.price ?? 0, changePct: r.changePct ?? 0,
        shortAttack: r.report.scores.shortAttack, midStrength: r.report.scores.midStrength,
        midControl: r.report.scores.midControl, kongPan: r.report.scores.kongPan,
        turnoverRank: r.turnoverRank,
      })),
    [data],
  );
  /** 當前 level 的來源清單：底反走 records 衍生，其餘走後端 results[level]。 */
  const levelRows = useMemo<Hit[]>(
    () => (level === 'reversal' ? reversalRows : (data?.results[level] ?? [])),
    [data, level, reversalRows],
  );
  const countFor = (k: Level): number | undefined => (k === 'reversal' ? reversalRows.length : data?.counts[k]);

  // YouTube 提及（純展示 join）— 只台股有對應；陸股代號不重疊，傳 undefined 不發請求
  const { map: ytMap } = useYouTubeMentionMap(market === 'TW' ? data?.lastDate : undefined);
  const bare = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  // 「近 7 天有 YouTube 提及」篩選謂詞（display-layer；ytRecentOnly 關閉時全過）
  const passYt = (h: Hit) => !ytRecentOnly || (ytMap.get(bare(h.symbol))?.count7d ?? 0) > 0;

  // 漲幅要抓「畫面實際會顯示的那 50 檔」(濾鏡+排序後)，否則改排序/濾鏡後顯示的股票沒抓到漲幅 → 空白。
  // 排序鍵用 perf-independent 版（依 fwd 漲幅排序本身需要 perf，退回 combo 序當抓取依據，避免循環依賴）。
  const fetchTargets = useMemo(() => {
    const rows = levelRows.filter((h) => passFilters(reportMap.get(h.symbol), filters) && passYt(h));
    const baseKey: SortKey = FWD_FIELD[sortKey] ? 'combo' : sortKey;
    rows.sort(rowComparator(baseKey, sortDir === 'desc' ? 1 : -1, {}, reportMap));
    return rows.slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelRows, sortKey, sortDir, filters, reportMap, ytMap, ytRecentOnly]);
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

  const hits = useMemo(() => {
    const rows = levelRows.filter((h) => passFilters(reportMap.get(h.symbol), filters) && passYt(h));
    rows.sort(rowComparator(sortKey, sortDir === 'desc' ? 1 : -1, perf, reportMap));
    return rows.slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelRows, sortKey, sortDir, perf, filters, reportMap, ytMap, ytRecentOnly]);
  const pureSelected = selectedSymbol?.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  return (
    <div className="flex flex-col min-h-0 h-full text-foreground text-xs">
      {/* 標題列 + 重掃 */}
      <div className="shrink-0 flex items-center justify-between gap-1 px-2.5 py-1.5 border-b border-border bg-card/40">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-semibold text-fuchsia-300 shrink-0">🎨 三色資金</span>
          <span className="text-[10px] text-muted-foreground truncate">
            {data ? `${data.lastDate}｜掃 ${data.evaluated} 檔${data.turnoverCap ? `（成交額前 ${data.turnoverCap}）` : ''}${session === 'intraday' ? ' · 盤中跳動' : ''}` : `${market === 'TW' ? '台股' : '陸股 A 股'}自創策略`}
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
          <div className="grid grid-cols-11 gap-1">
            {dates.map((d) => {
              const isActive = d.date === data?.lastDate;
              return (
                <button
                  key={d.date}
                  onClick={() => { if (!loading) { setSession('post_close'); loadDate(d.date, 'post_close'); } }}
                  disabled={loading}
                  className={cn(
                    'text-center px-0.5 py-0.5 rounded text-[9px] font-mono truncate',
                    isActive ? 'bg-sky-700 text-sky-100 font-semibold' : 'bg-secondary/60 text-muted-foreground hover:bg-secondary',
                    loading && 'opacity-50',
                  )}
                  title={`${d.date}｜中 ${d.counts.medium} 檔`}
                >
                  {d.date.slice(5)}
                </button>
              );
            })}
          </div>
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

      {/* 排序 pills（點同鍵切換高/低）— 對齊書本買法的排序列 */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border flex flex-wrap gap-1 items-center">
        <span className="text-[9px] text-muted-foreground/70 mr-0.5">排序</span>
        {SORT_PILLS.map(({ key, label, tip }) => (
          <button key={key}
            onClick={() => {
              if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
              else { setSortKey(key); setSortDir('desc'); }
            }}
            title={tip}
            className={cn(
              'text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap',
              sortKey === key ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground',
            )}>
            {label}{sortKey === key && <span className="ml-0.5">{sortDir === 'desc' ? '▼' : '▲'}</span>}
          </button>
        ))}
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
          const detailTitle = `短攻 ${fmt(h.shortAttack)}｜中強 ${fmt(h.midStrength)}｜中控 ${fmt(h.midControl)}｜超短跌 ${fmt(h.shortOversold)}`
            + (rep ? `\n共振 ${rep.groupBuyCount}/3（雙B/主力/捕撈 中幾組）` : '')
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
                  <span className="font-mono text-[10px] text-muted-foreground">{ticker}</span>
                </div>
                <span className={cn('font-mono text-[11px] font-bold shrink-0', h.changePct >= 0 ? 'text-bull' : 'text-bear')}>
                  {h.changePct >= 0 ? '+' : ''}{fmt(h.changePct)}%
                </span>
              </div>

              {/* Row 2: 股價 + 產業 + YouTube 提及 + 成交量名次（三色分數收進卡片 hover）*/}
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                <span className="font-mono">{fmt(h.price)}</span>
                {h.industry && <span className="truncate max-w-[80px]">{h.industry}</span>}
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
                        title={`當日成交額排名（全市場前 ${data?.turnoverCap ?? ''} 內）`}
                      >
                        成交量第{h.turnoverRank}名
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Row 2.5: 使用順序評級 + 共振 + 賣出警示（觸發/階段收進 badge hover）；判讀句只在選中卡顯示 */}
              <CondChips rep={rep} />
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
