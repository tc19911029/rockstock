'use client';

// 三色「買賣 SOP 速查卡」— 可收合，走圖時隨時對照回測推導的買賣規則。
// 內容吃 lib/cn-sanse/sopReference.ts（靜態常數，與 data/sanse-trading-sop.md 同步維護）。
// 純顯示不算指標；market 非 TW/CN 不渲染（與 SellHeavinessReference 同規）。

import { cn } from '@/lib/utils';
import { SOP_AS_OF, SOP_ENTRY_ORDER, SOP_TERMS, SOP_BOOK_RULES, SOP_REFERENCE } from '@/lib/cn-sanse/sopReference';

export function SanSeSopCard({ market, className }: { market?: 'TW' | 'CN' | 'other'; className?: string }) {
  if (market !== 'TW' && market !== 'CN') return null;
  const ref = SOP_REFERENCE[market];
  return (
    <details className={cn('rounded-md ring-1 ring-foreground/10 bg-card/40 group', className)}>
      <summary className="cursor-pointer select-none list-none p-2 text-[11px] font-medium text-foreground/90 flex items-center gap-1">
        <span className="text-[9px] text-muted-foreground transition-transform group-open:rotate-90">▶</span>
        📖 買賣 SOP 速查（{market === 'TW' ? '台股' : '陸股'}·{SOP_AS_OF}回測）
      </summary>
      <div className="px-2 pb-2 space-y-1.5 text-[10px] leading-relaxed">
        <div className="text-muted-foreground">
          <span className="text-foreground font-medium">進場順序：</span>{SOP_ENTRY_ORDER}
        </div>
        <div className="text-[9px] text-muted-foreground">
          <span className="text-foreground/80 font-medium">名詞：</span>{SOP_TERMS}
        </div>

        <table className="w-full text-left">
          <thead>
            <tr className="text-[9px] text-muted-foreground border-b border-border/40">
              <th className="font-normal py-0.5 pr-1">買進組合（把握度↓）</th>
              <th className="font-normal py-0.5 pr-1 text-right">買後5天</th>
              <th className="font-normal py-0.5 pr-1 text-right">勝率</th>
              <th className="font-normal py-0.5">用法</th>
            </tr>
          </thead>
          <tbody>
            {ref.buys.map((b) => (
              <tr key={b.name} className="border-b border-border/20 last:border-0">
                <td className="py-0.5 pr-1 text-foreground/90 whitespace-nowrap">{b.name}</td>
                <td className="py-0.5 pr-1 text-right tabular-nums">{b.d5}</td>
                <td className="py-0.5 pr-1 text-right tabular-nums">{b.win}</td>
                <td className="py-0.5 text-muted-foreground">{b.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-muted-foreground"><span className="text-foreground font-medium">別做：</span>{ref.avoid}</div>

        <div className="pt-1 border-t border-border/40 space-y-0.5 text-muted-foreground">
          <div><span className="text-foreground font-medium">短線出場：</span>{ref.exitShort}</div>
          <div><span className="text-foreground font-medium">中線出場：</span>{ref.exitMid}</div>
          <div><span className="text-rose-300 font-medium">🔴 重賣訊：</span>{ref.heavySells}</div>
          <div><span className="text-foreground font-medium">↩️ 落後反指：</span>{ref.laggingSells}</div>
        </div>

        <div className="pt-1 border-t border-border/40 text-[9px] text-muted-foreground">
          {SOP_BOOK_RULES}。提醒：最好的組合勝率也只有 44~51%（近半單子小賠），賺錢靠賺多賠少＋停損紀律，不是必勝。白話完整版見 data/sanse-trading-sop.md。
        </div>
      </div>
    </details>
  );
}
