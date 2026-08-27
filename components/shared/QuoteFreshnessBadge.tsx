'use client';

export function QuoteFreshnessBadge({
  stale,
  asOf,
  reason,
  compact = false,
}: {
  stale?: boolean;
  asOf?: string | null;
  reason?: string;
  compact?: boolean;
}) {
  if (!stale) return null;
  const label = compact ? `延遲 ${asOf ?? ''}`.trim() : `行情延遲${asOf ? ` · ${asOf}` : ''}`;
  return (
    <span
      role="status"
      title={reason ?? '目前顯示的是最後一筆可信價格，不是最新行情'}
      className="inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
    >
      {label}
    </span>
  );
}
