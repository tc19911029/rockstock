'use client';

import { useState } from 'react';
import { useReplayStore } from '@/store/replayStore';
import { maxBuyShares } from '@/lib/engines/tradeEngine';

export default function TradePanel() {
  const { allCandles, currentIndex, metrics, buy, sell, buyPercent, sellPercent } = useReplayStore();
  const [shareInput, setShareInput] = useState('');
  const [mode, setMode] = useState<'shares' | 'percent'>('percent');

  const currentCandle = allCandles[currentIndex];
  const currentPrice  = currentCandle?.close ?? 0;
  const maxBuy = maxBuyShares(metrics.cash, currentPrice);

  const handleBuy = () => {
    if (mode === 'shares') {
      const n = parseInt(shareInput, 10);
      if (!isNaN(n) && n > 0) buy(n);
    }
  };

  const handleSell = () => {
    if (mode === 'shares') {
      const n = parseInt(shareInput, 10);
      if (!isNaN(n) && n > 0) sell(n);
    }
  };

  return (
    <div className="bg-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-300">交易操作</h2>
        <span className="text-sm font-mono text-white">
          現價 <span className="text-yellow-400">{currentPrice.toFixed(2)}</span>
        </span>
      </div>

      {/* Mode toggle */}
      <div className="flex rounded overflow-hidden border border-slate-600">
        <button
          onClick={() => setMode('percent')}
          className={`flex-1 py-1.5 text-xs transition ${
            mode === 'percent' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400'
          }`}
        >
          倉位 %
        </button>
        <button
          onClick={() => setMode('shares')}
          className={`flex-1 py-1.5 text-xs transition ${
            mode === 'shares' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-400'
          }`}
        >
          股數
        </button>
      </div>

      {mode === 'percent' ? (
        <>
          {/* Quick buy buttons */}
          <div>
            <p className="text-xs text-slate-400 mb-1">買入（以現有現金比例）</p>
            <div className="grid grid-cols-4 gap-1">
              {[0.25, 0.5, 0.75, 1].map((p) => (
                <button
                  key={p}
                  onClick={() => buyPercent(p)}
                  disabled={metrics.cash <= 0 || currentPrice <= 0}
                  className="py-2 rounded bg-green-700 hover:bg-green-600 disabled:opacity-30 text-xs font-bold transition"
                >
                  {p * 100}%
                </button>
              ))}
            </div>
          </div>

          {/* Quick sell buttons */}
          <div>
            <p className="text-xs text-slate-400 mb-1">賣出（以持倉比例）</p>
            <div className="grid grid-cols-4 gap-1">
              {[0.25, 0.5, 0.75, 1].map((p) => (
                <button
                  key={p}
                  onClick={() => sellPercent(p)}
                  disabled={metrics.shares <= 0}
                  className="py-2 rounded bg-red-700 hover:bg-red-600 disabled:opacity-30 text-xs font-bold transition"
                >
                  {p * 100}%
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div>
            <p className="text-xs text-slate-400 mb-1">
              輸入股數（可買最多：{maxBuy.toLocaleString()} 股）
            </p>
            <input
              type="number"
              value={shareInput}
              onChange={(e) => setShareInput(e.target.value)}
              placeholder="輸入股數"
              className="w-full bg-slate-700 rounded px-3 py-2 text-sm text-white border border-slate-600 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleBuy}
              disabled={metrics.cash <= 0 || currentPrice <= 0}
              className="py-2 rounded bg-green-700 hover:bg-green-600 disabled:opacity-30 text-sm font-bold transition"
            >
              買入
            </button>
            <button
              onClick={handleSell}
              disabled={metrics.shares <= 0}
              className="py-2 rounded bg-red-700 hover:bg-red-600 disabled:opacity-30 text-sm font-bold transition"
            >
              賣出
            </button>
          </div>
        </>
      )}

      <p className="text-xs text-slate-500 text-center">
        ＊以當前收盤價成交，含手續費與稅
      </p>
    </div>
  );
}
