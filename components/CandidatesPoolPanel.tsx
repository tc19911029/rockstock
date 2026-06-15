'use client';

/**
 * CandidatesPoolPanel — 首頁右側「候選池」tab 內容
 *
 * 簡化版（vs /agents/pool 整頁）：
 *   - 日期切換
 *   - minSourceCount 篩選（≥1/2/3/4 源）
 *   - 候選列表（symbol/name/sources chip + ★ 高共識 + 簡短 reasons）
 *   - 點任一檔 → onSelectStock(symbol) 觸發左側 K 線跳轉
 *
 * 不做的事：
 *   - 不顯示 Source 狀態大卡（首頁右側空間有限）
 *   - 不顯示多源分布長條（/agents/pool 才需要）
 *   - 不提供「建立 Pool」按鈕（首頁是看結果，要建請去 /agents/pool）
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Candidate, SourceName } from '@/lib/agents/candidates/types';
import type { StockForwardPerformance } from '@/lib/scanner/types';
import {
  POOL_WEIGHTS,
  computeFacetScores,
} from '@/lib/agents/candidates/poolWeights';
import { SPEC_STOCK_TYPE_LABEL, SPEC_DIM_LABEL, COMBO_BADGE_LABEL } from '@/lib/spec-score/weights';
import { lastBusinessDayYmd, fmtDateLabelTw } from '@/lib/dateDefaults';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { formatLetters } from '@/lib/scanner/buyMethodTracks';
import { signalOf } from '@/lib/i18n/fundamentalLabels';
import { ForwardPerfRow } from '@/features/scan/components/ForwardPerfRow';
import { EntryStateBadge } from '@/components/EntryStateBadge';
import { MarketRegimeFlag } from '@/components/MarketRegimeFlag';
import type { RegimeDetectResult } from '@/lib/agents/marketRegime';
import { useYouTubeMentionMap, type YouTubeMentionSummary } from '@/lib/hooks/useYouTubeMentionMap';
import { YouTubeMentionBadge, resonanceTags } from '@/components/youtube/YouTubeMentionBadge';
import { RedFlagChips } from '@/components/RedFlagChips';
import { SortControl } from '@/components/shared';
import { applySort, type SortValue } from '@/lib/sorting/sortEngine';
import type { SortDir } from '@/lib/sorting/registry';

interface PoolResponse {
  ok: boolean;
  date: string;
  market: string;
  exists: boolean;
  generatedAt?: string;
  total?: number;
  returned?: number;
  candidates?: Candidate[];
  marketRegime?: RegimeDetectResult;
  error?: string;
}

interface BacktestStateStat { n: number; winRate: number; avgReturn: number; avgMaxDD: number; rdRatio: number; }
interface BacktestSummary {
  generatedAt?: string;
  range?: { from: string; to: string; days: number };
  sampleCount?: number;
  byState?: { can_enter?: BacktestStateStat; watch?: BacktestStateStat; no_chase?: BacktestStateStat };
}

interface Props {
  /** 點任一檔股 → 觸發左側 K 線跳轉 */
  onSelectStock?: (symbol: string) => void;
  /** 預設 date（首頁 today；可由 URL 控制）*/
  defaultDate?: string;
  /** 目前選中股票（match candidate.symbol）— 用於 row highlight */
  selectedSymbol?: string | null;
  /** 日期變動時通知 parent（用於 3 tab date sync）*/
  onDateChange?: (date: string) => void;
}

const SOURCE_LABEL: Record<SourceName, string> = {
  technical: '技',
  youtube: '消',
  chip: '籌',
  fundamental: '基',
};

const SOURCE_COLOR: Record<SourceName, string> = {
  technical:   'bg-blue-700/40 text-blue-300 border-blue-500/50',
  youtube:     'bg-purple-700/40 text-purple-300 border-purple-500/50',
  chip:        'bg-orange-700/40 text-orange-300 border-orange-500/50',
  fundamental: 'bg-teal-700/40 text-teal-300 border-teal-500/50',
};

// 去市場後綴拿裸代號（YouTube 提及 map 以裸代號為 key）
const bareCode = (s: string) => s.replace(/\.(TW|TWO|SS|SZ)$/i, '');

