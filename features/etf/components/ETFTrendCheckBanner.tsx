'use client';

// ETF 趨勢出場檢查橫幅（直播課 2026-07-01 Q53）— 大盤型 ETF + 持倉 ETF 的日/週線趨勢一行結論。
// 純顯示層；資料來自 /api/etf/trend-check（server 端讀 L1 算 detectTrend 日線+週線）。

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface Item {
  symbol: string;
  name: string;
  dailyTrend: string;
  weeklyTrend: string;
  verdict: string;
  tone: 'exit' | 'warn' | 'hold';
}

const TONE_CLS: Record<Item['tone'], string> = {
  exit: 'border-bear/60 bg-bear/10 text-bear',
  warn: 'border-amber-500/50 bg-amber-500/10 text-amber-500',
  hold: 'border-border bg-card text-muted-foreground',
};

export function ETFTrendCheckBanner() {
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/etf/trend-check')
      .then((r) => r.json())
      .then((j) => { if (alive) setItems((j?.data?.items ?? j?.items ?? []) as Item[]); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted-foreground">
        📐 ETF 趨勢檢查（課程：日線轉空出場；長抱看週線，週線轉空必須走）
      </div>
      {items.map((it) => (
        <div key={it.symbol} className={cn('rounded-md border px-2.5 py-1.5 text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5', TONE_CLS[it.tone])}>
          <span className="font-medium text-foreground">{it.symbol}{it.name !== it.symbol ? ` ${it.name}` : ''}</span>
          <span className="text-muted-foreground">日線{it.dailyTrend}・週線{it.weeklyTrend}</span>
          <span>{it.verdict}</span>
        </div>
      ))}
    </div>
  );
}
