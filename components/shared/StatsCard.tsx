import { cn } from '@/lib/utils';

/**
 * StatsCard — 統一的「數字卡」（B1）。給各頁顯示單一指標，走主題 CSS 變數、不寫死顏色。
 * 用法：<StatsCard label="今日成交額" value="3.21 兆" sub="+2.1% vs 昨日" tone="bull" />
 */
export interface StatsCardProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** 數值色調：預設 foreground；bull=漲色、bear=跌色、muted=次要 */
  tone?: 'default' | 'bull' | 'bear' | 'muted';
  icon?: React.ReactNode;
  className?: string;
}

const toneClass: Record<NonNullable<StatsCardProps['tone']>, string> = {
  default: 'text-foreground',
  bull: 'text-bull',
  bear: 'text-bear',
  muted: 'text-muted-foreground',
};

export function StatsCard({ label, value, sub, tone = 'default', icon, className }: StatsCardProps) {
  return (
    <div className={cn('rounded-xl bg-card ring-1 ring-foreground/10 px-4 py-3 flex flex-col gap-1', className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn('text-xl font-semibold font-mono tabular-nums', toneClass[tone])}>{value}</div>
      {sub != null && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
