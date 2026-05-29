'use client';
// 三色資金選股（陸股）：對齊主頁盤版 — 走圖 + 訊號面板 + 掃描面板（日期 chip + 掃描紀錄 + 漲跌幅）
// 走圖還原手機 App：頂部完整報價列 + 雙B / 主力狀態F / 捕撈季節三 pane 數值標籤

import { useEffect, useState, useCallback, Fragment } from 'react';
import { PageShell, PageHeader } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RefreshCw, Search } from 'lucide-react';
import { SanSeChart, type SanSeChartPayload } from '@/components/cn-sanse/SanSeChart';
import { ForwardPerfRow } from '@/features/scan/components/ForwardPerfRow';
import type { LatestSignals } from '@/lib/cn-sanse/indicators';
import type { SanSeQuote } from '@/lib/cn-sanse/cnQuote';
import type { StockForwardPerformance } from '@/lib/scanner/types';
import { STAGE_LABEL, STAGE_ICON, type ConditionReport, type ResLevel } from '@/lib/cn-sanse/conditions';
import { rerankRecords, RANK_HORIZONS, type HKey, type BucketStat } from '@/lib/cn-sanse/rankingScore';
import { isCNMarketOpen, isPostCloseWindow } from '@/lib/datasource/marketHours';

type Level = 'strict' | 'medium' | 'loose';

interface Hit {
  symbol: string; name: string; industry: string; price: number; changePct: number;
  shortAttack: number; midStrength: number; midControl: number; kongPan: number;
}
interface RecordRow {
  symbol: string; name: string; industry: string; price: number; changePct: number;
  report: ConditionReport;
}
interface ResonanceCounts { strong: number; medium: number; weak: number; observe: number; conflict: number }
interface ScanResp {
  ok: boolean; lastDate: string; evaluated: number; staleSkipped?: number;
  counts: Record<Level, number>; results: Record<Level, Hit[]>;
  records?: RecordRow[]; resonanceCounts?: ResonanceCounts;
  sessionType?: 'post_close' | 'intraday'; archivedDate?: string;
  cached?: boolean; error?: string;
}
interface DateEntry { date: string; counts: Record<Level, number>; scannedAt: string }
interface Scores { shortAttack: number; midStrength: number; midControl: number; kongPan: number }
interface DetailResp {
  ok: boolean; symbol: string; name: string; industry: string; lastDate: string;
  price: number; changePct: number; quote?: SanSeQuote | null; scores?: Scores;
  chart: SanSeChartPayload & { latest: LatestSignals }; error?: string;
}

