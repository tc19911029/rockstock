'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { maxBuyShares } from '@/lib/engines/tradeEngine';

type Mode = 'percent' | 'shares' | 'amount';

export default function TradePanel() {
  const { allCandles, currentIndex, metrics, buy, sell, buyPercent, sellPercent } = useReplayStore();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('percent');

  const currentCandle = allCandles[currentIndex];
  const currentPrice  = currentCandle?.close ?? 0;
  const maxBuy = maxBuyShares(metrics.cash, currentPrice);

  // Estimated shares / cost preview
  const inputNum = parseFloat(input) || 0;
  const estimatedSharesFromAmount = currentPrice > 0 ? Math.floor(inputNum / currentPrice) : 0;
  const estimatedCostFromShares   = inputNum * currentPrice;

  const handleBuy = () => {
    if (mode === 'shares') {
      const n = parseInt(input, 10);
      if (!isNaN(n) && n > 0) buy(n);
    } else if (mode === 'amount') {
      if (estimatedSharesFromAmount > 0) buy(estimatedSharesFromAmount);
    }
  };

  const handleSell = () => {
    if (mode === 'shares') {
      const n = parseInt(input, 10);
      if (!isNaN(n) && n > 0) sell(n);
    } else if (mode === 'amount') {
      if (estimatedSharesFromAmount > 0) sell(estimatedSharesFromAmount);
    }
  };

  const MODES: { key: Mode; label: string }[] = [
    { key: 'percent', label: '倉位 %' },
    { key: 'shares',  label: '股數' },
    { key: 'amount',  label: '金額' },
  ];

  return (
    <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-200">交易操作</h2>
        <div className="text-right">
          <span className="text-xs text-slate-500">現價</span>
          <span className="ml-1.5 text-base font-mono font-bold text-yellow-400">
            {currentPrice > 0 ? currentPrice.toFixed(2) : '—'}
          </span>
        </div>
      </div>

      {/* Mode toggle */}
      <div className="flex rounded-lg overflow-hidden border border-slate-600 text-xs">
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`flex-1 py-1.5 font-medium transition-colors ${
              mode === m.key
                ? 'bg-blue-600 text-white'
                : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* ── Percent mode ── */}
      {mode === 'percent' && (
        <>
          <div>
            <p className="text-xs text-slate-400 mb-1.5">買入（現金比例）</p>
            <div className="grid grid-cols-4 gap-1.5">
              {[0.25, 0.5, 0.75, 1].map(p => (
                <button
                  key={p}
                  onClick={() => buyPercent(p)}
                  disabled={metrics.cash <= 0 || currentPrice <= 0}
                  className="py-2 rounded-lg bg-red-700 hover:bg-red-600 active:bg-red-500 disabled:opacity-30 text-xs font-bold transition"
                >
                  {p * 100}%
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400 mb-1.5">賣出（持倉比例）</p>
            <div className="grid grid-cols-4 gap-1.5">
              {[0.25, 0.5, 0.75, 1].map(p => (
                <button
                  key={p}
                  onClick={() => sellPercent(p)}
                  disabled={metrics.shares <= 0}
                  className="py-2 rounded-lg bg-green-700 hover:bg-green-600 active:bg-green-500 disabled:opacity-30 text-xs font-bold transition"
                >
                  {p * 100}%
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Shares mode ── */}
      {mode === 'shares' && (
        <>
          <div>
            <p className="text-xs text-slate-400 mb-1.5">
              可買最多 <span className="text-white font-mono">{maxBuy.toLocaleString()}</span> 股
            </p>
            <input
              type="number"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="輸入股數"
              className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-white border border-slate-600 focus:border-blue-500 focus:outline-none"
            />
            {inputNum > 0 && currentPrice > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                預估金額 ≈ <span className="text-slate-300">${estimatedCostFromShares.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleBuy} disabled={metrics.cash <= 0 || currentPrice <= 0}
              className="py-2.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-30 text-sm font-bold transition">
              買入
            </button>
            <button onClick={handleSell} disabled={metrics.shares <= 0}
              className="py-2.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-30 text-sm font-bold transition">
              賣出
            </button>
          </div>
        </>
      )}

      {/* ── Amount mode ── */}
      {mode === 'amount' && (
        <>
          <div>
            <p className="text-xs text-slate-400 mb-1.5">
              現金餘額 <span className="text-white font-mono">${metrics.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input
                type="number"
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="輸入金額（例：50000）"
                className="w-full bg-slate-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white border border-slate-600 focus:border-blue-500 focus:outline-none"
              />
            </div>
            {inputNum > 0 && currentPrice > 0 && (
              <p className="text-xs text-slate-500 mt-1">
                可買約 <span className="text-slate-300 font-mono">{estimatedSharesFromAmount.toLocaleString()}</span> 股
              </p>
            )}
          </div>
          {/* Quick amount buttons */}
          <div className="grid grid-cols-4 gap-1.5">
            {[50000, 100000, 200000, 500000].map(amt => (
              <button key={amt} onClick={() => setInput(String(amt))}
                className="py-1.5 rounded-lg bg-slate-600 hover:bg-slate-500 text-xs text-slate-300 transition">
                {amt >= 10000 ? `${amt / 10000}萬` : amt}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleBuy} disabled={metrics.cash <= 0 || estimatedSharesFromAmount <= 0}
              className="py-2.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-30 text-sm font-bold transition">
              買入
            </button>
            <button onClick={handleSell} disabled={metrics.shares <= 0 || estimatedSharesFromAmount <= 0}
              className="py-2.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-30 text-sm font-bold transition">
              賣出
            </button>
          </div>
        </>
      )}

      <p className="text-xs text-slate-600 text-center">以收盤價成交，含手續費與稅</p>
    </div>
  );
}
