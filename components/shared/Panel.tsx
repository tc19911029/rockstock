import { cn } from '@/lib/utils';

/**
 * Panel — 全站統一面板卡（2026-06-14）。
 *
 * = 首頁(走圖主圖)同款卡片視覺：大圓角 + 細光環(ring) + bg-card，
 * 取代各頁各自手刻的 `rounded-xl ring-1 ring-foreground/10 bg-card`（看起來一頁一個樣）。
 * 新面板/區塊一律用 <Panel>，讓全站像同一個產品。
 *
 * 用法：
 *   <Panel>
 *     <PanelTitle title="標題" subtitle="小字" actions={<button/>} />
 *     <PanelBody>內容</PanelBody>
 *   </Panel>
 * 表格類可直接 <Panel className="overflow-hidden"><table/></Panel>（表格自管 padding）。
 */
export function Panel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-xl bg-card ring-1 ring-foreground/10 overflow-hidden', className)}
      {...props}
    />
  );
}

/** 統一的面板標題列（對齊首頁 CardTitle：font-heading text-base font-medium）。 */
export function PanelTitle({
  title,
  subtitle,
  actions,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-2 px-4 pt-3.5 pb-2', className)}>
      <div className="min-w-0">
        <h2 className="font-heading text-base font-medium leading-snug">{title}</h2>
        {subtitle != null && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {actions != null && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
    </div>
  );
}

/** 面板內容區（統一左右 padding，對齊 CardContent px-4）。 */
export function PanelBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}
