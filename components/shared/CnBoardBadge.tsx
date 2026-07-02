// 陸股板塊徽章：科創板 / 創業板（主板、北交所、非陸股 → 不顯示）。
// 板塊判定走單一事實 cnBoard（lib/utils/limitRules，與漲停 20% 同一份規則）。
import { cnBoard } from '@/lib/utils/limitRules';
import { cn } from '@/lib/utils';

const STYLE: Record<'star' | 'chinext', { label: string; cls: string; title: string }> = {
  star: {
    label: '科創板',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
    title: '科創板（688/689）· 漲跌停 ±20%',
  },
  chinext: {
    label: '創業板',
    cls: 'bg-sky-500/15 text-sky-300 border-sky-400/40',
    title: '創業板（300-302）· 漲跌停 ±20%',
  },
};

/** 依代號顯示科創/創業徽章；其餘板塊回 null（不佔位）。 */
export function CnBoardBadge({ symbol, className }: { symbol: string; className?: string }) {
  const board = cnBoard(symbol);
  if (board !== 'star' && board !== 'chinext') return null;
  const s = STYLE[board];
  return (
    <span
      title={s.title}
      className={cn(
        'px-1 py-0.5 rounded border text-[9px] font-medium leading-none shrink-0',
        s.cls,
        className,
      )}
    >
      {s.label}
    </span>
  );
}
