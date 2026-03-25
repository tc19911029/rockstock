'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useReplayStore } from '@/store/replayStore';
import StockSelector from '@/components/StockSelector';
import ReplayControls from '@/components/ReplayControls';
import TradePanel from '@/components/TradePanel';
import AccountInfo from '@/components/AccountInfo';
import RuleAlerts from '@/components/RuleAlerts';
import TradeHistory from '@/components/TradeHistory';

// Browser-only chart components
const CandleChart = dynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-slate-900 rounded-lg flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-slate-500 text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = dynamic(() => import('@/components/IndicatorCharts'), {
  ssr: false,
});

export default function HomePage() {
  const { initData, visibleCandles, currentSignals, chartMarkers, currentStock, isLoadingStock } = useReplayStore();

  useEffect(() => {
    initData();
  }, [initData]);

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* Header */}
      <header className="border-b border-slate-700 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white">📈 K 線走圖練習器</h1>
          <p className="text-xs text-slate-400">
            一根一根播放歷史K線，練習技術分析決策 ｜ 靈感來自《學會走圖SOP》
          </p>
        </div>
        {currentStock && (
          <div className="text-right hidden sm:block">
            <p className="text-sm font-bold text-yellow-400">{currentStock.ticker}</p>
            <p className="text-xs text-slate-400">{currentStock.name}</p>
          </div>
        )}
      </header>

      <div className="p-4 space-y-4">

        {/* Row 1: Stock Selector (full width) */}
        <StockSelector />

        {/* Row 2: Chart + indicator panes */}
        <div className={`relative transition-opacity ${isLoadingStock ? 'opacity-40 pointer-events-none' : ''}`}>
          {isLoadingStock && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/70 rounded-lg">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-sm text-slate-300">載入資料中...</p>
              </div>
            </div>
          )}

          {/* Candlestick chart */}
          <div className="bg-slate-900 rounded-t-lg border border-b-0 border-slate-700 overflow-hidden">
            <CandleChart candles={visibleCandles} signals={currentSignals} chartMarkers={chartMarkers} height={420} />
          </div>

          {/* MACD + KD below */}
          <IndicatorCharts candles={visibleCandles} />
        </div>

        {/* Row 3: Controls + Trade + Account */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ReplayControls />
          <TradePanel />
          <AccountInfo />
        </div>

        {/* Row 4: Rule Alerts + Trade History */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RuleAlerts />
          <TradeHistory />
        </div>

      </div>

      <footer className="border-t border-slate-800 px-4 py-3 text-center text-xs text-slate-600">
        本工具僅供學習練習，不構成投資建議。股市有風險，投資需謹慎。
      </footer>
    </div>
  );
}
