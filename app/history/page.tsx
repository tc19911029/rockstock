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

  return (
    <div className="min-h-screen bg-[#0b1120] text-white">
      <header className="border-b border-slate-800 px-4 py-2.5 flex items-center gap-3">
        <Link href="/" className="text-slate-400 hover:text-white text-sm transition">← 返回走圖</Link>
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
            <p>請先在走圖頁面載入一支股票</p>
            <Link href="/" className="mt-3 inline-block text-blue-400 text-sm hover:text-blue-300">← 去載入股票</Link>
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
            {!loading && signals.length > 0 && (
              <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-slate-500 border-b border-slate-700 bg-slate-900/50">
                        <th className="px-2 py-2 text-left">日期</th>
                        <th className="px-2 py-2 text-center">得分</th>
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
                      {signals.map(s => (
                        <tr key={s.date} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                          <td className="px-2 py-1.5 text-slate-300 font-mono">{s.date}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`font-bold ${s.score >= 5 ? 'text-yellow-400' : 'text-blue-400'}`}>{s.score}/6</span>
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

            {!loading && signals.length === 0 && !error && (
              <div className="text-center py-10 text-slate-500">
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
