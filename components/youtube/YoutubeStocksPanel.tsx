'use client';

/**
 * YoutubeStocksPanel — 右側面板：YouTube 介紹過的股票 + N 日漲跌追蹤
 *
 * Layout（仿 ScanPanelVertical/ScanResultsCompact）：
 *   - Date header（前一日 / 當日 / 後一日）
 *   - Stats row（檔數 + Rating 分佈）
 *   - 排序 pills（提及 / 評級 / 5日漲跌 / 20日漲跌）
 *   - 篩選 pills（全部 / A / B+）
 *   - 卡片清單（YoutubeStockCard）
 */

import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { YoutubeStockCard } from './YoutubeStockCard';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { fmtDateLabelTw } from '@/lib/dateDefaults';
import type { PerformanceResponse, PerformanceItem, ConsensusSummary } from '@/app/api/youtube/performance/route';
import { MarketRegimeFlag } from '@/components/MarketRegimeFlag';

interface Props {
  date: string;                                // 'YYYY-MM-DD'
  onDateChange?: (date: string) => void;       // 換日（更新 URL）
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

type SortKey = 'mention' | 'rating' | 'openReturn' | 'd1Return' | 'd5Return' | 'd10Return' | 'd20Return' | 'maxGain' | 'maxLoss';
type FilterKey = 'all' | 'A' | 'B+';

const RATING_ORDER: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

export function YoutubeStocksPanel({ date, onDateChange, onSelectStock, selectedCode }: Props) {
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyDates, setEmptyDates] = useState<Set<string>>(() => new Set());
  const [populatedDates, setPopulatedDates] = useState<Set<string>>(() => new Set());
  // 預設按評級排（A>B>C>D>未評），同級再按提及次數 tie-break — 對齊 deriveStockMentions 的順序
  const [sortBy, setSortBy] = useState<SortKey>('rating');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState<FilterKey>('all');
  // 跨節目共識面板（仿主頁朱老師分析的折疊樣式）— 預設收起,需要時自行展開
  const [consensusOpen, setConsensusOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/youtube/performance?date=${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((json: PerformanceResponse & { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); setData(null); return; }
        setData(json);
        // 漸進式記錄該日是否有提及資料
        if ((json.items?.length ?? 0) > 0) {
          setPopulatedDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
          setEmptyDates(prev => { if (!prev.has(date)) return prev; const n = new Set(prev); n.delete(date); return n; });
        } else {
          setEmptyDates(prev => prev.has(date) ? prev : new Set(prev).add(date));
        }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const datePickerMeta = useMemo<Record<string, DateMeta>>(() => {
    const m: Record<string, DateMeta> = {};
    emptyDates.forEach(d => { m[d] = { dim: true }; });
    populatedDates.forEach(d => { m[d] = { note: '有 YouTube 提及' }; });
    return m;
  }, [emptyDates, populatedDates]);

  const ratingDist = useMemo(() => {
    const counts = { A: 0, B: 0, C: 0, D: 0, none: 0 };
    for (const it of data?.items ?? []) {
      if (it.rating) counts[it.rating] += 1;
      else counts.none += 1;
    }
    return counts;
  }, [data]);

  // 基準日太新（連 d1 都沒有），所有 N 日漲跌都 null — 解釋為什麼欄位都是 "—"
  // 注意：status=stale 也可能有部分資料（如 d1-d4 有、d5 沒有），不算「沒資料」
  const allEmptyForward = useMemo(() => {
    const items = data?.items ?? [];
    if (items.length === 0) return false;
    return items.every(it => {
      const p = it.performance;
      return p.openReturn == null && p.d1Return == null && p.d3Return == null && p.d5Return == null;
    });
  }, [data]);

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    if (filter === 'all') return items;
    if (filter === 'A') return items.filter(it => it.rating === 'A');
    if (filter === 'B+') return items.filter(it => it.rating === 'A' || it.rating === 'B');
    return items;
  }, [data, filter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'desc' ? 1 : -1;
    arr.sort((a, b) => {
      const ar = a.rating ? RATING_ORDER[a.rating] ?? 0 : 0;
      const br = b.rating ? RATING_ORDER[b.rating] ?? 0 : 0;
      switch (sortBy) {
        case 'mention':
          // 主鍵：提及次數；同 mention 用 rating tie-break（避免 C 排在 A 上面）
          if (b.mention_count !== a.mention_count) return dir * (b.mention_count - a.mention_count);
          return dir * (br - ar);
        case 'rating':
          if (ar !== br) return dir * (br - ar);
          return dir * (b.mention_count - a.mention_count);
        case 'openReturn':
        case 'd1Return':
        case 'd5Return':
        case 'd10Return':
        case 'd20Return':
        case 'maxGain':
        case 'maxLoss': {
          const va = (a.performance as unknown as Record<string, number | null | undefined>)[sortBy];
          const vb = (b.performance as unknown as Record<string, number | null | undefined>)[sortBy];
          const aNull = va == null;
          const bNull = vb == null;
          if (aNull && bNull) return 0;
          if (aNull) return 1;
          if (bNull) return -1;
          return dir * ((vb as number) - (va as number));
        }
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, sortBy, sortDir]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Date header：pill grid（仿策略掃描）+ 當日標籤 ─── */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-secondary/30 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{date}</span>
          <span className="text-foreground/80">{fmtDateLabelTw(date)}</span>
          <span>· YouTube 提及股票</span>
          {data?.marketRegime && <MarketRegimeFlag regime={data.marketRegime} size="xs" />}
          {loading && <span className="text-sky-400 animate-pulse ml-auto">載入中…</span>}
        </div>
        {onDateChange && (
          <DatePicker value={date} onChange={onDateChange} size="sm" meta={datePickerMeta} />
        )}
      </div>

      {/* ── 跨節目共識（仿主頁朱老師分析折疊樣式）─────────────────── */}
      {data?.consensus && (
        <ConsensusSection
          consensus={data.consensus}
          date={date}
          open={consensusOpen}
          onToggle={() => setConsensusOpen(v => !v)}
        />
      )}

      {/* 基準日太新提示 — forward returns 全 null 才顯示 */}
      {allEmptyForward && (
        <div className="shrink-0 px-2 py-1 text-[10px] text-amber-400 bg-amber-950/30 border-b border-amber-900/40">
          ⚠ 基準日（{date}）後尚無交易日 K 線，N 日漲跌欄全為 — 。切到較早日期可看實際走勢。
        </div>
      )}

      {/* ── Stats + Filters ──────────────────────────────────────────── */}
      <div className="shrink-0 px-2 py-1.5 space-y-1.5 border-b border-border/60 bg-card/40">
        {/* Stats row */}
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="font-bold text-foreground">{data?.items.length ?? 0} 檔</span>
          {ratingDist.A > 0 && (
            <span className="px-1 py-0.5 rounded text-[9px] bg-green-900/50 text-green-300">A {ratingDist.A}</span>
          )}
          {ratingDist.B > 0 && (
            <span className="px-1 py-0.5 rounded text-[9px] bg-blue-900/50 text-blue-300">B {ratingDist.B}</span>
          )}
          {ratingDist.C > 0 && (
            <span className="px-1 py-0.5 rounded text-[9px] bg-yellow-900/50 text-yellow-300">C {ratingDist.C}</span>
          )}
          {ratingDist.D > 0 && (
            <span className="px-1 py-0.5 rounded text-[9px] bg-red-900/40 text-red-300">D {ratingDist.D}</span>
          )}
          {ratingDist.none > 0 && (
            <span className="px-1 py-0.5 rounded text-[9px] bg-muted/50 text-muted-foreground">未評 {ratingDist.none}</span>
          )}
        </div>

        {/* Sort pills */}
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[9px] text-muted-foreground/70 mr-0.5">排序</span>
          {([
            { key: 'mention' as const, label: '提及' },
            { key: 'rating' as const, label: '評級' },
            { key: 'openReturn' as const, label: '漲跌·隔開' },
            { key: 'd1Return' as const, label: '漲跌·1日' },
            { key: 'd5Return' as const, label: '漲跌·5日' },
            { key: 'd10Return' as const, label: '漲跌·10日' },
            { key: 'd20Return' as const, label: '漲跌·20日' },
            { key: 'maxGain' as const, label: '漲跌·最高' },
            { key: 'maxLoss' as const, label: '漲跌·最低' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                if (sortBy === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                else { setSortBy(key); setSortDir('desc'); }
              }}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                sortBy === key ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'
              }`}
            >
              {label}{sortBy === key && <span className="ml-0.5">{sortDir === 'desc' ? '▼' : '▲'}</span>}
            </button>
          ))}
        </div>

        {/* Filter pills */}
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[9px] text-muted-foreground/70 mr-0.5">篩選</span>
          {([
            { key: 'all' as const, label: '全部' },
            { key: 'A' as const, label: '只看 A' },
            { key: 'B+' as const, label: 'B+ 以上' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                filter === key ? 'bg-sky-700 text-foreground' : 'bg-secondary text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Card list ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5 space-y-1.5">
        {error && (
          <div className="text-xs text-red-400 p-2 border border-red-700/40 rounded">
            載入失敗：{error}
          </div>
        )}
        {!loading && !error && (data?.items.length ?? 0) === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-2xl mb-2">📺</p>
            <p className="text-xs text-muted-foreground mb-1">此日無 YouTube 提及紀錄</p>
            <p className="text-[10px] text-muted-foreground/70">
              請用上方日期切換到有資料的日期（當日分析通常於晚間產生）
            </p>
          </div>
        )}
        {sorted.map((item: PerformanceItem) => (
          <YoutubeStockCard
            key={item.stock_code}
            item={item}
            selected={selectedCode === item.stock_code}
            onSelect={onSelectStock}
          />
        ))}
      </div>
    </div>
  );
}

// ── 跨節目共識折疊區 ─────────────────────────────────────────────────────────
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  } catch { return iso; }
}

function ConsensusSection({
  consensus,
  date,
  open,
  onToggle,
}: {
  consensus: ConsensusSummary;
  date: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 bg-secondary/20">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40 transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>📊 {date} 跨節目共識</span>
        {consensus.is_placeholder && (
          <span className="text-[9px] text-yellow-400 font-normal" title="尚未跑真實分析，這是手動填的範例資料">示範資料</span>
        )}
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">
          更新於 {fmtTime(consensus.generated_at)}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-2 text-[11px]">
          {consensus.is_placeholder && (
            <div className="rounded border border-yellow-700/60 bg-yellow-900/20 px-2 py-1 text-[10px] text-yellow-200">
              ⚠ 手動填的示範資料，請用 /youtube-analysis 寫真實版覆蓋
            </div>
          )}
          {consensus.market_view && (
            <div className="whitespace-pre-wrap leading-relaxed text-foreground/90">
              {consensus.market_view}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2">
            <div>
              <div className="text-bull font-medium mb-0.5">看多共識</div>
              {consensus.bullish_consensus.length === 0
                ? <div className="text-muted-foreground">—</div>
                : <ul className="list-disc list-inside text-foreground/80 space-y-0.5 marker:text-bull/60">
                    {consensus.bullish_consensus.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
              }
            </div>
            <div>
              <div className="text-bear font-medium mb-0.5">風險提醒</div>
              {consensus.bearish_consensus.length === 0
                ? <div className="text-muted-foreground">—</div>
                : <ul className="list-disc list-inside text-foreground/80 space-y-0.5 marker:text-bear/60">
                    {consensus.bearish_consensus.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
              }
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground border-t border-border/40 pt-1">
            分析了 {consensus.stats.videos_analyzed} 支影片 · 高共識股 {consensus.stats.high_consensus_count} · 弱信號股 {consensus.stats.weak_signal_count}
          </div>
        </div>
      )}
    </div>
  );
}
