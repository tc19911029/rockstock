'use client';

/**
 * BrokerReportsPanel — 首頁右側「法人報告」tab
 *
 * 仿 YoutubeStocksPanel：日期切換 + 跨券商共識折疊 + stats + 排序/篩選 pills + 卡片清單。
 * 資料源 /api/broker/performance?date=：每份報告後 N 日漲跌幅 + 目標價達成度。
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { BrokerReportCard } from './BrokerReportCard';
import { BrokerNewsSection } from './BrokerNewsSection';
import { DatePicker, type DateMeta } from '@/components/ui/DatePicker';
import { fmtDateLabelTw } from '@/lib/dateDefaults';
import type { BrokerPerformanceResponse } from '@/app/api/broker/performance/route';
import type { BrokerStockPerformance } from '@/lib/broker/brokerPerformance';
import type { BrokerConsensusStock } from '@/lib/broker/brokerConsensus';
import type { BrokerRatingNormalized } from '@/lib/broker/types';

interface Props {
  date: string;
  onDateChange?: (date: string) => void;
  onSelectStock?: (code: string) => void;
  selectedCode?: string | null;
}

type SortKey = 'rating' | 'upside' | 'progress' | 'openReturn' | 'd1Return' | 'd5Return' | 'd10Return' | 'd20Return' | 'maxGain';
type FilterKey = 'all' | 'buy' | 'upgraded' | 'reached' | 'covered';

const RATING_RANK: Record<BrokerRatingNormalized, number> = {
  buy: 6, overweight: 5, neutral: 3, hold: 3, underweight: 2, sell: 1, other: 0,
};

function perfVal(it: BrokerStockPerformance, key: SortKey): number | null {
  if (key === 'rating') return RATING_RANK[it.rating] ?? 0;
  if (key === 'upside') return it.target.upsideAtReport;
  if (key === 'progress') return it.target.progressPct;
  return (it.performance as unknown as Record<string, number | null>)[key] ?? null;
}

export function BrokerReportsPanel({ date, onDateChange, onSelectStock, selectedCode }: Props) {
  const [data, setData] = useState<BrokerPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('rating');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [consensusOpen, setConsensusOpen] = useState(false);
  // 只在「初次載入」時，若當前日期沒報告就自動跳到最新有報告的日期（之後尊重手動切換）
  const didInitRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/broker/performance?date=${encodeURIComponent(date)}`)
      .then(r => r.json())
      .then((json: BrokerPerformanceResponse & { ok?: boolean; error?: string }) => {
        if (cancelled) return;
        if (json.error) { setError(json.error); setData(null); return; }
        setData(json);
        // 初次載入：當前日期無報告 → 跳到最新有報告日（只跳一次）
        if (!didInitRef.current) {
          didInitRef.current = true;
          if ((json.items?.length ?? 0) === 0 && json.availableDates?.length
              && json.availableDates[0] !== date && onDateChange) {
            onDateChange(json.availableDates[0]);
          }
        }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const datePickerMeta = useMemo<Record<string, DateMeta>>(() => {
    const m: Record<string, DateMeta> = {};
    (data?.availableDates ?? []).forEach(d => { m[d] = { note: '有法人報告' }; });
    return m;
  }, [data]);

  const dist = useMemo(() => {
    const c = { bull: 0, neutral: 0, bear: 0 };
    for (const it of data?.items ?? []) {
      if (it.sentiment === 'bullish') c.bull += 1;
      else if (it.sentiment === 'bearish') c.bear += 1;
      else if (it.sentiment === 'neutral') c.neutral += 1;
    }
    return c;
  }, [data]);

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    switch (filter) {
      case 'buy': return items.filter(it => it.sentiment === 'bullish');
      case 'upgraded': return items.filter(it => it.prev_target_price != null && it.target_price != null && it.target_price !== it.prev_target_price);
      case 'reached': return items.filter(it => it.target.reached);
      case 'covered': return items.filter(it => it.covered);
      default: return items;
    }
  }, [data, filter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'desc' ? 1 : -1;
    arr.sort((a, b) => {
      const va = perfVal(a, sortBy);
      const vb = perfVal(b, sortBy);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;   // null 永遠墊底
      if (vb == null) return -1;
      if (va === vb) return RATING_RANK[b.rating] - RATING_RANK[a.rating];
      return dir * (vb - va);
    });
    return arr;
  }, [filtered, sortBy, sortDir]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Date header */}
      <div className="shrink-0 px-2 py-1.5 border-b border-border bg-secondary/30 text-xs space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{date}</span>
          <span className="text-foreground/80">{fmtDateLabelTw(date)}</span>
          <span>· 法人報告</span>
          {loading && <span className="text-rose-400 animate-pulse ml-auto">載入中…</span>}
        </div>
        {onDateChange && (
          <DatePicker value={date} onChange={onDateChange} size="sm" meta={datePickerMeta} />
        )}
      </div>

      {/* 今日消息面（晨報 × 持股/法人報告）*/}
      <BrokerNewsSection onSelectStock={onSelectStock} />

      {/* 跨券商共識 */}
      {data?.consensus && data.consensus.length > 0 && (
        <BrokerConsensusSection
          consensus={data.consensus}
          date={date}
          open={consensusOpen}
          onToggle={() => setConsensusOpen(v => !v)}
        />
      )}

      {/* Stats + Filters */}
      <div className="shrink-0 px-2 py-1.5 space-y-1.5 border-b border-border/60 bg-card/40">
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="font-bold text-foreground">{data?.stats.report_count ?? 0} 份報告</span>
          <span className="text-muted-foreground text-[10px]">{data?.stats.item_count ?? 0} 檔次</span>
          {dist.bull > 0 && <span className="px-1 py-0.5 rounded text-[9px] bg-green-900/50 text-green-300">多 {dist.bull}</span>}
          {dist.neutral > 0 && <span className="px-1 py-0.5 rounded text-[9px] bg-yellow-900/40 text-yellow-300">中 {dist.neutral}</span>}
          {dist.bear > 0 && <span className="px-1 py-0.5 rounded text-[9px] bg-red-900/40 text-red-300">空 {dist.bear}</span>}
        </div>

        {/* Sort pills */}
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[9px] text-muted-foreground/70 mr-0.5">排序</span>
          {([
            { key: 'rating' as const, label: '評等' },
            { key: 'upside' as const, label: '上漲空間' },
            { key: 'progress' as const, label: '達標度' },
            { key: 'openReturn' as const, label: '漲跌·隔開' },
            { key: 'd1Return' as const, label: '漲跌·1日' },
            { key: 'd5Return' as const, label: '漲跌·5日' },
            { key: 'd10Return' as const, label: '漲跌·10日' },
            { key: 'd20Return' as const, label: '漲跌·20日' },
            { key: 'maxGain' as const, label: '漲跌·最高' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                if (sortBy === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
                else { setSortBy(key); setSortDir('desc'); }
              }}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                sortBy === key ? 'bg-rose-700 text-foreground' : 'bg-secondary text-muted-foreground'
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
            { key: 'buy' as const, label: '只看買進' },
            { key: 'upgraded' as const, label: '調目標價' },
            { key: 'reached' as const, label: '已達標' },
            { key: 'covered' as const, label: '主標的' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                filter === key ? 'bg-rose-700 text-foreground' : 'bg-secondary text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Card list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5 space-y-1.5">
        {error && (
          <div className="text-xs text-red-400 p-2 border border-red-700/40 rounded">載入失敗：{error}</div>
        )}
        {!loading && !error && (data?.items.length ?? 0) === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-2xl mb-2">🏦</p>
            <p className="text-xs text-muted-foreground mb-1">{data?.message ?? '此日無法人報告'}</p>
            <p className="text-[10px] text-muted-foreground/70">
              把券商 PDF 丟進 ~/Downloads/broker-reports/，執行 /broker-analysis 產生資料
            </p>
          </div>
        )}
        {sorted.map((item) => (
          <BrokerReportCard
            key={`${item.report_id}-${item.stock_code ?? item.raw_query}`}
            item={item}
            selected={selectedCode != null && selectedCode === item.stock_code}
            onSelect={onSelectStock}
          />
        ))}
      </div>
    </div>
  );
}

// ── 跨券商共識折疊區 ──────────────────────────────────────────────────────────
function BrokerConsensusSection({
  consensus, date, open, onToggle,
}: {
  consensus: BrokerConsensusStock[];
  date: string;
  open: boolean;
  onToggle: () => void;
}) {
  const high = consensus.filter(c => c.high_consensus);
  const multi = consensus.filter(c => !c.high_consensus && c.broker_count >= 2);
  return (
    <div className="shrink-0 border-b border-border/60 bg-secondary/20">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40 transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>🤝 {date} 跨券商共識</span>
        {high.length > 0 && (
          <span className="text-[9px] px-1 rounded bg-green-900/50 text-green-300 font-normal">高共識 {high.length}</span>
        )}
        <span className="ml-auto text-[10px] font-normal text-muted-foreground">近 5 日</span>
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1.5 text-[11px]">
          {high.length === 0 && multi.length === 0 && (
            <div className="text-muted-foreground text-[10px]">近 5 日無多家券商同向覆蓋的個股。</div>
          )}
          {[...high, ...multi].map(c => (
            <div key={c.stock_code} className="border-l-2 border-border/60 pl-2 py-0.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-foreground/90">{c.stock_code}</span>
                <span className="text-foreground/80">{c.stock_name}</span>
                {c.high_consensus && <span className="text-[9px] px-1 rounded bg-green-900/50 text-green-300">高共識</span>}
                <span className="text-[9px] text-muted-foreground ml-auto">{c.broker_count} 家</span>
              </div>
              <div className="text-[10px] text-foreground/70 mt-0.5">
                {c.bullish_brokers.length > 0 && <span className="text-bull">多: {c.bullish_brokers.join('、')}　</span>}
                {c.bearish_brokers.length > 0 && <span className="text-bear">空: {c.bearish_brokers.join('、')}　</span>}
                {c.neutral_brokers.length > 0 && <span className="text-muted-foreground">中立: {c.neutral_brokers.join('、')}</span>}
              </div>
              {c.avg_target_price != null && (
                <div className="text-[10px] text-muted-foreground">
                  平均目標價 {c.avg_target_price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                  {c.target_price_min != null && c.target_price_max != null && c.target_price_min !== c.target_price_max &&
                    `（${c.target_price_min.toLocaleString()}~${c.target_price_max.toLocaleString()}）`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
