'use client';

import { ANTI_SIGNALS, PRICE_VOLUME_NOT_AVOID_NOTE, type AntiMarket } from '@/lib/avoidance/antiSignals';

/**
 * 反指標教學卡（A3）— 「現在什麼別碰」。資料走 lib/avoidance/antiSignals 單一事實。
 * 純參考/教學（不硬剔除任何股）；可選 market 過濾。
 */
export function AntiSignalGuide({ market }: { market?: 'TW' | 'CN' }) {
  const items = ANTI_SIGNALS.filter((s) => !market || s.market === 'both' || s.market === (market as AntiMarket));
  const sevClass = (sev: 'high' | 'medium') =>
    sev === 'high'
      ? 'bg-red-500/15 text-red-400 border-red-500/30'
      : 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30';

  return (
    <details className="rounded-xl bg-card ring-1 ring-foreground/10 overflow-hidden group">
      <summary className="cursor-pointer select-none px-4 py-3 font-semibold text-foreground/90 hover:bg-muted/40 transition-colors flex items-center gap-2">
        <span>⚠️ 反指標：現在什麼「別碰」</span>
        <span className="text-xs font-normal text-muted-foreground">（回測最可靠的發現，比「該買」準）</span>
        <span className="ml-auto text-muted-foreground text-xs group-open:hidden">展開 ▾</span>
        <span className="ml-auto text-muted-foreground text-xs hidden group-open:inline">收合 ▴</span>
      </summary>
      <div className="px-4 pb-4 pt-1 space-y-2">
        {items.map((s) => (
          <div key={s.id} className="rounded-lg border border-border bg-background/40 px-3 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${sevClass(s.severity)}`}>
                {s.severity === 'high' ? '高' : '中'}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
                {s.market === 'both' ? '台/陸' : s.market === 'CN' ? '陸股' : '台股'}
              </span>
              <span className="font-medium text-sm">{s.title}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{s.evidence}</p>
          </div>
        ))}
        <p className="text-xs text-muted-foreground/80 leading-relaxed border-t border-border pt-2 mt-1">
          {PRICE_VOLUME_NOT_AVOID_NOTE}
        </p>
      </div>
    </details>
  );
}