type FilterKey = 'strong' | 'doubleB' | 'catch' | 'both' | 'hideConflict';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'strong', label: '只看強共振' },
  { key: 'doubleB', label: '主力+雙B' },
  { key: 'catch', label: '主力+捕撈' },
  { key: 'both', label: '雙指標同時' },
  { key: 'hideConflict', label: '隱藏衝突' },
];
function passFilters(r: RecordRow, f: Set<FilterKey>): boolean {
  const rep = r.report;
  if (f.has('strong') && rep.level !== 'strong') return false;
  if (f.has('doubleB') && !(rep.mainforce.buyHit && rep.doubleB.buyHit)) return false;
  if (f.has('catch') && !(rep.mainforce.buyHit && rep.catch.buyHit)) return false;
  if (f.has('both') && !(rep.doubleB.buyHit && rep.catch.buyHit)) return false;
  if (f.has('hideConflict') && rep.conflict) return false;
  return true;
}
const RES_BADGE: Record<ResLevel, { label: string; cls: string }> = {
  strong: { label: '強共振', cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40' },
  medium: { label: '中共振', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  weak: { label: '弱共振', cls: 'bg-secondary text-muted-foreground border-border' },
};

const BT_COLS = [
  ['openReturn', '隔日開'], ['d1Return', '1日'], ['d3Return', '3日'], ['d5Return', '5日'],
  ['d10Return', '10日'], ['d20Return', '20日'], ['maxGain', '最高'], ['maxLoss', '最低'],
] as const;
interface BacktestResp { ok: boolean; buckets: BucketStat[]; days: number; samples: number; computedAt: string; cached?: boolean; source?: string; error?: string }
const btColor = (v: number | null) => (v == null ? 'text-muted-foreground/40' : v > 0 ? 'text-rose-400' : v < 0 ? 'text-emerald-400' : 'text-muted-foreground');
const btFmt = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

// 大盤 regime 燈號（紅綠燈語意：綠=可買、黃=收手、紅=觀望）。回測：只在多頭日買第一檔 5日 +0.32% vs 盤整/空頭 −0.5%。
type MarketRegime = 'bull' | 'chop' | 'bear';
interface RegimeResp { ok: boolean; regime: MarketRegime; asOf: string; close: number; ma20: number | null; ma60: number | null; error?: string }
const REGIME_UI: Record<MarketRegime, { dot: string; label: string; hint: string; cls: string }> = {
  bull: { dot: '🟢', label: '大盤多頭', hint: '可積極買第一檔', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  chop: { dot: '🟡', label: '大盤盤整', hint: '第一檔短線偏弱 · 建議收手或只做極短', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' },
  bear: { dot: '🔴', label: '大盤空頭', hint: '三色短線無優勢 · 建議觀望', cls: 'bg-rose-500/10 text-rose-300 border-rose-500/30' },
};

const fmt = (n: number | undefined) => (n != null && Number.isFinite(n) ? n.toFixed(2) : '—');
/** 元 → 億，<1000 億顯 1 位小數、≥1000 億取整（對齊 App） */
const fmtYi = (v: number | undefined) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const yi = v / 1e8;
  return `${yi >= 1000 ? yi.toFixed(0) : yi.toFixed(1)}億`;
};

/** 陸股盤中即時掃描「活躍時段」= 開盤(9:15–15:00) 或盤後窗(15:01–15:30)。
 *  直接用後端 marketHours 單一事實來源（含假日判斷），與 cron gate 完全對齊。 */
function isCNIntradayActive(): boolean {
  return isCNMarketOpen() || isPostCloseWindow('CN');
}

/** 代號正規化：6→.SS；其餘→.SZ */
function toSymbol(input: string): string | null {
  const s = input.trim().toUpperCase();
  if (/^\d{6}\.(SS|SZ)$/.test(s)) return s;
  const code = s.replace(/\D/g, '');
  if (code.length !== 6) return null;
  return code[0] === '6' ? `${code}.SS` : `${code}.SZ`;
}

export default function CnSanSePage() {
  const [data, setData] = useState<ScanResp | null>(null);
  const [dates, setDates] = useState<DateEntry[]>([]);
  const [session, setSession] = useState<'post_close' | 'intraday'>('post_close');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sym, setSym] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartErr, setChartErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [bars, setBars] = useState(60);
  const [perf, setPerf] = useState<Record<string, StockForwardPerformance>>({});
  const [perfLoading, setPerfLoading] = useState(false);
  const [pane, setPane] = useState<'pool' | 'observe'>('pool');
  const [filters, setFilters] = useState<Set<FilterKey>>(new Set());
  const [showBacktest, setShowBacktest] = useState(false);
  const [bt, setBt] = useState<BacktestResp | null>(null);
  const [btLoading, setBtLoading] = useState(false);
  // 預設「期望漲幅·3日」：walk-forward 驗證顯示第一檔短線報酬/勝率優於舊「共振強度」排序
  const [rankMode, setRankMode] = useState<'resonance' | 'gain'>('gain');
  const [rankHz, setRankHz] = useState<HKey>('d3Return');
  const [regime, setRegime] = useState<RegimeResp | null>(null);

  // 載入掃描結果。session='intraday' → 讀盤中即時快照（latest live，忽略 date）；
  // 否則讀盤後封存（無 date → 最新一日）。sessionArg 顯式傳入以免吃到 state 非同步延遲。
  const loadDate = useCallback(async (date?: string, sessionArg?: 'post_close' | 'intraday') => {
    const sess = sessionArg ?? session;
    setLoading(true); setErr(null);
    try {
      const url = sess === 'intraday'
        ? '/api/cn-sanse/scan?session=intraday'
        : `/api/cn-sanse/scan${date ? `?date=${date}` : ''}`;
      const r = await fetch(url);
      const j: ScanResp = await r.json();
      if (!j.ok) throw new Error(j.error || (sess === 'intraday' ? '尚無盤中即時快照（等盤中掃描跑一輪）' : '讀取失敗'));
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '讀取失敗');
    } finally { setLoading(false); }
  }, [session]);

  // 切換盤後 / 盤中
  const switchSession = useCallback((s: 'post_close' | 'intraday') => {
    setSession(s);
    loadDate(undefined, s);
  }, [loadDate]);

  const loadDates = useCallback(async () => {
    try {
      const r = await fetch('/api/cn-sanse/scan/dates');
      const j = await r.json();
      if (j.ok) setDates(j.dates ?? []);
    } catch { /* chip 列載不到不致命 */ }
  }, []);

  // 即時重掃並固化當日
  const rescan = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch('/api/cn-sanse/scan?force=1');
      const j: ScanResp = await r.json();
      if (!j.ok) throw new Error(j.error || '掃描失敗');
      setData(j);
      loadDates();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '掃描失敗');
    } finally { setLoading(false); }
  }, [loadDates]);

  // 進頁：盤中時段預設讀即時快照，否則讀盤後封存（在 effect 內判斷以避免 SSR/CSR hydration 不一致）
  useEffect(() => {
    loadDates();
    const initial = isCNIntradayActive() ? 'intraday' : 'post_close';
    setSession(initial);
    loadDate(undefined, initial);
    // 只在掛載時跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 重新整理：盤中模式重抓即時快照；盤後模式即時重掃並固化當日
  const onRefresh = useCallback(() => {
    if (session === 'intraday') loadDate(undefined, 'intraday');
    else rescan();
  }, [session, loadDate, rescan]);

  // 選股/搜尋 → 載入該檔走圖 + 指標 + 即時報價
  useEffect(() => {
    if (!sym) { setDetail(null); return; }
    let alive = true;
    setChartLoading(true); setChartErr(null); setDetail(null);
    fetch(`/api/cn-sanse/chart/${sym}`)
      .then((r) => r.json())
      .then((j: DetailResp) => {
        if (!alive) return;
        if (j.ok) setDetail(j);
        else setChartErr(j.error || '找不到該股票本地K線');
      })
      .catch(() => { if (alive) setChartErr('載入失敗'); })
      .finally(() => { if (alive) setChartLoading(false); });
    return () => { alive = false; };
  }, [sym]);

  // 大盤 regime 燈號：跟著資料日期走（盤後=該日 as-of；盤中=最新）
  useEffect(() => {
    if (!data?.lastDate) { setRegime(null); return; }
    let alive = true;
    fetch(`/api/cn-sanse/regime?date=${data.lastDate}`)
      .then((r) => r.json())
      .then((j: RegimeResp) => { if (alive && j.ok) setRegime(j); })
      .catch(() => { /* 燈號取不到不致命 */ });
    return () => { alive = false; };
  }, [data?.lastDate]);

  // 當前可見清單（共振紀錄驅動；無 records 時退回舊 results）
  const allRecords: RecordRow[] = data?.records ?? [];
  const poolRows = allRecords.filter((r) => r.report.mainforce.buyHit);
  const observeRows = allRecords.filter((r) => !r.report.mainforce.buyHit);
  // 策略池排序：共振強度（舊·scan 預設）或 期望漲幅（回測重排，第一檔=歷史最會漲的條件）
  const rankedPool = rankMode === 'gain' && bt?.buckets?.length
    ? rerankRecords(poolRows, bt.buckets, rankHz)
    : poolRows;
  const baseRows = pane === 'pool' ? rankedPool : observeRows;
  const visibleRows = baseRows.filter((r) => passFilters(r, filters)).slice(0, 80);

  // 掃描結果 → 取未來漲跌幅（複用主頁 /api/backtest/forward，支援 .SS/.SZ）
  useEffect(() => {
    let poolForPerf = (data?.records ?? []).filter((r) => r.report.mainforce.buyHit);
    if (rankMode === 'gain' && bt?.buckets?.length) poolForPerf = rerankRecords(poolForPerf, bt.buckets, rankHz);
    const rows = (pane === 'pool'
      ? poolForPerf
      : (data?.records ?? []).filter((r) => !r.report.mainforce.buyHit)
    ).slice(0, 80);
    if (!data || rows.length === 0) { setPerf({}); return; }
    let alive = true;
    setPerfLoading(true);
    fetch('/api/backtest/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scanDate: data.lastDate,
        stocks: rows.map((h) => ({ symbol: h.symbol, name: h.name, scanPrice: h.price })),
      }),
    })
      .then((r) => r.json())
      .then((j: { performance?: StockForwardPerformance[] }) => {
        if (!alive) return;
        const m: Record<string, StockForwardPerformance> = {};
        for (const p of j.performance ?? []) m[p.symbol] = p;
        setPerf(m);
      })
      .catch(() => { /* 漲跌幅取不到不致命 */ })
      .finally(() => { if (alive) setPerfLoading(false); });
    return () => { alive = false; };
  }, [data, pane, rankMode, rankHz, bt]);

  const toggleFilter = (k: FilterKey) => setFilters((prev) => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });

  const ensureBt = useCallback(async (force = false) => {
    if (bt && !force) return;
    setBtLoading(true);
    try {
      const r = await fetch(`/api/cn-sanse/backtest${force ? '?force=1' : ''}`);
      const j: BacktestResp = await r.json();
      if (j.ok) setBt(j);
    } finally { setBtLoading(false); }
  }, [bt]);

  const openBacktest = useCallback(async (force = false) => {
    setShowBacktest(true);
    await ensureBt(force);
  }, [ensureBt]);

  // 預設用期望漲幅排序 → 一進頁就把回測桶統計載入，讓策略池立刻依期望漲幅重排
  useEffect(() => { void ensureBt(); }, [ensureBt]);

  const submitSearch = () => {
    const s = toSymbol(query);
    if (!s) { setChartErr('代號格式不對（請輸入 6 位數，如 603986 或 000001）'); setSym(null); return; }
    setSym(s);
  };

  // 走圖永遠載最新資料；只有「該股 K 線比選定掃描日還舊」（停牌/退市）才算落後。
  // 盤中模式 data.lastDate=今日，但走圖只到封存（昨日）是正常的 → 比對 archivedDate 而非 lastDate，
  // 否則每檔都會誤報「資料僅到昨日」。
  const staleRef = (data?.sessionType === 'intraday' ? data?.archivedDate : data?.lastDate) ?? data?.lastDate;
  const stale = detail && staleRef && detail.lastDate < staleRef;
  const rc = data?.resonanceCounts;

  return (
    <PageShell
      fullViewport
      headerSlot={
        <PageHeader
          title="🎨 三色資金選股"
          subtitle={data
            ? `陸股 · ${data.lastDate} · ${session === 'intraday' ? '盤中即時（量能未收，訊號會跳動）' : '盤後定調'} · 掃 ${data.evaluated} 檔${data.staleSkipped ? ` · 剔除落後 ${data.staleSkipped}` : ''}`
            : '陸股 A 股'}
          backButton
          actions={
            <div className="flex items-center gap-1">
              {/* 盤後 / 盤中 切換 */}
              <div className="flex rounded-md border border-border overflow-hidden text-xs mr-1">
                <button
                  onClick={() => switchSession('post_close')}
                  disabled={loading}
                  className={cn('px-2 py-1', session === 'post_close' ? 'bg-sky-600 text-sky-50 font-semibold' : 'text-muted-foreground hover:bg-secondary')}
                  title="盤後封存版（讀完整收盤日K，訊號穩定）"
                >盤後定調</button>
                <button
                  onClick={() => switchSession('intraday')}
                  disabled={loading}
                  className={cn('px-2 py-1', session === 'intraday' ? 'bg-rose-600 text-rose-50 font-semibold' : 'text-muted-foreground hover:bg-secondary')}
                  title="盤中即時：把當下報價合成未收的那根日K 重算；量能半根、訊號會整天跳動，收盤前才定調"
                >盤中即時</button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => openBacktest()} className="h-8 text-xs" title="各共振組合的歷史漲跌幅比較">📊 回測</Button>
              <Button variant="ghost" size="icon" onClick={onRefresh} disabled={loading} title={session === 'intraday' ? '重抓盤中即時快照' : '即時重新掃描並固化當日'} className="w-8 h-8">
                <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              </Button>
            </div>
          }
        />
      }
    >
      <div className="h-full flex flex-row-reverse">
        {/* ── 右：掃描面板（日期 chip + 搜尋 + 選股器 + 結果表 + 漲跌幅）── */}
        <div className="w-[38%] min-w-[380px] border-l border-border flex flex-col overflow-hidden">
          {/* 大盤 regime 燈號（擇時閘門：多頭才積極買第一檔）*/}
          {regime && <RegimeBanner r={regime} />}
          {/* 日期 chip 列（對齊主頁）*/}
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

          {/* 股號搜尋 */}
          <div className="shrink-0 p-2 border-b border-border flex gap-1.5">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitSearch(); }}
                placeholder="輸入股號看任意股票，如 603986 / 000001"
                className="w-full bg-secondary/50 border border-border rounded-md pl-7 pr-2 py-1.5 text-xs outline-none focus:border-sky-500/50"
              />
            </div>
            <Button size="sm" variant="secondary" className="h-auto py-1 text-xs" onClick={submitSearch}>查看</Button>
          </div>

          {/* 策略池 / 觀察區 切換 */}
          <div className="shrink-0 px-2 pt-2 flex gap-1">
            <button
              onClick={() => setPane('pool')}
              className={cn('flex-1 px-2 py-1 rounded-md text-xs font-medium border', pane === 'pool' ? 'bg-sky-500/15 text-sky-400 border-sky-500/40' : 'text-muted-foreground border-transparent hover:bg-secondary')}
            >策略池<span className="ml-1 opacity-70">{poolRows.length}</span></button>
            <button
              onClick={() => setPane('observe')}
              className={cn('flex-1 px-2 py-1 rounded-md text-xs font-medium border', pane === 'observe' ? 'bg-sky-500/15 text-sky-400 border-sky-500/40' : 'text-muted-foreground border-transparent hover:bg-secondary')}
              title="未入選任何策略，但圖表指標出現買點 — 反推策略是否過濾過嚴"
            >觀察區<span className="ml-1 opacity-70">{rc?.observe ?? observeRows.length}</span></button>
          </div>

          {/* 共振篩選 chip */}
          <div className="shrink-0 px-2 py-1.5 border-b border-border flex flex-wrap gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => toggleFilter(f.key)}
                disabled={pane === 'observe' && f.key !== 'doubleB' && f.key !== 'catch' && f.key !== 'both'}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[10px] border transition-colors',
                  filters.has(f.key) ? 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40' : 'text-muted-foreground border-border hover:bg-secondary',
                  pane === 'observe' && f.key !== 'doubleB' && f.key !== 'catch' && f.key !== 'both' && 'opacity-30',
                )}
              >{f.label}</button>
            ))}
            {rc && pane === 'pool' && (
              <span className="ml-auto text-[10px] text-muted-foreground self-center">強{rc.strong}·中{rc.medium}·弱{rc.weak}·衝突{rc.conflict}</span>
            )}
          </div>

          {/* 排序切換（策略池）：共振強度（舊）/ 期望漲幅（回測重排，第一檔=歷史最會漲的條件）*/}
          {pane === 'pool' && (
            <div className="shrink-0 px-2 py-1.5 border-b border-border flex items-center gap-1 text-[10px] flex-wrap">
              <span className="text-muted-foreground">排序</span>
              <button
                onClick={() => setRankMode('resonance')}
                className={cn('px-1.5 py-0.5 rounded border', rankMode === 'resonance' ? 'bg-sky-500/15 text-sky-300 border-sky-500/40' : 'text-muted-foreground border-border hover:bg-secondary')}
              >共振強度</button>
              <button
                onClick={() => { setRankMode('gain'); ensureBt(); }}
                className={cn('px-1.5 py-0.5 rounded border', rankMode === 'gain' ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'text-muted-foreground border-border hover:bg-secondary')}
                title="用回測：把歷史上該條件組合最會漲的排到第一"
              >期望漲幅</button>
              {rankMode === 'gain' && (
                <div className="flex gap-0.5 ml-1">
                  {RANK_HORIZONS.map((h) => (
                    <button
                      key={h.key}
                      onClick={() => setRankHz(h.key)}
                      className={cn('px-1 py-0.5 rounded border', rankHz === h.key ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'text-muted-foreground border-border hover:bg-secondary')}
                    >{h.label}</button>
                  ))}
                </div>
              )}
              {rankMode === 'gain' && (
                btLoading
                  ? <span className="ml-auto text-muted-foreground">回測載入中…</span>
                  : bt?.buckets?.length
                    ? <span className="ml-auto text-muted-foreground" title={bt.source === 'deep' ? '全期深度回測' : '即時 30 天回測'}>依 {bt.days} 天回測 · 第一檔=期望漲幅最高</span>
                    : <span className="ml-auto text-amber-400/80">無回測資料</span>
              )}
            </div>
          )}

          {/* 結果表（共振卡片：策略來源 + 指標買點 + 共振等級 + 漲跌幅）*/}
          <div className="flex-1 overflow-auto">
            {err && <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>}
            {loading && !data && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
            {data && !loading && visibleRows.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">
                {allRecords.length === 0 ? '此日無共振資料（請按右上重新掃描或回補）。' : pane === 'observe' ? '無「未入選但有指標買點」的股票。' : '此條件下無命中。'}
              </div>
            )}
            {visibleRows.map((r) => (
              <RecordCard key={r.symbol} r={r} perf={perf[r.symbol]} perfLoading={perfLoading} active={sym === r.symbol} onClick={() => setSym(r.symbol)} />
            ))}
          </div>
        </div>

        {/* ── 中：訊號面板（像主頁分析面板）── */}
        <div className="w-[300px] shrink-0 border-l border-border overflow-auto">
          {!sym ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground px-4 text-center">選一檔股票<br />這裡顯示買賣訊號與狀態</div>
          ) : !detail ? (
            <div className="p-3 text-sm text-muted-foreground">{chartErr || '載入訊號…'}</div>
          ) : (
            <SignalPanel detail={detail} data={data} symbol={sym} />
          )}
        </div>

        {/* ── 左：走圖（頂部報價列 + 三 pane 數值標籤）── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {!sym ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">← 從右側選股，或上方輸入股號查看任意股票</div>
          ) : (
            <>
              {/* 頂部完整報價列（還原手機 App）*/}
              <div className="shrink-0 px-3 py-2 border-b border-border flex items-start gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-sm font-bold">{detail?.name ?? sym}</span>
                    <span className="text-[11px] text-muted-foreground">{sym}{detail?.industry ? ` · ${detail.industry}` : ''}</span>
                  </div>
                  <QuotePrice detail={detail} />
                </div>
                {detail && <QuoteGrid detail={detail} />}
                {detail && (
                  <span className={cn('text-[11px] px-1.5 py-0.5 rounded self-center', stale ? 'bg-amber-500/15 text-amber-400' : 'text-muted-foreground')}>
                    {stale ? `⚠️ 資料僅到 ${detail.lastDate}` : `資料至 ${detail.lastDate}`}
                  </span>
                )}
                <div className="flex gap-0.5 ml-auto self-center">
                  {([['60', 60], ['120', 120], ['全部', 0]] as const).map(([label, v]) => (
                    <button
                      key={label}
                      onClick={() => setBars(v)}
                      className={cn(
                        'px-1.5 py-0.5 rounded text-[11px] transition-colors',
                        bars === v ? 'bg-sky-500/20 text-sky-400' : 'text-muted-foreground hover:bg-secondary',
                      )}
                    >{label}</button>
                  ))}
                </div>
              </div>

              {/* 走圖 */}
              <div className="flex-1 min-h-[300px] relative">
                {chartLoading && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground z-10">載入走圖…</div>}
                {chartErr && <div className="absolute inset-0 flex items-center justify-center text-sm text-rose-400 z-10">{chartErr}</div>}
                {detail && <SanSeChart data={detail.chart} bars={bars} />}
              </div>
            </>
          )}
        </div>
      </div>

      {showBacktest && (
        <BacktestOverlay bt={bt} loading={btLoading} onClose={() => setShowBacktest(false)} onRecompute={() => openBacktest(true)} />
      )}
    </PageShell>
  );
}

