'use client';

// 賣訊「輕重」徽章 — 把 scripts/backtest-sell-heaviness 的回測結論貼到訊號旁，方便當下判斷。
//   重/中/輕 = 訊號後相對同儕的前瞻 alpha 大小（越負越重）；落後 = 反指（破線時多已走完）；
//   弱 = 統計不顯著/樣本少，別單獨據此動作。資料源 lib/analysis/sellHeavinessTable.ts（每市場不同）。

import { cn } from '@/lib/utils';
import { lookupSellHeaviness, type SellHeavinessEntry, type SellTier } from '@/lib/analysis/sellHeavinessTable';

const TIER: Record<SellTier, { label: string; icon: string; cls: string; full: string }> = {
  heavy:   { label: '重',   icon: '🔴', cls: 'bg-red-900/40 text-red-300 border-red-500/40',       full: '重（訊號後明顯弱於同儕）' },
  medium:  { label: '中',   icon: '🟠', cls: 'bg-orange-900/40 text-orange-300 border-orange-500/40', full: '中（會輸同儕但非急殺）' },
  light:   { label: '輕',   icon: '🟡', cls: 'bg-yellow-900/30 text-yellow-300 border-yellow-500/30', full: '輕（慢慢輸同儕、非急殺）' },
  lagging: { label: '落後', icon: '↩️', cls: 'bg-sky-900/30 text-sky-300 border-sky-500/30',         full: '落後/反指（破線時行情多已走完）' },
  noisy:   { label: '弱',   icon: '◦',  cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-600/50',       full: '弱（統計不顯著／樣本少）' },
};

const fmt = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(1);

function tooltip(e: SellHeavinessEntry): string {
  const t = TIER[e.tier];
  const sev = e.declaredSeverity
    ? `手寫${e.declaredSeverity === 'high' ? '高' : e.declaredSeverity === 'medium' ? '中' : '低'}→${
        e.verdict === 'underrated' ? '實測更重(低估)' : e.verdict === 'overrated' ? '實測較輕(高估)' : '相符'}｜`
    : '';
  return `${t.full}｜α(越負越重) d5/d10/d20=${fmt(e.alphaD5)}/${fmt(e.alphaD10)}/${fmt(e.alphaD20)}｜`
    + `觸發${e.firings} ${e.significant ? '顯著' : '不顯著'}${e.stable ? '·穩定' : ''}｜${sev}${e.note}`;
}

/** 直接吃 entry（已查好）。 */
export function HeavinessBadge({ entry, className }: { entry: SellHeavinessEntry | null; className?: string }) {
  if (!entry) return null;
  const t = TIER[entry.tier];
  // 重/中/輕/落後 帶 alpha 數字；弱（不可信）不放數字避免誤導。
  const showAlpha = entry.tier !== 'noisy';
  const underrated = entry.verdict === 'underrated';
  return (
    <span
      title={tooltip(entry)}
      className={cn(
        'inline-flex items-center gap-0.5 px-1 py-px rounded border text-[9px] leading-none whitespace-nowrap align-middle',
        t.cls, className,
      )}
    >
      <span>{t.icon}{t.label}</span>
      {showAlpha && <span className="opacity-80 tabular-nums">{fmt(entry.worst)}</span>}
      {underrated && <span title="手寫嚴重度偏低，值得更當心">⚠</span>}
    </span>
  );
}

/** 便利版：吃 (market, signalId) 自己查表。查無 → 不渲染。 */
export function HeavinessBadgeFor({ market, signalId, className }: {
  market: 'TW' | 'CN' | 'other' | undefined; signalId: string; className?: string;
}) {
  return <HeavinessBadge entry={lookupSellHeaviness(market, signalId)} className={className} />;
}
