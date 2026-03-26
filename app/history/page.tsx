'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useReplayStore } from '@/store/replayStore';
import { SignalDate } from '@/app/api/stock-signals/route';

function ReturnCell({ val }: { val: number | null }) {
  if (val == null) return <td className="px-2 py-1.5 text-center text-slate-600">—</td>;
  const color = val > 2 ? 'text-red-400' : val > 0 ? 'text-red-300' :
                val < -2 ? 'text-green-400' : val < 0 ? 'text-green-300' : 'text-slate-400';
  return (
    <td className={`px-2 py-1.5 text-center font-mono text-xs ${color}`}>
      {val >= 0 ? '+' : ''}{val.toFixed(1)}%
    </td>
  );
}

export default function HistoryPage() {
  const { currentStock } = useReplayStore();
  const [signals, setSignals] = useState<SignalDate[]>([]);
  const [stats, setStats] = useState<{ total: number; win1: number; win5: number; win20: number; avg5: number; avg20: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [minScore, setMinScore] = useState(4);
  const [period, setPeriod] = useState('2y');
  // Filters
  const [filterSymbol, setFilterSymbol] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  const symbol = currentStock?.ticker ?? '';
  const displaySymbol = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');

  async function load() {
    if (!symbol) return;
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/stock-signals?symbol=${encodeURIComponent(symbol)}&period=${period}&minScore=${minScore}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error ?? '載入失敗'); return; }
      setSignals(json.signals);
      setStats(json.stats);
    } catch {
      setError('網路錯誤');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (symbol) load(); }, [symbol, period, minScore]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply client-side filters
  const filteredSignals = signals.filter(s => {
    if (filterDateFrom && s.date < filterDateFrom) return false;
    if (filterDateTo && s.date > filterDateTo) return false;
    return true;
  });

  // Symbol filter: if user typed something different from current stock, show a search prompt instead
  const symbolMismatch = filterSymbol.trim() !== '' &&
    filterSymbol.trim().toUpperCase() !== displaySymbol.toUpperCase() &&
    filterSymbol.trim().toUpperCase() !== symbol.toUpperCase();

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-slate-800 bg-slate-950 px-4 py-2.5 flex items-center gap-3">
        <Link href="/" className="text-slate-400 hover:text-white text-sm transition">← 主頁</Link>
        <span className="text-base font-bold">📈 個股信號歷史</span>
        {currentStock && (
          <span className="text-slate-400 text-sm">
            {displaySymbol} · {currentStock.name}
          </span>
        )}
      </header>

      <div className="p-4 max-w-4xl mx-auto space-y-4">

        {!symbol && (
          <div className="text-center py-16 text-slate-500">
            <p className="text-3xl mb-3">📊</p>
            <p className="font-medium text-slate-400">尚未載入股票</p>
            <p className="text-xs mt-1 mb-4">請先在走圖頁面搜尋並載入一支股票，再來查看信號歷史</p>
            <Link href="/" className="inline-block text-sm text-blue-400 hover:text-blue-300 transition px-4 py-2 border border-blue-500/40 rounded-lg">
              ← 去走圖頁面載入股票
            </Link>
          </div>
        )}

        {symbol && (
          <>
            {/* Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex gap-1">
                {['1y', '2y', '3y', '5y'].map(p => (
                  <button key={p} onClick={() => setPeriod(p)}
                    className={`px-3 py-1.5 rounded text-xs font-bold transition ${period === p ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}>
                    {p === '1y' ? '1年' : p === '2y' ? '2年' : p === '3y' ? '3年' : '5年'}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {[3, 4, 5, 6].map(n => (
                  <button key={n} onClick={() => setMinScore(n)}
                    className={`px-3 py-1.5 rounded text-xs font-bold transition ${minScore === n ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400 hover:bg-slate-600'}`}>
                    {n}分+
                  </button>
                ))}
              </div>
              <span className="text-xs text-slate-500">六大條件分數門檻</span>
            </div>

            {/* Filter bar */}
            <div className="flex items-center gap-2 flex-wrap bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3">
              <span className="text-xs text-slate-400 shrink-0">篩選：</span>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-slate-500">股票代號</label>
                <input
                  value={filterSymbol}
                  onChange={e => setFilterSymbol(e.target.value)}
                  placeholder={displaySymbol}
                  className="w-24 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-slate-500">起始日期</label>
                <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-slate-500">結束日期</label>
                <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
                  className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500" />
              </div>
              {(filterDateFrom || filterDateTo || filterSymbol) && (
                <button onClick={() => { setFilterSymbol(''); setFilterDateFrom(''); setFilterDateTo(''); }}
                  className="text-xs text-slate-500 hover:text-slate-300 transition ml-1">✕ 清除篩選</button>
              )}
            </div>

            {symbolMismatch && (
              <div className="flex items-center gap-2 px-3 py-2 bg-amber-900/30 border border-amber-700/40 rounded-lg text-xs text-amber-300">
                <span>目前顯示 <strong>{displaySymbol}</strong> 的信號歷史。若要查看 <strong>{filterSymbol.toUpperCase()}</strong>，請先在走圖頁面載入該股票。</span>
              </div>
            )}

            {/* Stats cards */}
            {stats && stats.total > 0 && (
              <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                {[
                  { label: '信號次數', val: `${stats.total}次`, color: 'text-white' },
                  { label: '隔日勝率', val: `${(stats.win1 / stats.total * 100).toFixed(0)}%`, color: stats.win1 / stats.total > 0.5 ? 'text-red-400' : 'text-green-400' },
                  { label: '5日勝率', val: `${(stats.win5 / stats.total * 100).toFixed(0)}%`, color: stats.win5 / stats.total > 0.5 ? 'text-red-400' : 'text-green-400' },
                  { label: '20日勝率', val: `${(stats.win20 / stats.total * 100).toFixed(0)}%`, color: stats.win20 / stats.total > 0.5 ? 'text-red-400' : 'text-green-400' },
                  { label: '5日均報酬', val: `${stats.avg5 >= 0 ? '+' : ''}${stats.avg5.toFixed(1)}%`, color: stats.avg5 > 0 ? 'text-red-400' : 'text-green-400' },
                  { label: '20日均報酬', val: `${stats.avg20 >= 0 ? '+' : ''}${stats.avg20.toFixed(1)}%`, color: stats.avg20 > 0 ? 'text-red-400' : 'text-green-400' },
                ].map(card => (
                  <div key={card.label} className="bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-center">
                    <div className="text-[10px] text-slate-500 mb-1">{card.label}</div>
                    <div className={`text-base font-bold ${card.color}`}>{card.val}</div>
                  </div>
                ))}
              </div>
            )}

            {loading && (
              <div className="text-center py-8 text-slate-400 text-sm animate-pulse">分析中...</div>
            )}
            {error && <p className="text-red-400 text-sm">{error}</p>}

            {/* Signal table */}
            {!loading && filteredSignals.length > 0 && (
              <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 bg-slate-900/40">
                  <span className="text-xs font-bold text-slate-300">
                    {displaySymbol} 信號記錄
                    {(filterDateFrom || filterDateTo) && (
                      <span className="ml-2 text-slate-500 font-normal">
                        {filterDateFrom && `${filterDateFrom} `}
                        {filterDateFrom && filterDateTo && '— '}
                        {filterDateTo && filterDateTo}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-slate-500">共 {filteredSignals.length} 筆信號</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-slate-500 border-b border-slate-700 bg-slate-900/50">
                        <th className="px-2 py-2 text-left">日期</th>
                        <th className="px-2 py-2 text-center">得分</th>
                        <th className="px-2 py-2 text-center">訊號類型</th>
                        <th className="px-2 py-2 text-right">收盤</th>
                        <th className="px-2 py-2 text-center">隔日</th>
                        <th className="px-2 py-2 text-center">5日</th>
                        <th className="px-2 py-2 text-center">10日</th>
                        <th className="px-2 py-2 text-center">20日</th>
                        <th className="px-2 py-2 text-center">5日最高</th>
                        <th className="px-2 py-2 text-center">5日最低</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSignals.map(s => (
                        <tr key={s.date} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                          <td className="px-2 py-1.5 text-slate-300 font-mono">{s.date}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`font-bold ${s.score >= 5 ? 'text-yellow-400' : 'text-blue-400'}`}>{s.score}/6</span>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              s.score >= 6 ? 'bg-yellow-500/20 text-yellow-300' :
                              s.score >= 5 ? 'bg-blue-500/20 text-blue-300' :
                              'bg-slate-700 text-slate-400'
                            }`}>
                              {s.score >= 6 ? '強勢買進' : s.score >= 5 ? '買進' : '觀察'}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono text-slate-300">{s.close.toFixed(2)}</td>
                          <ReturnCell val={s.d1Return} />
                          <ReturnCell val={s.d5Return} />
                          <ReturnCell val={s.d10Return} />
                          <ReturnCell val={s.d20Return} />
                          <ReturnCell val={s.maxGain5} />
                          <ReturnCell val={s.maxLoss5} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {!loading && signals.length > 0 && filteredSignals.length === 0 && (
              <div className="text-center py-10 text-slate-500">
                <p className="text-3xl mb-2">🔎</p>
                <p>篩選條件下無符合的信號記錄</p>
                <p className="text-xs mt-1">試試調整日期範圍或清除篩選</p>
              </div>
            )}

            {!loading && signals.length === 0 && !error && (
              <div className="text-center py-10 text-slate-500">
                <p className="text-3xl mb-2">📉</p>
                <p>在 {period} 期間內未找到達 {minScore} 分的信號</p>
                <p className="text-xs mt-1">試試降低分數門檻或延長期間</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
