'use client';

// 賣訊「輕重」參考卡 — 把 scripts/backtest-sell-heaviness 的結論，依市場列出常見出場訊號的輕重。
// 給走圖以外的地方（/agents/[symbol]、首頁籌碼/基本面 tab…）一個一致的「這檔的賣訊該不該信」速查。
// 純查表（lib/analysis/sellHeavinessTable.ts），不需即時算；同訊號台/陸不同（會自動切）。

import { cn } from '@/lib/utils';
import { lookupSellHeaviness, SELL_HEAVINESS_WINDOW } from '@/lib/analysis/sellHeavinessTable';
import { HeavinessBadge } from './HeavinessBadge';

const SANSE_SELLS = [
  { id: 'c_dead', short: '捕撈死叉' },
  { id: 'b_breakdn', short: '智能線跌破' },
  { id: 'b_dead', short: '雙B死叉' },
  { id: 'b_sresonance', short: '雙重共振' },
];

// 書本出場法挑「最具決策意義」的：重的（KD死叉/吊人/爆量上影/急漲長黑）+ 出名但其實落後的（跌破月線/死亡交叉）。
const BOOK_SELLS = [
  { id: 'KD_DEATH_CROSS', short: 'KD高位死叉' },
  { id: 'HIGH_VOL_UPPER_SHADOW', short: '高檔爆量上影' },
  { id: 'HIGH_LEVEL_HANGING_MAN', short: '高檔吊人' },
  { id: 'PROFIT_CLIMAX_EXIT', short: '急漲後長黑' },
  { id: 'BREAK_MA20', short: '跌破月線' },
  { id: 'DEATH_CROSS', short: '死亡交叉' },
];

function Row({ market, title, items }: { market: 'TW' | 'CN'; title: string; items: { id: string; short: string }[] }) {
  const got = items
    .map((it) => ({ ...it, e: lookupSellHeaviness(market, it.id) }))
    .filter((x): x is { id: string; short: string; e: NonNullable<typeof x.e> } => x.e != null);
  if (got.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-1 items-center">
      <span className="text-[9px] text-muted-foreground w-10 shrink-0">{title}</span>
      {got.map((x) => (
        <span key={x.id} className="inline-flex items-center gap-1 text-[10px]">
          <span className="text-muted-foreground">{x.short}</span>
          <HeavinessBadge entry={x.e} />
        </span>
      ))}
    </div>
  );
}

/** 賣訊輕重速查卡。market 非 TW/CN → 不渲染。 */
export function SellHeavinessReference({
  market, className, showBook = true,
}: { market: 'TW' | 'CN' | 'other' | undefined; className?: string; showBook?: boolean }) {
  if (market !== 'TW' && market !== 'CN') return null;
  return (
    <div className={cn('rounded-md ring-1 ring-foreground/10 bg-card/40 p-2 space-y-1.5', className)}>
      <div className="text-[10px] text-muted-foreground leading-snug">
        🔻 賣訊輕重（{market === 'TW' ? '台股' : '陸股'}·{SELL_HEAVINESS_WINDOW.label}回測）— 數字＝訊號後相對同儕的 alpha，<span className="text-foreground/80">越負越重</span>；🔴重 🟠中 🟡輕 ↩️落後(反指) ◦弱(不顯著)。
      </div>
      <Row market={market} title="三色" items={SANSE_SELLS} />
      {showBook && <Row market={market} title="書本" items={BOOK_SELLS} />}
    </div>
  );
}
