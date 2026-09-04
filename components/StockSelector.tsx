'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { useSearchHistoryStore } from '@/store/searchHistoryStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { Search, Clock3 } from 'lucide-react';
import { buildStockLoadHref } from '@/lib/navigation/stockUrl';
import { isPlaceholderStockName, stockCodeOf, stockDisplayName } from '@/lib/stocks/stockIdentity';

const DEFAULT_QUICK_STOCKS = [
  { symbol: 'mock',  name: '範例資料（離線）' },
  { symbol: '2330',  name: '台積電' },
  { symbol: '2317',  name: '鴻海' },
  { symbol: '2454',  name: '聯發科' },
  { symbol: '2308',  name: '台達電' },
  { symbol: '6770',  name: '力積電' },
  { symbol: '3008',  name: '大立光' },
  { symbol: '2382',  name: '廣達' },
  { symbol: '2881',  name: '富邦金' },
  { symbol: '2882',  name: '國泰金' },
  { symbol: '2412',  name: '中華電' },
  { symbol: '2357',  name: '華碩' },
  { symbol: '2303',  name: '聯電' },
  { symbol: 'AAPL',  name: 'Apple' },
  { symbol: 'TSLA',  name: 'Tesla' },
  { symbol: 'NVDA',  name: 'NVIDIA' },
  { symbol: '600519', name: '貴州茅台' },
  { symbol: '000858', name: '五糧液' },
  { symbol: '601318', name: '中國平安' },
  { symbol: '603986', name: '兆易創新' },
  { symbol: '300750', name: '寧德時代' },
  { symbol: '000333', name: '美的集團' },
];

const INDEX_SHORTCUTS = [
  { symbol: '^TWII', label: '台灣加權指數', title: '台灣加權指數' },
  { symbol: 'TXF', label: '台灣加權期貨指數', title: '臺股期貨（TX 近月連續）' },
  { symbol: '^TWOII', label: '台灣上櫃指數', title: '台灣上櫃指數' },
  { symbol: '000001.SS', label: '大 A 指數', title: 'A 股大盤（上證指數）' },
] as const;



// Extract raw symbol from ticker (e.g. "2330.TW" → "2330", "AAPL" → "AAPL")
function rawSymbol(ticker: string) {
  return ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
}

