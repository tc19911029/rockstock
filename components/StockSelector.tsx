'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { useSearchHistoryStore } from '@/store/searchHistoryStore';
import { useWatchlistStore } from '@/store/watchlistStore';
import { buildStockLoadHref } from '@/lib/navigation/stockUrl';
import { isPlaceholderStockName, stockCodeOf, stockDisplayName } from '@/lib/stocks/stockIdentity';

const DEFAULT_QUICK_STOCKS = [
  { symbol: 'mock',  name: '📊 範例資料（離線）' },
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
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (currentStock?.ticker) {
      setInput(rawSymbol(currentStock.ticker));
    }
  }, [currentStock?.ticker]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 組件 unmount 時停止 polling
  useEffect(() => {
    return () => { stopPolling(); };
  }, [stopPolling]);

  // 載入股票（保留當前 interval — 預設由 ChartToolbar timeframe pills 控制）
  const handleLoad = useCallback(async (symbol: string) => {
    setError('');
    setShowDrop(false);
    stopPolling();
    try {
      const timeframe = currentInterval ?? '1d';
      await loadStock(symbol, timeframe);
      startPolling();
      const resolvedTicker = useReplayStore.getState().currentStock?.ticker ?? symbol;
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
    <div className="flex items-center gap-1.5 min-w-0 flex-1" onClick={closeOnOutside}>
      {/* Search input + dropdown */}
      <div ref={wrapRef} className="relative shrink-0">
        <div className="flex items-center bg-muted rounded border border-border focus-within:border-blue-500 overflow-hidden">
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setShowDrop(true); }}
            onFocus={() => setShowDrop(true)}
            onKeyDown={e => { if (e.key === 'Enter' && input.trim()) handleLoad(input.trim()); }}
            aria-label="搜尋股票代號或名稱"
            placeholder="代號/名稱"
            className="w-28 bg-transparent px-2 py-1 text-xs text-foreground font-mono focus:outline-none"
          />
          {currentStock?.name && !showDrop && (
            <span className="text-[10px] text-muted-foreground pr-2 truncate max-w-[80px]">{currentStock.name}</span>
          )}
        </div>
        {showDrop && (filtered.length > 0 || showRecents) && (
          <div className="absolute top-full left-0 mt-1 w-64 max-w-[80vw] bg-muted border border-border rounded shadow-xl z-50 max-h-72 overflow-y-auto">
            {showRecents && (
              <>
                <div className="flex items-center justify-between px-2 py-1 sticky top-0 bg-muted border-b border-border">
                  <span className="text-[10px] font-bold text-muted-foreground tracking-wide">最近搜尋</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); clearHistory(); }}
                    className="text-[10px] text-muted-foreground hover:text-red-400 transition"
                  >清除</button>
                </div>
                {recentItems.map(s => (
                  <button key={`recent-${s.symbol}`}
                    onClick={() => { setInput(s.symbol); handleLoad(s.symbol); }}
                    className="w-full text-left px-2 py-1.5 text-xs flex gap-2 items-center min-w-0 hover:bg-background/40"
                  >
                    <span className="text-muted-foreground shrink-0">🕘</span>
                    <span className="text-foreground/80 truncate flex-1">{stockDisplayName(s.name, s.symbol)}</span>
                    <span className="font-mono text-yellow-400 shrink-0">{stockCodeOf(s.symbol)}</span>
                  </button>
                ))}
                {filtered.length > 0 && (
                  <div className="px-2 py-1 bg-muted border-b border-t border-border">
                    <span className="text-[10px] font-bold text-muted-foreground tracking-wide">常用</span>
                  </div>
                )}
              </>
            )}
            {filtered.map(s => (
              <button key={s.symbol}
                onClick={() => { setInput(s.symbol === 'mock' ? '' : s.symbol); handleLoad(s.symbol); }}
                className="w-full text-left px-2 py-1.5 text-xs flex gap-2 items-center min-w-0 hover:bg-background/40"
              >
                <span className="text-foreground/80 truncate flex-1">{s.symbol === 'mock' ? s.name : stockDisplayName(s.name, s.symbol)}</span>
                <span className="font-mono text-yellow-400 shrink-0">{s.symbol === 'mock' ? '---' : stockCodeOf(s.symbol)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Load button */}
      <button onClick={() => handleLoad(input.trim() || 'mock')} disabled={isLoadingStock}
        className="shrink-0 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold transition">
        {isLoadingStock
          ? <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 border-2 border-foreground border-t-transparent rounded-full animate-spin" />載入</span>
          : '載入'}
      </button>
      {/* 加入/移除自選股（沿用載入的那檔） */}
      <button onClick={toggleWatch} disabled={!currentStock}
        title={!currentStock ? '先載入一檔股票' : inWatchlist ? '從自選股移除' : '加入自選股'}
        className={`shrink-0 px-2.5 py-1 rounded text-xs font-bold transition disabled:opacity-40 ${
          inWatchlist
            ? 'bg-amber-500 hover:bg-amber-400 text-black'
            : 'bg-secondary hover:bg-secondary/70 text-foreground border border-border'
        }`}>
        {inWatchlist ? '★ 已自選' : '☆ 加自選'}
      </button>
      {/* timeframe pills 已移至 ChartToolbar（緊鄰走圖區） */}

      {error && <span className="text-xs text-red-400 truncate">{error}</span>}
    </div>
  );
}
