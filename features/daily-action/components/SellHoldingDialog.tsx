'use client';

import { useEffect, useState } from 'react';
import { usePortfolioStore, type PortfolioHolding } from '@/store/portfolioStore';

interface SellHoldingDialogProps {
  holding: PortfolioHolding;
  /** 系統建議的賣出價（會帶進輸入框預設值） */
  suggestedPrice?: number;
  /** 系統建議的賣出原因（如「跌破停損」「頭頭低」），會帶進備註預設值 */
  suggestedReason?: string;
  onClose: () => void;
}

export function SellHoldingDialog({ holding, suggestedPrice, suggestedReason, onClose }: SellHoldingDialogProps) {
  const sell = usePortfolioStore(s => s.sell);
  const [sellPrice, setSellPrice] = useState(
    suggestedPrice && suggestedPrice > 0 ? suggestedPrice.toFixed(2) : holding.costPrice.toFixed(2),
  );
  const [sellDate, setSellDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [reason, setReason] = useState(suggestedReason ?? '');

  useEffect(() => {
    if (suggestedPrice && suggestedPrice > 0) setSellPrice(suggestedPrice.toFixed(2));
    if (suggestedReason) setReason(suggestedReason);
  }, [suggestedPrice, suggestedReason]);

  const sp = parseFloat(sellPrice);
  const valid = sp > 0;
  const realizedPL = valid ? (sp - holding.costPrice) * holding.shares : 0;
  const realizedPLPct = valid && holding.costPrice > 0
    ? ((sp - holding.costPrice) / holding.costPrice) * 100
    : 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    sell(holding.id, sp, sellDate, reason || undefined);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl p-4 w-96 max-w-[95vw] space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-foreground">
            ✅ 賣出 {holding.symbol} {holding.name}
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-muted-foreground mb-1">賣出價</label>
              <input
                type="number"
                step="0.01"
                value={sellPrice}
                onChange={e => setSellPrice(e.target.value)}
                className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-muted-foreground mb-1">賣出日期</label>
              <input
                type="date"
                value={sellDate}
                onChange={e => setSellDate(e.target.value)}
                className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
              />
            </div>
          </div>

          <div>
            <label className="block text-muted-foreground mb-1">原因（選填）</label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="例：跌破停損 / 觸發戒律 / 主動獲利了結"
              className="w-full px-2 py-1 bg-secondary/40 border border-border rounded text-foreground"
            />
          </div>

          {/* 即時計算結果 */}
          <div className="border-t border-border pt-2 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">成本</span>
              <span>{holding.costPrice.toFixed(2)} × {holding.shares.toLocaleString()} = {(holding.costPrice * holding.shares).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">賣出</span>
              <span>{valid ? `${sp.toFixed(2)} × ${holding.shares.toLocaleString()} = ${(sp * holding.shares).toLocaleString()}` : '—'}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>實現損益</span>
              <span className={realizedPL >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {realizedPL >= 0 ? '+' : ''}{realizedPL.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({realizedPLPct >= 0 ? '+' : ''}{realizedPLPct.toFixed(2)}%)
              </span>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={!valid}
              className="flex-1 px-3 py-1.5 bg-emerald-500/80 hover:bg-emerald-500 disabled:opacity-40 text-white rounded font-semibold"
            >
              確認賣出（記錄損益）
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-secondary border border-border hover:bg-muted text-foreground rounded"
            >
              取消
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
