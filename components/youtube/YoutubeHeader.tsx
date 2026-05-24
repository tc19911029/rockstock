'use client';

/**
 * /youtube 系列頁面共用子導覽列：
 *   - tab nav（今日 / 跨日趨勢）
 *   - 日期導覽（← / 今日 / → + 日期 picker）— 只在 date prop 有給時顯示
 *   - optional 匯出按鈕
 *
 * 注意：頁面的「主標題 + 返回鍵 + 主要動作」走 PageShell.headerSlot 的 PageHeader，
 * 不在這個元件內。這裡只放每頁共用的 tab/date 操作列。
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DatePicker } from '@/components/ui/DatePicker';

interface YoutubeHeaderProps {
  /** 當前日期（YYYY-MM-DD），給才會渲染日期導覽 */
  date?: string;
  onDateChange?: (next: string) => void;
  /** 渲染下載 .md 按鈕（傳 date 才生效） */
  showExportButton?: boolean;
}

const TABS = [
  { href: '/youtube',        label: '今日總覽' },
  { href: '/youtube/replay', label: '走圖' },
  { href: '/youtube/trends', label: '跨日趨勢' },
];

export function YoutubeHeader({ date, onDateChange, showExportButton }: YoutubeHeaderProps) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/youtube' ? pathname === '/youtube' : pathname.startsWith(href);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Tabs */}
        <nav className="flex items-center gap-1 rounded-lg border border-border bg-card overflow-hidden">
          {TABS.map(t => (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                isActive(t.href)
                  ? 'bg-sky-500 text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {/* Export */}
        {showExportButton && date && (
          <a
            href={`/api/youtube/report/${date}?format=md&download=1`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-xs text-sky-300 hover:bg-sky-500/20 transition-colors"
            title="下載報告"
          >
            <Download className="w-3 h-3" />
            <span>匯出</span>
          </a>
        )}
      </div>

      {/* Date pill grid（仿策略掃描）— 獨佔一行 */}
      {date && onDateChange && (
        <DatePicker value={date} onChange={onDateChange} size="md" />
      )}
    </div>
  );
}