// 此面板提供的排序選項（id 走 lib/sorting/registry 中央清單；順序＝顯示順序）
// 此頁專屬（加權總分 / YouTube 提及）｜共用區（fwd.*；無 mkt.* 盤面欄資料）
const POOL_SORT_OPTIONS = [
  'score.poolTotal', 'heat.youtube',
  '|',
  'fwd.open', 'fwd.d1', 'fwd.d5', 'fwd.d10', 'fwd.d20', 'fwd.maxGain', 'fwd.maxLoss',
];
// 前瞻報酬 id → StockForwardPerformance 欄位名（accessor 用）
const POOL_FWD_FIELD: Record<string, keyof StockForwardPerformance> = {
  'fwd.open': 'openReturn', 'fwd.d1': 'd1Return', 'fwd.d5': 'd5Return',
  'fwd.d10': 'd10Return', 'fwd.d20': 'd20Return', 'fwd.maxGain': 'maxGain', 'fwd.maxLoss': 'maxLoss',
};

export function CandidatesPoolPanel({ onSelectStock, defaultDate, selectedSymbol, onDateChange }: Props) {
  const [date, setDateLocal] = useState(defaultDate ?? lastBusinessDayYmd());
  const setDate = useCallback((d: string) => {
    setDateLocal(d);
    onDateChange?.(d);
  }, [onDateChange]);
  // YouTube 提及 map（截至候選池當日）— 純展示 join，不進選股分數/排序
  const { map: ytMap } = useYouTubeMentionMap(date);
  const [minSourceCount, setMinSourceCount] = useState(1);  // 預設 ≥1 面向：一開就看得到候選（共享常數仍 = 3、見合約測試，故不動它）
  // 排序維度：加權總分（預設）或漲跌幅（forward perf 各日 / 區間最高最低）或 YouTube 提及數
  // id 走 lib/sorting/registry 中央清單；缺值/升降序由 sortEngine 統一處理
  const [sortBy, setSortBy] = useState<string>('score.poolTotal');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // YouTube display-layer 篩選（不改候選池資料/分數）
  const [ytRecentOnly, setYtRecentOnly] = useState(false);
  const [highConsensusOnly, setHighConsensusOnly] = useState(false);
  // 權重 popover 開關 + 自訂權重（存 localStorage，只覆蓋 client display 排序）
  const [showWeights, setShowWeights] = useState(false);
  const [customWeights, setCustomWeights] = useState<typeof POOL_WEIGHTS>(() => {
    if (typeof window === 'undefined') return POOL_WEIGHTS;
    try {
      const raw = localStorage.getItem('poolCustomWeights');
      if (!raw) return POOL_WEIGHTS;
      const parsed = JSON.parse(raw);
      // 防呆：keys 對齊
      if (
        typeof parsed?.technical === 'number' && typeof parsed?.youtube === 'number' &&
        typeof parsed?.chip === 'number' && typeof parsed?.fundamental === 'number'
      ) return parsed;
    } catch { /* ignore */ }
    return POOL_WEIGHTS;
  });
  const persistWeights = useCallback((w: typeof POOL_WEIGHTS) => {
    setCustomWeights(w);
    try { localStorage.setItem('poolCustomWeights', JSON.stringify(w)); } catch { /* ignore */ }
  }, []);
  const resetWeights = useCallback(() => {
    setCustomWeights(POOL_WEIGHTS);
    try { localStorage.removeItem('poolCustomWeights'); } catch { /* ignore */ }
  }, []);
  const [data, setData] = useState<PoolResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // forward perf — 跟策略掃描走同 endpoint(POST /api/backtest/forward,有 10min cache)
  const [forwardMap, setForwardMap] = useState<Map<string, StockForwardPerformance>>(new Map());
  const [isFetchingForward, setIsFetchingForward] = useState(false);
  const forwardAbortRef = useRef<AbortController | null>(null);
  // 已知無資料的日期 — 漸進式 dim DatePicker pill
  const [emptyDates, setEmptyDates] = useState<Set<string>>(() => new Set());
  const [populatedDates, setPopulatedDates] = useState<Set<string>>(() => new Set());

  // backtest 歷史勝率 — 全局 stat，跟日期無關，fetch 一次就好
  const [backtest, setBacktest] = useState<BacktestSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agents/backtest-summary')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { ok?: boolean } & BacktestSummary) => {
        if (!cancelled && j.ok !== false) setBacktest(j);
      })
      .catch(() => { /* backtest 不是 critical，失敗就不顯示 */ });
    return () => { cancelled = true; };
  }, []);

  // AbortController + 15s timeout 防卡載入中（user 快速切日期或 server hang）
  const abortRef = useRef<AbortController | null>(null);
  const fetchPool = useCallback(async () => {
    // 取消上一筆 in-flight fetch
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const timeoutId = setTimeout(() => ac.abort(), 15_000);

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        // B3：先 ≥N 共識過濾，再用 totalScore 加權排序（POOL_WEIGHTS single source of truth）
        `/api/agents/pool?date=${date}&minSourceCount=${minSourceCount}&limit=100&sort=weighted`,
        { signal: ac.signal },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as PoolResponse;
      if (ac.signal.aborted) return;  // 被新 fetch 取代，don't update state
      setData(json);
      // 漸進式記錄該日是否有資料 — DatePicker 用來 dim 空日 pill
      if (json.exists) {
        setPopulatedDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
        setEmptyDates(prev => { if (!prev.has(date)) return prev; const n = new Set(prev); n.delete(date); return n; });
      } else {
        setEmptyDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
      }
    } catch (err) {
      if (ac.signal.aborted) return;  // 取消的不算錯，不更新 state（避免 race）
      setData(null);
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      clearTimeout(timeoutId);
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [date, minSourceCount]);

  const datePickerMeta = useMemo<Record<string, DateMeta>>(() => {
    const m: Record<string, DateMeta> = {};
    emptyDates.forEach(d => { m[d] = { dim: true }; });
    populatedDates.forEach(d => { m[d] = { note: '有候選池' }; });
    return m;
  }, [emptyDates, populatedDates]);

  // B3 第二層：用 customWeights 算 totalScore + 排序（client display）
  // server 已用 POOL_WEIGHTS default 排序，沒改 weights 時不會雙排，加 score 顯示即可
  const sortedCandidates = useMemo(() => {
    if (!data?.candidates) return [];
    let withScores = data.candidates.map(c => {
      const base = computeFacetScores(c);
      const customTotal = Math.round(
        base.technical * customWeights.technical +
        base.news * customWeights.youtube +
        base.chip * customWeights.chip +
        base.fundamental * customWeights.fundamental,
      );
      return { ...c, scores: { ...base, total: customTotal } };
    });
    // display-layer 篩選（不改候選池資料/分數）
    if (ytRecentOnly) {
      withScores = withScores.filter(c => (ytMap.get(bareCode(c.symbol))?.count7d ?? 0) > 0);
    }
    if (highConsensusOnly) {
      withScores = withScores.filter(c => c.sources.youtube?.inHighConsensus === true);
    }
    // 先按加權總分 desc 當「基底序」— 既是 score.poolTotal 的排序本身，
    // 也是其他排序（前瞻報酬/YouTube 提及）同值時的 tie-break（applySort 穩定，保留基底序）
    type Scored = (typeof withScores)[number];
    const baseSorted: Scored[] = [...withScores].sort((a, b) => b.scores.total - a.scores.total);
    if (sortBy === 'score.poolTotal') return baseSorted;
    // 排序值取法（id 走中央清單；缺值/升降序由 sortEngine 統一處理）
    const poolSortValue = (c: Scored, id: string): SortValue => {
      const fk = POOL_FWD_FIELD[id];
      if (fk) return (forwardMap.get(c.symbol)?.[fk] as number | null | undefined) ?? null;
      if (id === 'heat.youtube') {
        // YouTube 提及：近 30 天提及次數；未提及回 null 排最後
        return ytMap.get(bareCode(c.symbol))?.count30d ?? null;
      }
      return null;
    };
    return applySort(baseSorted, sortBy, sortDir, poolSortValue);
  }, [data?.candidates, customWeights, sortBy, sortDir, forwardMap, ytMap, ytRecentOnly, highConsensusOnly]);

  // ⚡ 今日強進場 top 5 — entry_state 不是 no_chase + sourceCount ≥ 2 + score ≥ 50 + 大盤 ≠ bear
  // 排序：can_enter 優先於 watch，內部按 score
  const topPicks = useMemo(() => {
    if (!data?.marketRegime || data.marketRegime.regime === 'bear') return [];
    const eligible = sortedCandidates.filter(c =>
      c.entryGate &&
      c.entryGate.state !== 'no_chase' &&
      c.sourceCount >= 2 &&
      c.scores.total >= 50,
    );
    const stateOrder: Record<string, number> = { can_enter: 0, watch: 1, no_chase: 2 };
    return [...eligible].sort((a, b) => {
      const sa = stateOrder[a.entryGate!.state] ?? 9;
      const sb = stateOrder[b.entryGate!.state] ?? 9;
      if (sa !== sb) return sa - sb;
      return b.scores.total - a.scores.total;
    }).slice(0, 5);
  }, [sortedCandidates, data?.marketRegime]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

  // 拿到 candidates 後 POST forward,渲染後續漲跌幅 row
  // — 對齊策略掃描 UX:卡片先 render,forward 數字 lazy 填上(loading 期間顯示「…」)
  useEffect(() => {
    if (!data?.candidates || data.candidates.length === 0) {
      setForwardMap(new Map());
      return;
    }
    const stocks = data.candidates
      .filter((c): c is Candidate & { lastClose: number } => typeof c.lastClose === 'number')
      .map(c => ({ symbol: c.symbol, name: c.name, scanPrice: c.lastClose }));
    if (stocks.length === 0) {
      setForwardMap(new Map());
      return;
    }
    forwardAbortRef.current?.abort();
    const ac = new AbortController();
    forwardAbortRef.current = ac;
    setIsFetchingForward(true);
    fetch('/api/backtest/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanDate: date, stocks }),
      signal: ac.signal,
    })
      .then(r => r.ok ? r.json() as Promise<{ performance?: StockForwardPerformance[] }> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        if (ac.signal.aborted) return;
        const map = new Map<string, StockForwardPerformance>();
        for (const p of j.performance ?? []) map.set(p.symbol, p);
        setForwardMap(map);
      })
      .catch(() => { /* abort / network fail — 留空就好,UI 顯示 — */ })
      .finally(() => { if (!ac.signal.aborted) setIsFetchingForward(false); });
  }, [data, date]);

  const buildPool = useCallback(async () => {
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/pool/build?date=${date}`, { method: 'POST' });
      const json = await res.json() as { ok?: boolean; error?: string; total?: number; elapsedMs?: number };
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
      } else {
        setBanner(`✅ 已建立 ${json.total} 檔候選 (${json.elapsedMs}ms)`);
        await fetchPool();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'build failed');
    } finally {
      setBusy(false);
    }
  }, [date, fetchPool]);

  return (
    <div className="flex flex-col h-full">
      {/* Date pill grid（仿策略掃描）*/}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-card/40">
        <DatePicker value={date} onChange={setDate} size="sm" meta={datePickerMeta} />
      </div>
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border bg-secondary/20 text-xs relative">
        <label className="text-muted-foreground flex items-center gap-1">
          ≥
          <select
            value={minSourceCount}
            onChange={(e) => setMinSourceCount(Number(e.target.value))}
            className="bg-card ring-1 ring-foreground/10 rounded px-1.5 py-0.5 text-[11px]"
            title="只看至少這幾個面向同時看好的股票"
          >
            <option value={1}>1 個面向</option>
            <option value={2}>2 個面向</option>
            <option value={3}>3 個面向</option>
            <option value={4}>4 個面向</option>
          </select>
        </label>
        <SortControl
          options={POOL_SORT_OPTIONS}
          value={sortBy}
          dir={sortDir}
          onChange={(id, d) => { setSortBy(id); setSortDir(d); }}
          size="normal"
        />
        <button
          type="button"
          onClick={() => setShowWeights(v => !v)}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-700/40 text-violet-200 hover:bg-violet-600/60"
          title="調整 4 面向加權（影響排序，存本機）"
        >
          權重 ⚙
        </button>
        {showWeights && (
          <WeightPopover
            weights={customWeights}
            defaults={POOL_WEIGHTS}
            onChange={persistWeights}
            onReset={resetWeights}
            onClose={() => setShowWeights(false)}
          />
        )}
        <button
          type="button"
          onClick={() => setYtRecentOnly(v => !v)}
          title="只看近 7 天有被 YouTube 理財節目提及的候選"
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ytRecentOnly ? 'bg-purple-700 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted/60'}`}
        >
          近7天提及
        </button>
        <button
          type="button"
          onClick={() => setHighConsensusOnly(v => !v)}
          title="只看 YouTube 高共識（≥2 節目同向）的候選"
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${highConsensusOnly ? 'bg-purple-700 text-foreground' : 'bg-secondary text-muted-foreground hover:bg-muted/60'}`}
        >
          ★ 高共識
        </button>
        <div className="flex-1" />
        {data?.marketRegime && <MarketRegimeFlag regime={data.marketRegime} size="xs" />}
        <span
          className="text-muted-foreground tabular-nums"
          title={data?.exists ? `顯示 ${data.returned} 檔／全部 ${data.total} 檔（受「≥ N 個面向」與每頁上限影響）` : '此日尚未建立候選池'}
        >
          {data?.exists ? `顯示 ${data.returned}／全部 ${data.total}` : '—'}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !data && !error && (
          <div className="text-center py-12 text-muted-foreground text-xs">載入中…</div>
        )}

        {error && (
          <div className="px-3 py-6 text-center text-xs text-rose-300 space-y-2">
            <div>載入候選池失敗：{error}</div>
            <button
              type="button"
              onClick={fetchPool}
              className="text-sky-400 hover:underline"
            >
              重試 ↻
            </button>
          </div>
        )}

        {banner && (
          <div className="mx-2 mt-2 border border-sky-500/40 bg-sky-500/10 text-sky-300 rounded p-2 text-[10px] leading-relaxed">
            {banner}
          </div>
        )}

        {data && !data.exists && !error && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground space-y-3">
            <div>此日尚未建立候選池</div>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={buildPool}
                disabled={busy}
                className="bg-sky-500 hover:bg-sky-400 text-white px-3 py-1.5 rounded text-xs font-medium transition disabled:opacity-50"
              >
                {busy ? '建立中…' : '⚡ 建立候選池'}
              </button>
              <Link
                href={`/agents/pool?date=${date}`}
                className="text-sky-400 hover:underline text-[10px]"
              >
                或開啟完整候選池頁 →
              </Link>
            </div>
          </div>
        )}

        {data?.exists && (data.candidates?.length ?? 0) === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            ≥{minSourceCount} 個面向無候選。試試 ≥1 個面向。
          </div>
        )}

        {data?.exists && topPicks.length > 0 && (
          <div className="border-b border-amber-700/30 bg-gradient-to-b from-amber-950/30 to-transparent">
            <div className="px-2 py-1.5 flex items-center gap-2 border-b border-amber-700/20 flex-wrap">
              <span className="text-xs font-bold text-amber-200">⚡ 今日強進場 top {topPicks.length}</span>
              <span className="text-[10px] text-amber-200/70">
                (排除「不可追」+ ≥2 面向 + 總分 ≥50)
              </span>
              <div className="flex-1" />
              {backtest?.byState && (
                <span
                  className="text-[10px] text-amber-200/90 cursor-help"
                  title={`過去 ${backtest.range?.days ?? '?'} 天 scan (${backtest.range?.from} → ${backtest.range?.to}), 共 ${backtest.sampleCount} 筆 5-day forward 樣本。\n勝率 = forward 5 日為正報酬比例。R/DD = 平均報酬 ÷ 平均最大回撤。`}
                >
                  📈 過去 {backtest.range?.days ?? '?'} 天歷史勝率：
                  <span className="text-emerald-300 font-mono ml-1">✓{((backtest.byState.can_enter?.winRate ?? 0) * 100).toFixed(0)}%</span>
                  <span className="text-slate-300 font-mono ml-1">·{((backtest.byState.watch?.winRate ?? 0) * 100).toFixed(0)}%</span>
                  <span className="text-rose-300 font-mono ml-1">✕{((backtest.byState.no_chase?.winRate ?? 0) * 100).toFixed(0)}%</span>
                </span>
              )}
              <span className="text-[10px] text-muted-foreground">點任一檔 → 載走圖</span>
            </div>
            <div className="divide-y divide-amber-900/20">
              {topPicks.map((c, idx) => {
                const pure = c.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                const gate = c.entryGate!;
                const stat = backtest?.byState?.[gate.state];
                const winRateLabel = stat
                  ? `${(stat.winRate * 100).toFixed(0)}% (n=${stat.n})`
                  : null;
                return (
                  <button
                    key={c.symbol}
                    type="button"
                    onClick={() => onSelectStock?.(c.symbol)}
                    className="w-full px-2 py-1.5 flex items-center gap-2 hover:bg-amber-950/30 transition-colors text-left"
                    title={stat
                      ? `${c.name}\n\n過去 ${backtest!.range?.days ?? '?'} 天歷史「${gate.state === 'can_enter' ? '可進' : gate.state === 'watch' ? '觀望' : '不可追'}」訊號：\n  • 勝率 ${(stat.winRate * 100).toFixed(1)}% (n=${stat.n})\n  • 平均 5 日 R: ${stat.avgReturn >= 0 ? '+' : ''}${(stat.avgReturn * 100).toFixed(1)}%\n  • 平均 maxDD: ${(stat.avgMaxDD * 100).toFixed(1)}%\n  • R/DD ratio: ${stat.rdRatio.toFixed(2)}`
                      : undefined}
                  >
                    <span className="font-mono text-[10px] w-5 text-amber-300/80">#{idx + 1}</span>
                    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{pure}</span>
                    <span className="text-xs font-medium text-foreground truncate max-w-[100px]">{c.name}</span>
                    <EntryStateBadge gate={gate} size="xs" />
                    <span
                      className={`text-[10px] px-1 rounded border ${
                        c.scores.total >= 70 ? 'bg-emerald-900/40 text-emerald-200 border-emerald-700'
                        : 'bg-amber-900/40 text-amber-200 border-amber-700'
                      }`}
                      title="4 面向加權總分"
                    >
                      {c.scores.total}
                    </span>
                    <div className="flex gap-0.5 flex-wrap">
                      {(Object.keys(c.sources) as SourceName[]).map(s => (
                        <span
                          key={s}
                          className={`inline-flex items-center px-1 rounded border text-[9px] ${SOURCE_COLOR[s]}`}
                        >
                          {SOURCE_LABEL[s]}
                        </span>
                      ))}
                    </div>
                    <div className="flex-1" />
                    {winRateLabel && (
                      <span
                        className={`text-[9px] font-mono ${
                          gate.state === 'can_enter' ? 'text-emerald-300'
                          : gate.state === 'watch' ? 'text-slate-300'
                          : 'text-rose-300'
                        }`}
                        title="同 entry_state 歷史勝率"
                      >
                        歷史 {winRateLabel}
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={gate.reasons.join('｜')}>
                      {gate.reasons[0]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {data?.exists && data.candidates && data.candidates.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card z-10 text-muted-foreground border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">股票</th>
                <th className="px-1 py-1.5 text-center font-medium" title="幾個面向同時看好">面向</th>
                <th className="px-1 py-1.5 text-center font-medium" title="4 面向加權總分（受權重 popover 設定影響）">總分</th>
                <th className="px-1 py-1.5 text-center font-medium" title="規格書 4 套類型權重總分（顯示層參考，不影響排序；hover 看維度明細與覆蓋率）">規格</th>
                <th className="px-1 py-1.5 text-center font-medium" title="進場時機（書本規則：連 2 漲停 / 月線乖離>15% / 末升段 → 不可追；回測 MA5 不破 → 可進；其他觀望）">時機</th>
                <th className="px-1 py-1.5 text-left font-medium">命中</th>
                <th className="px-2 py-1.5 text-left font-medium">理由</th>
              </tr>
            </thead>
            <tbody>
              {sortedCandidates.map((c) => (
                <PoolRow
                  key={c.symbol}
                  candidate={c}
                  totalScore={c.scores.total}
                  performance={forwardMap.get(c.symbol)}
                  isFetchingForward={isFetchingForward}
                  onSelect={onSelectStock}
                  selected={selectedSymbol === c.symbol}
                  ytSummary={ytMap.get(bareCode(c.symbol))}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PoolRow({
  candidate,
  totalScore,
  performance,
  isFetchingForward,
  onSelect,
  selected,
  ytSummary,
}: {
  candidate: Candidate;
  totalScore?: number;
  performance?: StockForwardPerformance;
  isFetchingForward?: boolean;
  onSelect?: (symbol: string) => void;
  selected?: boolean;
  ytSummary?: YouTubeMentionSummary;
}) {
  const pureSymbol = candidate.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  const ytResonance = resonanceTags(ytSummary);
  const reasons: string[] = [];
  const t = candidate.sources.technical;
  if (t) reasons.push(`技 ${t.tracks.length > 0 ? formatLetters(t.tracks) + '｜' : ''}六條件 ${t.sixConditionsScore}/6`);
  const y = candidate.sources.youtube;
  if (y) reasons.push(`消 ${y.mentionCount} 節目${y.inHighConsensus ? '｜★高共識' : ''}`);
  // 跨日提及（近 7/30 天）— 純展示
  if (ytSummary && ytSummary.count30d > 0) {
    reasons.push(`近7天 ${ytSummary.count7d}次·近30天 ${ytSummary.count30d}次${ytSummary.lastDate ? `（最近 ${ytSummary.lastDate}）` : ''}`);
  }
  const ch = candidate.sources.chip;
  if (ch && ch.signals.length > 0) reasons.push(`籌 ${signalOf(ch.signals[0])}`);
  const f = candidate.sources.fundamental;
  if (f && f.signals.length > 0) reasons.push(`基 ${signalOf(f.signals[0])}`);

  const hoverClass = `hover:bg-muted/40 cursor-pointer transition-colors ${
    selected ? 'bg-sky-500/15' : ''
  }`;

  return (
    <Fragment>
      <tr
        className={hoverClass}
        onClick={() => onSelect?.(candidate.symbol)}
        title={reasons.length > 0 ? reasons.join('\n') : `${candidate.name}（${candidate.industry ?? '—'}）`}
      >
        <td className="px-2 pt-1.5 pb-0.5">
          <div className="text-foreground font-medium truncate max-w-[110px]">{candidate.name}</div>
          <div className="font-mono tabular-nums text-[10px] text-muted-foreground">{pureSymbol}</div>
        </td>
        <td className="px-1 pt-1.5 pb-0.5 text-center font-mono font-semibold text-foreground">
          {candidate.sourceCount}
        </td>
        <td className="px-1 pt-1.5 pb-0.5 text-center font-mono font-semibold">
          {totalScore != null ? (
            <span className={
              totalScore >= 70 ? 'text-emerald-300'
              : totalScore >= 50 ? 'text-amber-300'
              : 'text-rose-300'
            }>{totalScore}</span>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-1 pt-1.5 pb-0.5 text-center font-mono">
          {candidate.specScore?.total != null ? (
            <span
              className={
                candidate.specScore.total >= 70 ? 'text-violet-300'
                : candidate.specScore.total >= 50 ? 'text-violet-400/80'
                : 'text-muted-foreground'
              }
              title={[
                `規格分 ${candidate.specScore.total}（${SPEC_STOCK_TYPE_LABEL[candidate.specScore.stockType]}權重·覆蓋 ${Math.round(candidate.specScore.coverage * 100)}%）`,
                ...candidate.specScore.dims
                  .filter(d => d.score != null)
                  .map(d => `  ${SPEC_DIM_LABEL[d.dim] ?? d.dim} ${d.score}（w${d.weight}）${d.note ? `· ${d.note}` : ''}`),
              ].join('\n')}
            >
              {candidate.specScore.total}
              {candidate.specScore.coverage < 0.6 && <span className="text-[9px] text-muted-foreground">*</span>}
            </span>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-1 pt-1.5 pb-0.5 text-center">
          {candidate.entryGate
            ? <EntryStateBadge gate={candidate.entryGate} size="xs" />
            : <span className="text-muted-foreground text-[10px]">—</span>}
        </td>
        <td className="px-1 pt-1.5 pb-0.5">
          <div className="flex gap-0.5 flex-wrap">
            {(Object.keys(candidate.sources) as SourceName[]).map((s) => {
              const youtubeHighConsensus = s === 'youtube' && candidate.sources.youtube?.inHighConsensus === true;
              return (
                <span
                  key={s}
                  title={youtubeHighConsensus
                    ? `高共識：${candidate.sources.youtube?.mentionCount} 節目同向`
                    : undefined}
                  className={`inline-flex items-center px-1 py-0.5 rounded border text-[10px] ${
                    youtubeHighConsensus
                      ? 'bg-purple-500/50 text-purple-100 border-purple-300 font-semibold'
                      : SOURCE_COLOR[s]
                  }`}
                >
                  {youtubeHighConsensus && <span className="mr-0.5">★</span>}
                  {SOURCE_LABEL[s]}
                </span>
              );
            })}
            {ytSummary && <YouTubeMentionBadge summary={ytSummary} bareCode={pureSymbol} size="xs" />}
            {candidate.comboBadges?.map(b => (
              <span
                key={b}
                title="組合徽章：純標示不加分（「不加組合 bonus」決議）"
                className="inline-flex items-center px-1 py-0.5 rounded border text-[9px] bg-rose-900/40 text-rose-200 border-rose-700"
              >
                {COMBO_BADGE_LABEL[b] ?? b}
              </span>
            ))}
            <RedFlagChips flags={candidate.redFlags} />
          </div>
        </td>
        <td className="px-2 pt-1.5 pb-0.5 text-[10px] text-muted-foreground">
          {ytResonance.length > 0 && (
            <div className="flex flex-wrap gap-0.5 mb-0.5">
              {ytResonance.map((tag, i) => (
                <span key={i} title={tag.title} className={`px-1 rounded border text-[9px] ${tag.cls}`}>{tag.label}</span>
              ))}
            </div>
          )}
          <div className="space-y-0.5">
            {reasons.map((r, i) => <div key={i}>{r}</div>)}
          </div>
        </td>
      </tr>
      {/* 後續漲跌幅 — 對齊策略掃描卡片 row 4 */}
      <tr
        className={`border-b border-border/40 ${hoverClass}`}
        onClick={() => onSelect?.(candidate.symbol)}
      >
        <td colSpan={7} className="px-2 pb-1.5 pt-0">
          <ForwardPerfRow performance={performance} isFetching={isFetchingForward} />
        </td>
      </tr>
    </Fragment>
  );
}

// 4 面向權重 popover — user 可即時調整、存 localStorage、影響 client display 排序
function WeightPopover({
  weights, defaults, onChange, onReset, onClose,
}: {
  weights: typeof POOL_WEIGHTS;
  defaults: typeof POOL_WEIGHTS;
  onChange: (w: typeof POOL_WEIGHTS) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const sum = weights.technical + weights.youtube + weights.chip + weights.fundamental;
  const normalized = Math.abs(sum - 1.0) < 0.01;
  const setOne = (k: keyof typeof POOL_WEIGHTS, v: number) => {
    onChange({ ...weights, [k]: v });
  };
  return (
    <div
      className="absolute top-full left-0 mt-1 z-50 w-72 bg-card ring-1 ring-foreground/10 rounded-xl shadow-xl p-3 space-y-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-foreground">4 面向加權（client 排序）</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="關閉">✕</button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        調整後即時重排候選列表。權重存本機 localStorage、不會覆蓋伺服器排序。
      </p>
      {(['technical', 'youtube', 'chip', 'fundamental'] as const).map((k) => {
        const label = k === 'technical' ? '技術' : k === 'youtube' ? '消息' : k === 'chip' ? '籌碼' : '基本';
        return (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className="w-10 text-muted-foreground">{label}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(weights[k] * 100)}
              onChange={(e) => setOne(k, Number(e.target.value) / 100)}
              className="flex-1 accent-violet-500"
            />
            <span className="w-12 text-right font-mono tabular-nums">
              {(weights[k] * 100).toFixed(0)}%
            </span>
          </div>
        );
      })}
      <div className="flex items-center justify-between text-[10px] border-t border-border pt-2 gap-1.5 flex-wrap">
        <span className={normalized ? 'text-emerald-300' : 'text-amber-300'}>
          總和：{(sum * 100).toFixed(0)}%
          {!normalized && '（建議 = 100%）'}
        </span>
        <div className="flex items-center gap-1">
          {!normalized && sum > 0 && (
            <button
              onClick={() => {
                // 等比 normalize 到 100% — 不變方向、只改絕對數值
                const factor = 1.0 / sum;
                onChange({
                  technical:   weights.technical * factor,
                  youtube:     weights.youtube * factor,
                  chip:        weights.chip * factor,
                  fundamental: weights.fundamental * factor,
                });
              }}
              className="px-2 py-0.5 rounded text-[10px] bg-violet-600 hover:bg-violet-500 text-white font-bold"
              title={`現在 4 個權重比例不變、等比放大到總和=100%（${(sum * 100).toFixed(0)}% → 100%）`}
            >
              ⚡ 一鍵 100%
            </button>
          )}
          <button
            onClick={onReset}
            className="px-2 py-0.5 rounded text-[10px] bg-secondary hover:bg-muted text-muted-foreground"
            title={`恢復預設：技 ${defaults.technical * 100}% / 消 ${defaults.youtube * 100}% / 籌 ${defaults.chip * 100}% / 基 ${defaults.fundamental * 100}%`}
          >
            恢復預設
          </button>
        </div>
      </div>
    </div>
  );
}
