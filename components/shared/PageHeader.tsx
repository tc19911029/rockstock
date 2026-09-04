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
    <div className={cn('flex w-full min-w-0 flex-wrap items-center gap-2 text-xs', className)}>
      {showBack && <BackButton href={backHref} />}
      <h1 className="font-bold text-base sm:text-lg whitespace-nowrap shrink-0">{title}</h1>
      {subtitle && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{subtitle}</span>
      )}
      {actions && (
        <div className="flex w-full flex-wrap items-center justify-end gap-1.5 sm:ml-auto sm:w-auto sm:shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