/** 共振組合回測比較 — 全寬覆蓋表 */
function BacktestOverlay({ bt, loading, onClose, onRecompute }: {
  bt: BacktestResp | null; loading: boolean; onClose: () => void; onRecompute: () => void;
}) {
  let lastGroup = '';
  return (
    <div className="absolute inset-0 z-30 bg-background/98 backdrop-blur flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border">
        <span className="font-bold text-sm">📊 共振組合回測比較</span>
        {bt && <span className="text-[11px] text-muted-foreground">{bt.days} 個掃描日 · {bt.samples} 筆樣本{bt.cached ? ' · 快取' : ''}</span>}
        <span className="text-[11px] text-muted-foreground">紅=平均報酬正、綠=負；小字=勝率%</span>
        <div className="ml-auto flex gap-1">
          <Button variant="secondary" size="sm" className="h-7 text-xs" onClick={onRecompute} disabled={loading}>{loading ? '計算中…' : '重算'}</Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>關閉 ✕</Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {loading && !bt && <div className="p-6 text-sm text-muted-foreground">計算中…（讀 ~22 天 records、對齊未來漲跌幅，約數十秒）</div>}
        {bt && (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-background">
              <tr className="text-right text-muted-foreground border-b border-border">
                <th className="text-left font-medium p-1.5">共振組合</th>
                <th className="font-medium p-1.5">樣本</th>
                {BT_COLS.map(([, label]) => <th key={label} className="font-medium p-1.5">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {bt.buckets.map((b) => {
                const groupHeader = b.group !== lastGroup ? b.group : null;
                lastGroup = b.group;
                return (
                  <Fragment key={b.key}>
                    {groupHeader && (
                      <tr><td colSpan={2 + BT_COLS.length} className="pt-2 pb-0.5 px-1.5 text-[10px] font-semibold text-sky-400">{groupHeader}</td></tr>
                    )}
                    <tr className="text-right border-b border-border/30 hover:bg-secondary/40">
                      <td className="text-left p-1.5">{b.label}</td>
                      <td className="p-1.5 tabular-nums text-muted-foreground">{b.n}</td>
                      {BT_COLS.map(([key]) => (
                        <td key={key} className="p-1.5 tabular-nums">
                          <div className={btColor(b.avg[key])}>{btFmt(b.avg[key])}</div>
                          {b.win[key] != null && <div className="text-[9px] text-muted-foreground/60">{b.win[key]}%</div>}
                        </td>
                      ))}
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** 大字現價 + 漲跌 + 漲跌幅（A 股紅漲綠跌）*/
function QuotePrice({ detail }: { detail: DetailResp | null }) {
  if (!detail) return null;
  const q = detail.quote;
  const price = q?.price ?? detail.price;
  const chgPct = q?.changePct ?? detail.changePct;
  const chg = q?.change;
  const up = chgPct > 0, down = chgPct < 0;
  const c = up ? 'text-rose-400' : down ? 'text-emerald-400' : 'text-muted-foreground';
  return (
    <div className={cn('flex items-baseline gap-2 mt-0.5', c)}>
      <span className="text-2xl font-bold tabular-nums">{fmt(price)}</span>
      {chg != null && <span className="text-xs tabular-nums">{chg > 0 ? '+' : ''}{fmt(chg)}</span>}
      <span className="text-xs tabular-nums">{chgPct > 0 ? '+' : ''}{fmt(chgPct)}%</span>
    </div>
  );
}

/** 報價 grid：今開/量比/總額 · 最高/換手/總值 · 最低/市盈(動)/振幅。無即時報價退回本地 K 開高低。*/
function QuoteGrid({ detail }: { detail: DetailResp }) {
  const q = detail.quote;
  const lastC = detail.chart.candles[detail.chart.candles.length - 1];
  const Cell = ({ k, v, c }: { k: string; v: string; c?: string }) => (
    <div className="flex gap-1 whitespace-nowrap">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn('tabular-nums', c)}>{v}</span>
    </div>
  );
  if (!q) {
    // 退回本地 K（非交易時段抓不到即時報價）
    return (
      <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[11px] self-center">
        <Cell k="今開" v={fmt(lastC?.open)} />
        <Cell k="最高" v={fmt(lastC?.high)} />
        <Cell k="最低" v={fmt(lastC?.low)} />
      </div>
    );
  }
  const sign = (n: number) => (n > 0 ? 'text-rose-400' : n < 0 ? 'text-emerald-400' : '');
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-0.5 text-[11px] self-center">
      <Cell k="今開" v={fmt(q.open)} c={sign(q.open - q.prevClose)} />
      <Cell k="量比" v={fmt(q.volumeRatio)} />
      <Cell k="總額" v={fmtYi(q.amount)} />
      <Cell k="最高" v={fmt(q.high)} c={sign(q.high - q.prevClose)} />
      <Cell k="換手" v={`${fmt(q.turnover)}%`} />
      <Cell k="總值" v={fmtYi(q.totalCap)} />
      <Cell k="最低" v={fmt(q.low)} c={sign(q.low - q.prevClose)} />
      <Cell k="市盈動" v={fmt(q.peTTM)} />
      <Cell k="振幅" v={`${fmt(q.amplitude)}%`} />
    </div>
  );
}

/** 大盤 regime 燈號條：綠=多頭可買 / 黃=盤整收手 / 紅=空頭觀望（上證 收盤 vs MA20/MA60）*/
function RegimeBanner({ r }: { r: RegimeResp }) {
  const u = REGIME_UI[r.regime];
  return (
    <div className={cn('shrink-0 px-2 py-1 border-b flex items-center gap-2 text-[11px]', u.cls)}>
      <span className="font-semibold whitespace-nowrap">{u.dot} {u.label}</span>
      <span className="opacity-90 truncate">· {u.hint}</span>
      <span className="ml-auto tabular-nums opacity-70 whitespace-nowrap">
        上證 {r.close}{r.ma20 != null ? ` · MA20 ${r.ma20}` : ''}{r.ma60 != null ? ` · MA60 ${r.ma60}` : ''}
      </span>
    </div>
  );
}

const metSignals = (g: ConditionReport['doubleB']) => g.buy.filter((c) => c.kind === 'signal' && c.met).map((c) => c.label);
const hasState = (g: ConditionReport['doubleB'], id: string) => g.buy.some((c) => c.id === id && c.met);

function GroupChip({ on, label, detail, cls }: { on: boolean; label: string; detail?: string; cls: string }) {
  if (!on) return <span className="px-1 py-0.5 rounded border border-border text-muted-foreground/40">{label} –</span>;
  return <span className={cn('px-1 py-0.5 rounded border', cls)}>{label}{detail ? ` ${detail}` : ''}</span>;
}

function RecordCard({ r, perf, perfLoading, active, onClick }: {
  r: RecordRow; perf?: StockForwardPerformance; perfLoading: boolean; active: boolean; onClick: () => void;
}) {
  const rep = r.report;
  const badge = rep.level ? RES_BADGE[rep.level] : null;
  const s = rep.scores;
  const stageTxt = rep.mainStage ? `${STAGE_LABEL[rep.mainStage]}${STAGE_ICON[rep.mainStage]}` : undefined;
  return (
    <div onClick={onClick} className={cn('px-2 py-1.5 border-b border-border/40 cursor-pointer hover:bg-secondary/60', active && 'bg-sky-500/10')}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">{r.name}</span>
        <span className="text-[10px] text-muted-foreground">{r.symbol} · {r.industry}</span>
        <span className="ml-auto tabular-nums">{fmt(r.price)}</span>
        <span className={cn('tabular-nums', r.changePct > 0 ? 'text-rose-400' : r.changePct < 0 ? 'text-emerald-400' : '')}>
          {r.changePct > 0 ? '+' : ''}{fmt(r.changePct)}%
        </span>
      </div>
      {/* 三組共振：主力階段 / 雙B / 捕撈 */}
      <div className="flex items-center flex-wrap gap-1 mt-1 text-[10px]">
        {badge && <span className={cn('px-1.5 py-0.5 rounded border font-medium', badge.cls)}>{badge.label} {rep.groupBuyCount}/3</span>}
        <GroupChip on={rep.doubleB.buyHit} label="雙B" detail={metSignals(rep.doubleB).join('/')} cls="bg-rose-500/15 text-rose-300 border-rose-500/30" />
        <GroupChip on={rep.mainforce.buyHit} label="主力" detail={stageTxt} cls="bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30" />
        <GroupChip on={rep.catch.buyHit} label="捕撈" detail={metSignals(rep.catch).join('/')} cls="bg-emerald-500/15 text-emerald-300 border-emerald-500/30" />
        {rep.conflict && <span className="px-1 py-0.5 rounded bg-amber-600/20 text-amber-200 border border-amber-500/40">訊號衝突</span>}
      </div>
      {/* 賣出提示 */}
      {rep.sellWarnings.length > 0 && (
        <div className="text-[10px] text-amber-400/90 mt-0.5">⚠️ {rep.sellWarnings.join('、')}</div>
      )}
      {/* 主力強度 + 位階 */}
      <div className="flex items-center gap-2 text-[10px] mt-0.5 text-muted-foreground">
        <span title="短線上攻" className="text-fuchsia-400">短攻{fmt(s.shortAttack)}</span>
        <span title="中線強勢" className={s.midStrength < 0 ? 'text-emerald-400' : 'text-rose-300'}>中強{fmt(s.midStrength)}</span>
        <span title="中線控盤" className="text-amber-300">中控{fmt(s.midControl)}</span>
        {hasState(rep.doubleB, 'b_above') && <span className="text-sky-300/70">站上多空線</span>}
        {hasState(rep.catch, 'c_above') && <span className="text-sky-300/70">動能多頭區</span>}
      </div>
      <div className="mt-1"><ForwardPerfRow performance={perf} isFetching={perfLoading} /></div>
    </div>
  );
}

function Score({ label, v, c }: { label: string; v: number; c: string }) {
  return (
    <div className="rounded-md border border-border px-2 py-1 text-center">
      <div className="text-muted-foreground text-[9px]">{label}</div>
      <div className={cn('font-bold tabular-nums text-sm', c)}>{fmt(v)}</div>
    </div>
  );
}

function CondList({ title, g, color }: { title: string; g: ConditionReport['doubleB']; color: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={cn('text-[11px] font-medium', color)}>{title}</span>
        {g.buyHit && <span className="text-[9px] px-1 rounded bg-rose-500/15 text-rose-300">買進</span>}
        {g.sellHit && <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-300">賣出</span>}
      </div>
      <div className="flex flex-wrap gap-1 text-[10px]">
        {g.buy.map((c) => (
          <span key={c.id} className={cn('px-1 py-0.5 rounded border', c.met ? (c.kind === 'signal' ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-sky-500/10 text-sky-300 border-sky-500/30') : 'text-muted-foreground/35 border-border')}>
            {c.met ? '✓' : '○'}{c.label}
          </span>
        ))}
        {g.sell.filter((c) => c.met).map((c) => (
          <span key={c.id} className="px-1 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/30">⚠️{c.label}</span>
        ))}
      </div>
    </div>
  );
}

function SignalPanel({ detail, data, symbol }: { detail: DetailResp; data: ScanResp | null; symbol: string }) {
  const rec = data?.records?.find((r) => r.symbol === symbol);
  const rep = rec?.report;
  return (
    <div className="p-3 space-y-3">
      {/* 共振總結 */}
      {rep ? (
        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          {rep.level && <span className={cn('px-1.5 py-0.5 rounded border font-medium', RES_BADGE[rep.level].cls)}>{RES_BADGE[rep.level].label} {rep.groupBuyCount}/3</span>}
          {rep.mainStage && <span className="px-1.5 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300 border border-fuchsia-500/30">主力{STAGE_LABEL[rep.mainStage]}{STAGE_ICON[rep.mainStage]}</span>}
          {rep.conflict && <span className="px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-200 border border-amber-500/40">訊號衝突</span>}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">此檔在所選掃描日未達任一組買點（或無固化資料）。</div>
      )}

      {/* 三組條件清單 */}
      {rep && (
        <div className="space-y-1.5">
          <CondList title="🟦 雙B戰法" g={rep.doubleB} color="text-rose-300" />
          <CondList title="🟪 主力狀態" g={rep.mainforce} color="text-fuchsia-400" />
          <CondList title="🟩 捕撈季節" g={rep.catch} color="text-emerald-400" />
        </div>
      )}

      {/* 三色資金分數 */}
      {detail.scores && (
        <div className="grid grid-cols-2 gap-1.5">
          <Score label="短線上攻" v={detail.scores.shortAttack} c="text-fuchsia-400" />
          <Score label="中線強勢" v={detail.scores.midStrength} c="text-rose-300" />
          <Score label="中線控盤" v={detail.scores.midControl} c="text-amber-300" />
          <Score label="控盤程度" v={detail.scores.kongPan} c="text-sky-300" />
        </div>
      )}

      {/* 今日訊號 + 双B 五元件狀態 + 口訣 */}
      <Teaching latest={detail.chart.latest} />
    </div>
  );
}

function Teaching({ latest }: { latest: LatestSignals }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap"><span className="font-bold text-sm">📖 怎麼操作（{latest.date}）</span></div>
      <div className="space-y-2">
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2">
          <div className="text-rose-400 font-medium mb-1">🔺 買進訊號</div>
          {latest.buy.length ? <ul className="space-y-0.5 list-disc pl-4">{latest.buy.map((s) => <li key={s}>{s}</li>)}</ul> : <span className="text-muted-foreground">今日無買進訊號</span>}
        </div>
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
          <div className="text-emerald-400 font-medium mb-1">🔻 賣出 / 減碼訊號</div>
          {latest.sell.length ? <ul className="space-y-0.5 list-disc pl-4">{latest.sell.map((s) => <li key={s}>{s}</li>)}</ul> : <span className="text-muted-foreground">今日無賣出訊號</span>}
        </div>
      </div>
      <div className="space-y-1.5 text-[11px]">
        <Env label="大趨勢（多空線 MA60）" v={latest.trend} />
        <Env label="中期支撐（智能交易線）" v={latest.support} />
        <Env label="黃紅雙線" v={latest.dual} />
      </div>
      <div className="rounded-md border border-border p-2 text-[11px] text-muted-foreground leading-relaxed">
        <span className="text-foreground font-medium">看圖口訣：</span>
        主圖橙線=智能交易線（中期支撐，站上做多、跌破減碼）；黃線在紅線上=多方、死叉離場；灰點線=60 日多空線定牛熊。
        副圖1 主力狀態F：<span className="text-rose-400">紅=中線主力</span>、<span className="text-amber-300">黃=控盤</span>、<span className="text-fuchsia-400">紫=短線游資</span>、<span className="text-blue-400">藍/</span><span className="text-emerald-400">綠=超跌</span>；紅+紫做短線、紅+黃做中線、三色齊揚最強。
        副圖2（捕撈季節）紫/綠柱=動能，<span className="text-rose-400">紅箭頭金叉買</span>、<span className="text-emerald-400">綠箭頭死叉賣</span>；動能在 0 軸上才是安全做多區。
        書本進場時機：上漲日 13:20 看盤、13:25 掛市價，不追開盤。
      </div>
    </div>
  );
}

function Env({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-muted-foreground text-[9px] mb-0.5">{label}</div>
      <div className="text-foreground">{v}</div>
    </div>
  );
}
