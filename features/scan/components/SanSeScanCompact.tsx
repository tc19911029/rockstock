'use client';

// 三色資金（陸股自創策略）掃描側欄 — 首頁右側 panel 版。
// 與 /cn-sanse 頁共用同一支 /api/cn-sanse/scan + scanStorage；這裡只負責「掃描清單」，
// 走圖交給首頁主圖 Tab（點卡片 → onSelectStock 帶 symbol/date/chartTab）。
//
// 三策略（嚴格/中等/寬鬆）各自獨立：點哪個 pill 只顯示該 level 命中清單，互不混合。
// 多策略徽章：同一股若同時命中多個 level，卡片標示「嚴/中/寬」高亮。

import { useState, useEffect, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { RefreshCw } from 'lucide-react';
import { ForwardPerfRow } from './ForwardPerfRow';
import { useWatchlistStore } from '@/store/watchlistStore';
import type { SelectedStock } from './ScanChartPanel';
import type { StockForwardPerformance } from '@/lib/scanner/types';

type Level = 'strict' | 'medium' | 'loose';

interface Hit {
  symbol: string; name: string; industry: string; price: number; changePct: number;
  shortAttack: number; midStrength: number; midControl: number; kongPan: number;
  shortOversold?: number; // 短線超跌（舊固化資料可能沒有此欄 → undefined）
}
interface ScanResp {
  ok: boolean; lastDate: string; evaluated: number; staleSkipped?: number;
  counts: Record<Level, number>; results: Record<Level, Hit[]>; cached?: boolean; error?: string;
}
interface DateEntry { date: string; counts: Record<Level, number>; scannedAt: string }

const LEVELS: { key: Level; label: string; desc: string }[] = [
  { key: 'strict', label: '嚴格', desc: '三色資金共振 — 短攻>2.8 + 中強>3.9 + 金叉/牛熊線/控盤>80 全到位' },
  { key: 'medium', label: '中等', desc: '更新版 — 短攻 / 中強 / 中控 三個分數都 > 0' },
  { key: 'loose', label: '寬鬆', desc: '游資資金翻正 — 短線動能今天剛由負轉正' },
];

const fmt = (n: number | undefined) => (n != null && Number.isFinite(n) ? n.toFixed(2) : '—');

type SortKey = 'shortAttack' | 'midStrength' | 'midControl' | 'shortOversold' | 'changePct' | 'price'
  | 'fwdOpen' | 'fwdD1' | 'fwdD5' | 'fwdD20' | 'fwdMaxGain' | 'fwdMaxLoss';

const SORT_PILLS: { key: SortKey; label: string; tip: string }[] = [
  { key: 'shortAttack', label: '短攻', tip: '短線上攻（游資資金）分數' },
  { key: 'midStrength', label: '中強', tip: '中線強勢（主力資金）分數' },
  { key: 'midControl', label: '中控', tip: '中線控盤（主力控盤）分數' },
  { key: 'shortOversold', label: '超短跌', tip: '短線超跌（跌破 MA20 後的超跌幅度）' },
  { key: 'changePct', label: '漲幅', tip: '掃描當日漲跌幅 %' },
  { key: 'price', label: '股價', tip: '當前股價' },
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
}

export function SanSeScanCompact({ onSelectStock, selectedSymbol, level: controlledLevel }: Props) {
  const [data, setData] = useState<ScanResp | null>(null);
  const [dates, setDates] = useState<DateEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [internalLevel, setInternalLevel] = useState<Level>('medium');
  const level = controlledLevel ?? internalLevel;
  const [perf, setPerf] = useState<Record<string, StockForwardPerformance>>({});
  const [perfLoading, setPerfLoading] = useState(false);
  // 排序：預設短攻高→低（與後端排序一致）；點同鍵切換高低
  const [sortKey, setSortKey] = useState<SortKey>('shortAttack');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const loadDate = useCallback(async (date?: string) => {
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/cn-sanse/scan${date ? `?date=${date}` : ''}`);
      const j: ScanResp = await r.json();
      if (!j.ok) throw new Error(j.error || '讀取失敗');
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '讀取失敗');
    } finally { setLoading(false); }
  }, []);

  const loadDates = useCallback(async () => {
    try {
      const r = await fetch('/api/cn-sanse/scan/dates');
      const j = await r.json();
      if (j.ok) setDates(j.dates ?? []);
    } catch { /* 日期列載不到不致命 */ }
  }, []);

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

  useEffect(() => { loadDates(); loadDate(); }, [loadDates, loadDate]);

  // 績效追蹤（複用主頁 /api/backtest/forward，支援 .SS/.SZ）
  useEffect(() => {
    const hits = data?.results[level] ?? [];
    if (!data || hits.length === 0) { setPerf({}); return; }
    let alive = true;
    setPerfLoading(true);
    fetch('/api/backtest/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scanDate: data.lastDate,
        stocks: hits.slice(0, 50).map((h) => ({ symbol: h.symbol, name: h.name, scanPrice: h.price })),
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
  }, [data, level]);

  // 各 level 命中代號集合 → 用來算「多策略徽章」
  const levelSets = useMemo(() => ({
    strict: new Set((data?.results.strict ?? []).map((h) => h.symbol)),
    medium: new Set((data?.results.medium ?? []).map((h) => h.symbol)),
    loose: new Set((data?.results.loose ?? []).map((h) => h.symbol)),
  }), [data]);

  const hits = useMemo(() => {
    const rows = [...(data?.results[level] ?? [])];
    const dir = sortDir === 'desc' ? 1 : -1;
    const fwdField = FWD_FIELD[sortKey];
    rows.sort((a, b) => {
      if (fwdField) {
        const va = perf[a.symbol]?.[fwdField];
        const vb = perf[b.symbol]?.[fwdField];
        // 缺值永遠排最後（不受 asc/desc 影響）
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return dir * ((vb as number) - (va as number));
      }
      const key = sortKey as 'shortAttack' | 'midStrength' | 'midControl' | 'shortOversold' | 'changePct' | 'price';
      return dir * ((b[key] ?? 0) - (a[key] ?? 0));
    });
    return rows.slice(0, 50);
  }, [data, level, sortKey, sortDir, perf]);
  const pureSelected = selectedSymbol?.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  return (
    <div className="flex flex-col min-h-0 h-full text-foreground text-xs">
      {/* 標題列 + 重掃 */}
      <div className="shrink-0 flex items-center justify-between px-2.5 py-1.5 border-b border-border bg-card/40">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-semibold text-fuchsia-300">🎨 三色資金</span>
          <span className="text-[10px] text-muted-foreground truncate">
            {data ? `${data.lastDate}｜掃 ${data.evaluated} 檔${data.cached ? '' : ' · 即時'}` : '陸股 A 股自創策略'}
          </span>
        </div>
        <button
          onClick={rescan}
          disabled={loading}
          title="即時重新掃描並固化當日"
          className="shrink-0 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
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
                  onClick={() => { if (!loading) loadDate(d.date); }}
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
                {l.label}<span className="ml-1 opacity-70">{data?.counts[l.key] ?? '–'}</span>
              </button>
            ))}
          </div>
        )}
        <p className={cn('text-[11px] leading-snug text-muted-foreground', !controlledLevel && 'mt-1.5')}>
          {controlledLevel && <span className="font-semibold text-fuchsia-300 mr-1">{LEVELS.find((l) => l.key === level)?.label}（{data?.counts[level] ?? '–'}）·</span>}
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

      {/* 結果清單（卡片排版對齊書本買法 ScanResultsCompact）*/}
      <div className="flex-1 overflow-auto space-y-1.5 px-2 py-1.5">
        {err && <div className="p-4 text-sm text-rose-400">⚠️ {err}</div>}
        {loading && !data && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
        {data && hits.length === 0 && !loading && <div className="p-4 text-sm text-muted-foreground">此策略該日無命中。</div>}
        {hits.map((h) => {
          const ticker = h.symbol.replace(/\.(SS|SZ)$/i, '');
          const isSel = pureSelected && ticker === pureSelected;
          const inWatch = useWatchlistStore.getState().has(h.symbol);
          return (
            <div
              key={h.symbol}
              onClick={() => onSelectStock?.({
                symbol: h.symbol, name: h.name, market: 'CN',
                date: data!.lastDate, chartTab: 'shuangb',
              })}
              className={cn(
                'rounded-lg border px-2.5 py-2 cursor-pointer transition-colors',
                isSel ? 'bg-secondary/60 border-fuchsia-700/50' : 'bg-card border-border/60 hover:bg-secondary/40',
              )}
            >
              {/* Row 1: 代號 + 名稱 + 漲跌% */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="font-mono text-[11px] text-foreground/90 shrink-0">{ticker}</span>
                <span className="text-[11px] text-foreground/80 truncate flex-1">{h.name}</span>
                <span className={cn('font-mono text-[11px] font-bold shrink-0', h.changePct >= 0 ? 'text-bull' : 'text-bear')}>
                  {h.changePct >= 0 ? '+' : ''}{fmt(h.changePct)}%
                </span>
              </div>

              {/* Row 2: 股價 + 產業 + 三色分數 */}
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
                <span className="font-mono">{fmt(h.price)}</span>
                {h.industry && <span className="truncate max-w-[60px]">{h.industry}</span>}
                <span className="text-fuchsia-400" title="短線上攻">短攻 {fmt(h.shortAttack)}</span>
                <span className="text-rose-300" title="中線強勢">中強 {fmt(h.midStrength)}</span>
                <span className="text-amber-300" title="中線控盤">中控 {fmt(h.midControl)}</span>
                <span className="text-blue-400" title="短線超跌">超短跌 {fmt(h.shortOversold)}</span>
              </div>

              {/* Row 3: 命中策略徽章 + 動作按鈕 */}
              <div className="flex items-center gap-1 mb-1">
                {(['strict', 'medium', 'loose'] as Level[]).map((lv) => {
                  const hit = levelSets[lv].has(h.symbol);
                  return (
                    <span key={lv}
                      title={`${LEVELS.find((l) => l.key === lv)?.label}${hit ? ' 命中' : ' 未命中'}`}
                      className={cn(
                        'text-[8px] px-1 h-3.5 flex items-center rounded-sm font-bold',
                        hit ? 'bg-fuchsia-800/80 text-fuchsia-200' : 'bg-secondary/50 text-muted-foreground/40',
                      )}>
                      {LEVELS.find((l) => l.key === lv)?.label}
                    </span>
                  );
                })}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStock?.({ symbol: h.symbol, name: h.name, market: 'CN', date: data!.lastDate, chartTab: 'shuangb' });
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
