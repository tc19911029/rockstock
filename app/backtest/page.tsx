'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useBacktestStore, BacktestHorizon } from '@/store/backtestStore';
import { StockForwardPerformance } from '@/lib/scanner/types';
import { calcBacktestSummary } from '@/lib/backtest/ForwardAnalyzer';
import { BacktestTrade, BacktestStats } from '@/lib/backtest/BacktestEngine';

// ── CSV Export ─────────────────────────────────────────────────────────────────

function exportToCsv(trades: BacktestTrade[], scanDate: string) {
  const headers = ['代號','名稱','市場','訊號日','評分','趨勢','進場日','進場價','出場日','出場價','出場原因','持有天數','毛報酬%','淨報酬%','交易成本','命中原因'];
  const rows = trades.map(t => [
    t.symbol, t.name, t.market, t.signalDate, t.signalScore, t.trendState,
    t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.exitReason, t.holdDays,
    t.grossReturn, t.netReturn, t.totalCost, t.signalReasons.join('|'),
  ]);
  const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backtest_${scanDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function retColor(v: number | null | undefined) {
  if (v == null) return 'text-slate-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-slate-400';
}

function fmtRet(v: number | null | undefined) {
  if (v == null) return '–';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

function scoreColor(s: number) {
  if (s >= 5) return 'text-amber-400 font-bold';
  if (s >= 4) return 'text-emerald-400 font-semibold';
  return 'text-sky-400';
}

function trendBadge(t: string) {
  const cls =
    t === '多頭' ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700' :
    t === '空頭' ? 'bg-red-900/60 text-red-300 border-red-700' :
    'bg-slate-700/60 text-slate-300 border-slate-600';
  return <span className={`px-1.5 py-0.5 text-xs rounded border ${cls}`}>{t}</span>;
}

function exitBadge(reason: string) {
  const map: Record<string, string> = {
    holdDays:   'bg-blue-900/40 text-blue-300 border-blue-700',
    stopLoss:   'bg-red-900/40 text-red-300 border-red-700',
    takeProfit: 'bg-emerald-900/40 text-emerald-300 border-emerald-700',
    dataEnd:    'bg-slate-700/40 text-slate-400 border-slate-600',
  };
  const labels: Record<string, string> = {
    holdDays: '持滿', stopLoss: '停損', takeProfit: '停利', dataEnd: '資料結束',
  };
  const cls = map[reason] ?? map.holdDays;
  return <span className={`px-1 py-0.5 text-[10px] rounded border ${cls}`}>{labels[reason] ?? reason}</span>;
}

// ── Summary Card (legacy horizon) ──────────────────────────────────────────────

function HorizonCard({ label, horizon, performance }: {
  label: string; horizon: BacktestHorizon; performance: StockForwardPerformance[];
}) {
  const stats = calcBacktestSummary(performance, horizon);
  if (!stats) return (
    <div className="bg-slate-800/50 rounded-lg p-2.5 flex flex-col items-center justify-center gap-1 opacity-40 min-h-[80px]">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className="text-slate-500 text-xs">–</div>
    </div>
  );
  return (
    <div className="bg-slate-800 rounded-lg p-2.5 flex flex-col gap-1.5">
      <div className="text-[10px] text-slate-400 font-medium">{label}</div>
      <div className={`text-lg font-bold leading-tight ${retColor(stats.avgReturn)}`}>
        {fmtRet(stats.avgReturn)}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
        <span className="text-slate-400">勝率</span>
        <span className={stats.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}>{stats.winRate}%</span>
        <span className="text-slate-400">中位</span>
        <span className={retColor(stats.median)}>{fmtRet(stats.median)}</span>
        <span className="text-slate-400">最高</span>
        <span className="text-emerald-400">+{stats.maxGain.toFixed(1)}%</span>
        <span className="text-slate-400">最低</span>
        <span className="text-red-400">{stats.maxLoss.toFixed(1)}%</span>
      </div>
    </div>
  );
}

// ── Strict Stats Panel ──────────────────────────────────────────────────────────

function StrictStatsPanel({ stats, tradesCount }: { stats: BacktestStats; tradesCount: number }) {
  return (
    <div className="bg-slate-900 border border-sky-800/40 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-2 h-2 rounded-full bg-sky-400" />
        <h3 className="text-sm font-semibold text-slate-200">嚴謹回測統計（含成本）</h3>
        <span className="text-xs text-slate-500 ml-auto">{tradesCount} 筆交易</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        <Kpi label="勝率" value={`${stats.winRate}%`} color={stats.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'} />
        <Kpi label="淨報酬均值" value={fmtRet(stats.avgNetReturn)} color={retColor(stats.avgNetReturn)} />
        <Kpi label="毛報酬均值" value={fmtRet(stats.avgGrossReturn)} color={retColor(stats.avgGrossReturn)} />
        <Kpi label="中位數" value={fmtRet(stats.medianReturn)} color={retColor(stats.medianReturn)} />
        <Kpi label="最大獲利" value={fmtRet(stats.maxGain)} color="text-emerald-400" />
        <Kpi label="最大虧損" value={fmtRet(stats.maxLoss)} color="text-red-400" />
        <Kpi label="期望值" value={fmtRet(stats.expectancy)} color={retColor(stats.expectancy)} subtext="每筆平均淨賺" />
        <Kpi label="最大連虧" value={fmtRet(stats.maxDrawdown)} color="text-red-400" subtext="累積" />
        <Kpi label="勝 / 負" value={`${stats.wins} / ${stats.losses}`} color="text-slate-300" />
        <Kpi label="淨報酬加總" value={fmtRet(stats.totalNetReturn)} color={retColor(stats.totalNetReturn)} subtext="非複利" />
      </div>
    </div>
  );
}

function Kpi({ label, value, color, subtext }: {
  label: string; value: string; color: string; subtext?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={`text-base font-bold ${color}`}>{value}</div>
      {subtext && <div className="text-[10px] text-slate-600">{subtext}</div>}
    </div>
  );
}

// ── Trade Row ──────────────────────────────────────────────────────────────────

function TradeRow({ t }: { t: BacktestTrade }) {
  const sym = t.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
  return (
    <tr className="border-t border-slate-700/50 hover:bg-slate-700/20 transition-colors text-xs">
      <td className="py-2 px-3">
        <div className="font-medium text-white text-sm">{t.name}</div>
        <div className="text-slate-500 font-mono">{sym}</div>
      </td>
      <td className="py-2 px-2 text-center">
        <span className={scoreColor(t.signalScore)}>{t.signalScore}/6</span>
      </td>
      <td className="py-2 px-2 text-center">{trendBadge(t.trendState)}</td>
      <td className="py-2 px-2 text-slate-400 text-center font-mono">{t.entryDate}</td>
      <td className="py-2 px-2 text-right font-mono text-slate-200">{t.entryPrice.toFixed(2)}</td>
      <td className="py-2 px-2 text-slate-400 text-center font-mono">{t.exitDate}</td>
      <td className="py-2 px-2 text-right font-mono text-slate-200">{t.exitPrice.toFixed(2)}</td>
      <td className="py-2 px-2 text-center">{exitBadge(t.exitReason)}</td>
      <td className="py-2 px-2 text-center text-slate-400">{t.holdDays}日</td>
      <td className={`py-2 px-2 text-right font-mono font-semibold ${retColor(t.grossReturn)}`}>
        {fmtRet(t.grossReturn)}
      </td>
      <td className={`py-2 px-2 text-right font-mono font-bold ${retColor(t.netReturn)}`}>
        {fmtRet(t.netReturn)}
      </td>
      <td className="py-2 px-2 text-right text-slate-500 font-mono">
        {t.totalCost > 0 ? `-${t.totalCost.toLocaleString()}` : '–'}
      </td>
      <td className="py-2 px-2">
        <div className="flex flex-wrap gap-0.5 max-w-[160px]">
          {t.signalReasons.map(r => (
            <span key={r} className="px-1 py-0.5 bg-slate-700 text-slate-300 rounded text-[10px]">{r}</span>
          ))}
        </div>
      </td>
      <td className="py-2 px-3 text-center">
        <Link
          href={`/?load=${sym}`}
          className="text-xs text-sky-400 hover:text-sky-300 underline underline-offset-2"
        >
          走圖
        </Link>
      </td>
    </tr>
  );
}

// ── Session History Sidebar ────────────────────────────────────────────────────

function SessionHistory() {
  const { sessions, loadSession, market, scanDate } = useBacktestStore();
  const filtered = sessions.filter(s => s.market === market);
  if (filtered.length === 0) return null;
  return (
    <div className="bg-slate-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">回測歷史</h3>
      <div className="space-y-1.5">
        {filtered.map(s => (
          <button
            key={s.id}
            onClick={() => loadSession(s.id)}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-slate-700 transition-colors ${
              s.scanDate === scanDate ? 'bg-slate-700 text-white' : 'text-slate-400'
            }`}
          >
            <div className="font-mono">{s.scanDate}</div>
            <div className="text-slate-500">
              {s.scanResults.length} 檔
              {s.stats ? ` ｜ 勝率 ${s.stats.winRate}%` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function BacktestPage() {
  const {
    market, scanDate, strategy,
    setMarket, setScanDate, setStrategy,
    isScanning, scanProgress, scanError,
    scanResults, isFetchingForward, forwardError, performance,
    trades, stats,
    runBacktest, clearCurrent,
  } = useBacktestStore();

  const [tab, setTab]               = useState<'strict' | 'horizon'>('strict');
  const [activeHorizon, setHorizon] = useState<BacktestHorizon>('d5');
  const [sortBy, setSortBy]         = useState<'netReturn' | 'signalScore' | 'holdDays'>('netReturn');

  const maxDate = (() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();

  const horizonLabels: { key: BacktestHorizon; label: string }[] = [
    { key: 'open', label: '隔日開' }, { key: 'd1', label: '1日' },
    { key: 'd2', label: '2日' },     { key: 'd3', label: '3日' },
    { key: 'd4', label: '4日' },     { key: 'd5', label: '5日' },
    { key: 'd10', label: '10日' },   { key: 'd20', label: '20日' },
  ];

  const perfMap = new Map(performance.map(p => [p.symbol, p]));

  const sortedTrades = [...trades].sort((a, b) => {
    if (sortBy === 'netReturn')   return b.netReturn - a.netReturn;
    if (sortBy === 'signalScore') return b.signalScore - a.signalScore;
    if (sortBy === 'holdDays')    return a.holdDays - b.holdDays;
    return 0;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link href="/" className="text-slate-400 hover:text-slate-200 text-sm">← 主頁</Link>
          <div className="h-5 w-px bg-slate-700" />
          <h1 className="font-bold text-white">歷史掃描回測</h1>
          <div className="ml-auto">
            <Link href="/scanner" className="text-xs text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded-lg border border-slate-700 transition-colors">
              即時掃描
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Controls */}
        <div className="bg-slate-900 rounded-xl p-5 border border-slate-800">
          <div className="flex flex-wrap items-end gap-4">
            {/* Market */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">市場</label>
              <div className="flex gap-2">
                {(['TW', 'CN'] as const).map(m => (
                  <button key={m} onClick={() => { setMarket(m); clearCurrent(); }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      market === m ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}>
                    {m === 'TW' ? '台股' : '陸股'}
                  </button>
                ))}
              </div>
            </div>

            {/* Date */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">訊號日期</label>
              <input type="date" value={scanDate} max={maxDate} min="2020-01-01"
                onChange={e => { setScanDate(e.target.value); clearCurrent(); }}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Strategy params */}
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">持有天數</label>
              <select value={strategy.holdDays}
                onChange={e => setStrategy({ holdDays: +e.target.value })}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                {[1, 3, 5, 10, 20].map(d => <option key={d} value={d}>{d} 日</option>)}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">停損</label>
              <select
                value={strategy.stopLoss == null ? 'off' : String(strategy.stopLoss)}
                onChange={e => setStrategy({ stopLoss: e.target.value === 'off' ? null : +e.target.value })}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                <option value="off">不設停損</option>
                <option value="-0.05">-5%</option>
                <option value="-0.07">-7%（朱老師）</option>
                <option value="-0.10">-10%</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-medium">停利</label>
              <select
                value={strategy.takeProfit == null ? 'off' : String(strategy.takeProfit)}
                onChange={e => setStrategy({ takeProfit: e.target.value === 'off' ? null : +e.target.value })}
                className="bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-500">
                <option value="off">不設停利</option>
                <option value="0.10">+10%</option>
                <option value="0.15">+15%</option>
                <option value="0.20">+20%</option>
              </select>
            </div>

            {/* Run */}
            <button onClick={runBacktest}
              disabled={isScanning || isFetchingForward || !scanDate}
              className="px-6 py-2 bg-sky-600 hover:bg-sky-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-lg text-sm font-semibold transition-colors">
              {isScanning ? '掃描中…' : isFetchingForward ? '計算績效…' : '開始回測'}
            </button>

            {scanResults.length > 0 && !isScanning && (
              <div className="text-sm text-slate-400">
                <span className="text-white font-semibold">{scanDate}</span>{' '}
                選出 <span className="text-amber-400 font-bold">{scanResults.length}</span> 檔
              </div>
            )}
          </div>

          {/* Progress */}
          {(isScanning || isFetchingForward) && (
            <div className="mt-4 space-y-1">
              <div className="text-xs text-slate-400">
                {isScanning ? `掃描歷史數據（${scanDate}）…` : '計算後續績效與回測引擎…'}
              </div>
              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-sky-600 rounded-full transition-all duration-500"
                  style={{ width: isScanning ? `${scanProgress}%` : '100%',
                           animation: isFetchingForward ? 'pulse 1s infinite' : 'none' }} />
              </div>
            </div>
          )}

          {(scanError || forwardError) && (
            <div className="mt-3 px-3 py-2 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">
              {scanError || forwardError}
            </div>
          )}
        </div>

        {/* Results */}
        {(trades.length > 0 || performance.length > 0) && (
          <div className="flex gap-6">
            <div className="flex-1 min-w-0 space-y-4">

              {/* Tab switcher */}
              <div className="flex items-center gap-1 border-b border-slate-800 pb-0">
                {(['strict', 'horizon'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                      tab === t
                        ? 'border-sky-500 text-sky-400'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}>
                    {t === 'strict' ? '🔬 嚴謹回測（含成本）' : '📊 時間視角統計'}
                  </button>
                ))}
              </div>

              {/* ── Tab: Strict ── */}
              {tab === 'strict' && (
                <div className="space-y-4">
                  {stats && <StrictStatsPanel stats={stats} tradesCount={trades.length} />}

                  <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
                      <span className="text-xs text-slate-400">排序</span>
                      {(['netReturn', 'signalScore', 'holdDays'] as const).map(k => (
                        <button key={k} onClick={() => setSortBy(k)}
                          className={`text-xs px-2 py-1 rounded transition-colors ${
                            sortBy === k ? 'bg-sky-700 text-white' : 'text-slate-400 hover:text-slate-200'
                          }`}>
                          {{ netReturn: '淨報酬', signalScore: '評分', holdDays: '持有天數' }[k]}
                        </button>
                      ))}
                      <button
                        onClick={() => exportToCsv(sortedTrades, scanDate)}
                        disabled={sortedTrades.length === 0}
                        className="ml-auto px-3 py-1 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 rounded text-xs text-white transition-colors"
                      >
                        ↓ 匯出 CSV
                      </button>
                    </div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[10px] text-slate-400 border-b border-slate-700">
                          <th className="py-2 px-3 text-left">股票</th>
                          <th className="py-2 px-2 text-center">評分</th>
                          <th className="py-2 px-2 text-center">趨勢</th>
                          <th className="py-2 px-2 text-center">進場日</th>
                          <th className="py-2 px-2 text-right">進場價</th>
                          <th className="py-2 px-2 text-center">出場日</th>
                          <th className="py-2 px-2 text-right">出場價</th>
                          <th className="py-2 px-2 text-center">出場原因</th>
                          <th className="py-2 px-2 text-center">持有</th>
                          <th className="py-2 px-2 text-right">毛報酬</th>
                          <th className="py-2 px-2 text-right">淨報酬</th>
                          <th className="py-2 px-2 text-right">交易成本</th>
                          <th className="py-2 px-2 text-left">命中原因</th>
                          <th className="py-2 px-3 text-center">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTrades.map(t => <TradeRow key={t.symbol + t.entryDate} t={t} />)}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Tab: Horizon ── */}
              {tab === 'horizon' && performance.length > 0 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
                    {horizonLabels.map(({ key, label }) => (
                      <HorizonCard key={key} label={label} horizon={key} performance={performance} />
                    ))}
                  </div>

                  <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto">
                    <div className="flex gap-1 px-4 py-3 border-b border-slate-800">
                      {horizonLabels.map(({ key, label }) => (
                        <button key={key} onClick={() => setHorizon(key)}
                          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                            activeHorizon === key ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-700 text-xs text-slate-400">
                          <th className="py-2.5 px-3 text-left">股票</th>
                          <th className="py-2.5 px-3 text-center">評分</th>
                          <th className="py-2.5 px-3 text-center">趨勢</th>
                          <th className="py-2.5 px-3 text-right">收盤價</th>
                          <th className="py-2 px-1.5 text-right">隔日開</th>
                          <th className="py-2 px-1.5 text-right">1日</th>
                          <th className="py-2 px-1.5 text-right">2日</th>
                          <th className="py-2 px-1.5 text-right">3日</th>
                          <th className="py-2 px-1.5 text-right">4日</th>
                          <th className="py-2 px-1.5 text-right">5日</th>
                          <th className="py-2 px-1.5 text-right">10日</th>
                          <th className="py-2 px-1.5 text-right">20日</th>
                          <th className="py-2 px-1.5 text-right">最高/最低</th>
                          <th className="py-2.5 px-3 text-center">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scanResults.map(r => {
                          const p = perfMap.get(r.symbol);
                          const sym = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
                          return (
                            <tr key={r.symbol} className="border-t border-slate-700/50 hover:bg-slate-700/20 text-sm">
                              <td className="py-2.5 px-3">
                                <div className="font-medium text-white">{r.name}</div>
                                <div className="text-xs text-slate-400 font-mono">{sym}</div>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span className={scoreColor(r.sixConditionsScore)}>{r.sixConditionsScore}/6</span>
                              </td>
                              <td className="py-2.5 px-3 text-center">{trendBadge(r.trendState)}</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-200">
                                {r.price.toFixed(r.price >= 10 ? 2 : 3)}
                              </td>
                              {p ? (
                                <>
                                  {[p.openReturn, p.d1Return, p.d2Return, p.d3Return, p.d4Return, p.d5Return, p.d10Return, p.d20Return].map((v, i) => (
                                    <td key={i} className={`py-2 px-1.5 text-right text-xs font-mono ${retColor(v)}`}>{fmtRet(v)}</td>
                                  ))}
                                  <td className="py-2 px-1.5 text-right text-xs whitespace-nowrap">
                                    <span className="text-emerald-400">+{p.maxGain.toFixed(1)}%</span>
                                    <span className="text-slate-500 mx-0.5">/</span>
                                    <span className="text-red-400">{p.maxLoss.toFixed(1)}%</span>
                                  </td>
                                </>
                              ) : (
                                <td colSpan={9} className="py-2 text-center text-xs text-slate-500">計算中…</td>
                              )}
                              <td className="py-2.5 px-3 text-center">
                                <Link href={`/?load=${sym}`} className="text-xs text-sky-400 hover:text-sky-300 underline underline-offset-2">走圖</Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="w-52 shrink-0 hidden lg:block">
              <SessionHistory />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!isScanning && !isFetchingForward && scanResults.length === 0 && !scanError && (
          <div className="text-center py-20 text-slate-500 space-y-2">
            <div className="text-5xl">🔬</div>
            <div className="text-lg font-medium text-slate-400">選擇市場、日期、策略，開始回測</div>
            <div className="text-sm">嚴謹模式：進場用隔日開盤價，成本模型台股/陸股分開計算</div>
            <div className="text-sm">每筆交易保留完整進出場紀錄與命中原因</div>
          </div>
        )}

      </div>
    </div>
  );
}
