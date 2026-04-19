'use client';

import { useState } from 'react';
import { usePortfolioStore } from '@/store/portfolioStore';
import type { MarketId } from '@/lib/scanner/types';

interface AddHoldingFormProps {
  /** 表單送出後關閉 */
  onClose?: () => void;
}

export function AddHoldingForm({ onClose }: AddHoldingFormProps) {
  const add = usePortfolioStore(s => s.add);
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [market, setMarket] = useState<MarketId>('TW');
  const [shares, setShares] = useState('1000');
  const [costPrice, setCostPrice] = useState('');
  const [buyDate, setBuyDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const sharesNum = parseFloat(shares);
    const costNum = parseFloat(costPrice);

    if (!symbol.trim()) return setError('請輸入股票代號');
    if (!sharesNum || sharesNum <= 0) return setError('股數需大於 0');
    if (!costNum || costNum <= 0) return setError('成本價需大於 0');

    add({
      symbol: symbol.trim().toUpperCase(),
      name: name.trim() || symbol.trim().toUpperCase(),
      market,
      shares: sharesNum,
      costPrice: costNum,
      buyDate,
      // entryKbar 留 undefined：後端會用 -7% 估停損；以後可加「自動補入」按鈕
    });

    setSymbol('');
    setName('');
    setShares('1000');
    setCostPrice('');
    onClose?.();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-muted-foreground mb-1">代號</label>
          <input
            type="text"
            value={symbol}
            onChange={e => setSymbol(e.target.value)}
            placeholder="2345"
            className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
          />
        </div>
        <div>
          <label className="block text-muted-foreground mb-1">名稱（可空）</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="智邦"
            className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="block text-muted-foreground mb-1">市場</label>
          <select
            value={market}
            onChange={e => setMarket(e.target.value as MarketId)}
            className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
          >
            <option value="TW">台股</option>
            <option value="CN">陸股</option>
          </select>
        </div>
        <div>
          <label className="block text-muted-foreground mb-1">股數</label>
          <input
            type="number"
            value={shares}
            onChange={e => setShares(e.target.value)}
            step={market === 'TW' ? '1000' : '100'}
            className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
          />
        </div>
        <div>
          <label className="block text-muted-foreground mb-1">成本價</label>
          <input
            type="number"
            value={costPrice}
            onChange={e => setCostPrice(e.target.value)}
            step="0.01"
            className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
          />
        </div>
      </div>

      <div>
        <label className="block text-muted-foreground mb-1">買進日期</label>
        <input
          type="date"
          value={buyDate}
          onChange={e => setBuyDate(e.target.value)}
          className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
        />
      </div>

      {error && <div className="text-red-400 text-xs">{error}</div>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          className="flex-1 px-3 py-1.5 bg-blue-500/80 hover:bg-blue-500 text-white rounded font-semibold"
        >
          新增持倉
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 bg-secondary border border-border hover:bg-muted text-foreground rounded"
          >
            取消
          </button>
        )}
      </div>
    </form>
  );
}
