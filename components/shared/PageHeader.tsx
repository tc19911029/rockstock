'use client';

import { BackButton } from './BackButton';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  /** 主標題（允許 emoji 前綴，e.g. "⭐ 自選股"） */
  title: string;
  /** 副標題（計數、最後更新時間等小字） */
  subtitle?: React.ReactNode;
  /** true=回 '/'；string=指定 href；false/undef=不顯示返回鍵 */
  backButton?: boolean | string;
  /** 右側按鈕區（匯出 / 刷新等） */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * 給 PageShell.headerSlot 用的標準 builder。
 * 用法：
 *   <PageShell headerSlot={<PageHeader title="⭐ 自選股" subtitle={`${n} 支`} backButton actions={<RefreshBtn />} />}>
 */
export function PageHeader({
  title,
  subtitle,
  backButton,
  actions,
  className,
}: PageHeaderProps) {
  const backHref = typeof backButton === 'string' ? backButton : '/';
  const showBack = backButton === true || typeof backButton === 'string';

  return (
    <div className={cn('flex items-center gap-2 text-xs min-w-0', className)}>
      {showBack && <BackButton href={backHref} />}
      <span className="font-bold text-sm whitespace-nowrap shrink-0">{title}</span>
      {subtitle && (
        <span className="text-muted-foreground shrink-0 truncate">{subtitle}</span>
      )}
      {actions && (
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