export default function StockSelector() {
  const { loadStock, isLoadingStock, currentStock, currentInterval, startPolling, stopPolling } = useReplayStore();
  const recentItems  = useSearchHistoryStore(s => s.items);
  const clearHistory = useSearchHistoryStore(s => s.clear);
  const watchItems   = useWatchlistStore(s => s.items);
  const addWatch     = useWatchlistStore(s => s.add);
  const removeWatch  = useWatchlistStore(s => s.remove);
  const inWatchlist  = currentStock ? watchItems.some(i => i.symbol === currentStock.ticker) : false;
  const [input,    setInput]    = useState('');
  const [showDrop, setShowDrop] = useState(false);
  const [error,    setError]    = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Sync input when stock is loaded externally (e.g. via ?load= URL param from scanner)
  useEffect(() => {
    if (currentStock?.ticker) {
      setInput(rawSymbol(currentStock.ticker));
    }
  }, [currentStock?.ticker]);

  // 組件 unmount 時停止 polling
  useEffect(() => {
    return () => { stopPolling(); };
  }, [stopPolling]);

  // 載入股票（保留當前 interval — 預設由 ChartToolbar timeframe pills 控制）
  const handleLoad = useCallback(async (symbol: string) => {
    setError('');
    setShowDrop(false);
    const normalized = symbol.trim();
    if (!normalized) {
      setError('請輸入股票代號或名稱，例如 2330');
      return;
    }
    stopPolling();
    try {
      const timeframe = currentInterval ?? '1d';
      await loadStock(normalized, timeframe);
      startPolling();
      const resolvedTicker = useReplayStore.getState().currentStock?.ticker ?? normalized;
      window.history.replaceState(
        null,
        '',
        buildStockLoadHref(window.location.pathname, window.location.search, resolvedTicker, timeframe),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '載入失敗');
    }
  }, [currentInterval, loadStock, startPolling, stopPolling]);

  // Close dropdown on outside click
  const closeOnOutside = (e: React.MouseEvent) => {
    if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false);
  };

  // 切換目前載入的股票是否在自選股
  const toggleWatch = useCallback(() => {
    if (!currentStock?.ticker) return;
    if (inWatchlist) removeWatch(currentStock.ticker);
    else if (isPlaceholderStockName(currentStock.name, currentStock.ticker)) {
      setError('中文名稱尚未解析完成，請稍後再加入自選股');
    } else addWatch(currentStock.ticker, currentStock.name);
  }, [currentStock, inWatchlist, addWatch, removeWatch]);

  const filtered = input.length > 0
    ? DEFAULT_QUICK_STOCKS.filter(s => s.symbol.toUpperCase().includes(input.toUpperCase()) || s.name.includes(input))
    : DEFAULT_QUICK_STOCKS;

  // 輸入框空白時，下拉最上方顯示最近搜尋
  const showRecents = input.length === 0 && recentItems.length > 0;

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 xl:flex-nowrap" onClick={closeOnOutside}>
      {/* Search input + dropdown */}
      <div ref={wrapRef} className="relative min-w-0 flex-1 sm:flex-none">
        <div className="relative flex items-center overflow-hidden rounded-lg border border-border bg-card focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" aria-hidden="true" />
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setShowDrop(true); }}
            onFocus={() => setShowDrop(true)}
            onKeyDown={e => { if (e.key === 'Enter') handleLoad(input); }}
            aria-label="搜尋股票代號或名稱"
            aria-describedby={error ? 'stock-search-error' : undefined}
            aria-invalid={Boolean(error)}
            placeholder="搜尋股票"
            className="min-h-11 w-full min-w-0 bg-transparent py-2 pl-9 pr-3 text-base text-foreground font-mono focus-visible:outline-none sm:w-40"
          />
        </div>
        {showDrop && (filtered.length > 0 || showRecents) && (
          <div className="absolute left-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-popover shadow-2xl max-h-80">
            {showRecents && (
              <>
                <div className="sticky top-0 flex min-h-11 items-center justify-between border-b border-border bg-popover px-3">
                  <span className="text-xs font-semibold text-muted-foreground">最近搜尋</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); clearHistory(); }}
                    className="min-h-11 px-2 text-xs text-muted-foreground transition hover:text-red-400"
                  >清除</button>
                </div>
                {recentItems.map(s => (
                  <button key={`recent-${s.symbol}`}
                    onClick={() => { setInput(s.symbol); handleLoad(s.symbol); }}
                    className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left text-sm hover:bg-secondary"
                  >
                    <Clock3 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-foreground/90">{stockDisplayName(s.name, s.symbol)}</span>
                    <span className="shrink-0 font-mono text-xs text-yellow-400">{stockCodeOf(s.symbol)}</span>
                  </button>
                ))}
                {filtered.length > 0 && (
                  <div className="border-b border-t border-border bg-secondary/50 px-3 py-2">
                    <span className="text-xs font-semibold text-muted-foreground">常用股票</span>
                  </div>
                )}
              </>
            )}
            {filtered.map(s => (
              <button key={s.symbol}
                onClick={() => { setInput(s.symbol === 'mock' ? '' : s.symbol); handleLoad(s.symbol); }}
                className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 text-left text-sm hover:bg-secondary"
              >
                <span className="min-w-0 flex-1 truncate text-foreground/90">{s.symbol === 'mock' ? s.name : stockDisplayName(s.name, s.symbol)}</span>
                <span className="shrink-0 font-mono text-xs text-yellow-400">{s.symbol === 'mock' ? '---' : stockCodeOf(s.symbol)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Load button */}
      <button onClick={() => handleLoad(input)} disabled={isLoadingStock}
        className="min-h-11 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-semibold transition hover:bg-blue-500 disabled:opacity-50">
        {isLoadingStock
          ? <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 border-2 border-foreground border-t-transparent rounded-full animate-spin" />載入</span>
          : '載入'}
      </button>
      {/* 加入/移除自選股（沿用載入的那檔） */}
      <button onClick={toggleWatch} disabled={!currentStock}
        title={!currentStock ? '先載入一檔股票' : inWatchlist ? '從自選股移除' : '加入自選股'}
        className={`min-h-11 shrink-0 rounded-lg px-4 text-sm font-semibold transition disabled:opacity-40 ${
          inWatchlist
            ? 'bg-amber-500 hover:bg-amber-400 text-black'
            : 'bg-secondary hover:bg-secondary/70 text-foreground border border-border'
        }`}>
        {inWatchlist ? '★ 已自選' : '☆ 加自選'}
      </button>
      <div
        role="group"
        aria-label="常用市場指數"
        className="flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-0.5 xl:w-auto xl:pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {INDEX_SHORTCUTS.map((shortcut) => {
          const active = currentStock?.ticker.toUpperCase() === shortcut.symbol.toUpperCase();
          return (
            <button
              key={shortcut.symbol}
              type="button"
              aria-pressed={active}
              title={shortcut.title}
              disabled={isLoadingStock}
              onClick={() => {
                setInput(shortcut.symbol);
                handleLoad(shortcut.symbol);
              }}
              className={`min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-wait disabled:opacity-50 ${
                active
                  ? 'border-sky-400 bg-sky-500/15 text-sky-300'
                  : 'border-border bg-secondary text-muted-foreground hover:border-sky-500/60 hover:bg-sky-500/10 hover:text-foreground'
              }`}
            >
              {shortcut.label}
            </button>
          );
        })}
      </div>
      {/* timeframe pills 已移至 ChartToolbar（緊鄰走圖區） */}

      {error && <span id="stock-search-error" role="alert" className="text-sm text-red-400 max-w-64">{error}</span>}
    </div>
  );
}
