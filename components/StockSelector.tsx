'use client';

import { useState, useRef, useEffect } from 'react';
import { useReplayStore } from '@/store/replayStore';

const QUICK_STOCKS = [
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
];

const INTERVALS = [
  { label: '日K', value: '1d' },
  { label: '週K', value: '1wk' },
  { label: '月K', value: '1mo' },
];

// Valid period options per interval
const PERIODS: Record<string, { label: string; value: string }[]> = {
  '1d':  [{ label:'1年', value:'1y' }, { label:'2年', value:'2y' }, { label:'3年', value:'3y' }, { label:'5年', value:'5y' }],
  '1wk': [{ label:'2年', value:'2y' }, { label:'5年', value:'5y' }, { label:'10年', value:'10y' }],
  '1mo': [{ label:'5年', value:'5y' }, { label:'10年', value:'10y' }, { label:'20年', value:'20y' }],
};

export default function StockSelector() {
  const { loadStock, isLoadingStock, currentStock, currentInterval } = useReplayStore();
  const [input,    setInput]    = useState('');
  const [interval, setInterval] = useState('1d');
  const [period,   setPeriod]   = useState('2y');
  const [showDrop, setShowDrop] = useState(false);
  const [error,    setError]    = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Reset period to first valid option when interval changes
  useEffect(() => {
    const opts = PERIODS[interval];
    if (opts && !opts.find(o => o.value === period)) {
      setPeriod(opts[0].value);
    }
  }, [interval]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoad = async (symbol: string, iv?: string, pd?: string) => {
    setError('');
    setShowDrop(false);
    try {
      await loadStock(symbol, iv ?? interval, pd ?? period);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '載入失敗');
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowDrop(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = input.length > 0
    ? QUICK_STOCKS.filter(s => s.symbol.toUpperCase().includes(input.toUpperCase()) || s.name.includes(input))
    : QUICK_STOCKS;

  const periodOpts = PERIODS[interval] ?? PERIODS['1d'];

  return (
    <div className="bg-slate-800 rounded-lg p-4 space-y-3">
      {/* Title row */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">選股</h2>
        {currentStock && (
          <span className="text-xs font-mono">
            <span className="text-yellow-400 font-bold">{currentStock.ticker}</span>
            <span className="text-slate-400 ml-1">{currentStock.name}</span>
            <span className="ml-2 text-blue-400">
              {INTERVALS.find(i => i.value === currentInterval)?.label}
            </span>
          </span>
        )}
      </div>

      <div className="flex gap-2 flex-wrap md:flex-nowrap">
        {/* Search input + dropdown */}
        <div ref={wrapRef} className="relative flex-1 min-w-0">
          <input
            type="text"
            value={input}
            onChange={e => { setInput(e.target.value); setShowDrop(true); }}
            onFocus={() => setShowDrop(true)}
            onKeyDown={e => {
              if (e.key === 'Enter' && input.trim()) handleLoad(input.trim());
            }}
            placeholder="輸入代號或名稱（如 2330、AAPL）"
            className="w-full bg-slate-700 rounded px-3 py-2 text-sm text-white border border-slate-600 focus:border-blue-500 focus:outline-none"
          />

          {showDrop && filtered.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-slate-700 border border-slate-600 rounded shadow-xl z-50 max-h-52 overflow-y-auto">
              {filtered.map(s => (
                <button
                  key={s.symbol}
                  onClick={() => {
                    setInput(s.symbol === 'mock' ? '' : s.symbol);
                    handleLoad(s.symbol);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-600 text-sm flex gap-3 items-center"
                >
                  <span className="font-mono text-yellow-400 w-12 shrink-0">
                    {s.symbol === 'mock' ? '---' : s.symbol}
                  </span>
                  <span className="text-slate-300">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Load button */}
        <button
          onClick={() => handleLoad(input.trim() || 'mock')}
          disabled={isLoadingStock}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm font-bold transition whitespace-nowrap"
        >
          {isLoadingStock ? (
            <span className="flex items-center gap-1">
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              載入中
            </span>
          ) : '載入'}
        </button>
      </div>

      {/* Interval + Period row */}
      <div className="flex gap-3 items-center flex-wrap">
        {/* K線週期 */}
        <div className="flex gap-1">
          {INTERVALS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setInterval(opt.value)}
              className={`px-3 py-1 rounded text-xs font-bold transition ${
                interval === opt.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="text-slate-600 text-xs">|</span>

        {/* 資料期間 */}
        <div className="flex gap-1">
          {periodOpts.map(opt => (
            <button
              key={opt.value}
              onClick={() => setPeriod(opt.value)}
              className={`px-3 py-1 rounded text-xs transition ${
                period === opt.value
                  ? 'bg-slate-500 text-white'
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-400'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-900/30 rounded px-3 py-2">{error}</p>
      )}

      <p className="text-xs text-slate-600">
        台股輸入代號（2330）自動加 .TW ｜ 資料來自 Yahoo Finance
      </p>
    </div>
  );
}
