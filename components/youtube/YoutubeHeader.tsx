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
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { cn } from '@/lib/utils';

interface YoutubeHeaderProps {
  /** 當前日期（YYYY-MM-DD），給才會渲染日期導覽 */
  date?: string;
  onDateChange?: (next: string) => void;
  /** 渲染下載 .md 按鈕（傳 date 才生效） */
  showExportButton?: boolean;
}

function todayYmd(): string {
  const tpe = new Date(Date.now() + 8 * 3600_000);
  return tpe.toISOString().slice(0, 10);
}

function shiftDate(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function fmtDateLabel(ymd: string): string {
  try {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getUTCDay()];
    return `${m}/${d} (${week})`;
  } catch { return ymd; }
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

  const isToday = date === todayYmd();

  return (
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

      {/* Date nav + export */}
      <div className="flex items-center gap-2">
        {date && onDateChange && (
          <>
            <button
              type="button"
              onClick={() => onDateChange(shiftDate(date, -1))}
              className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
              title="前一日"
              aria-label="前一日"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <input
              type="date"
              value={date}
              onChange={e => onDateChange(e.target.value)}
              className="bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground tabular-nums focus:outline-none focus:border-sky-500"
            />
            <span className="text-xs text-muted-foreground tabular-nums min-w-[3.5rem]">
              {fmtDateLabel(date)}
            </span>
            <button
              type="button"
              onClick={() => onDateChange(shiftDate(date, 1))}
              className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
              title="後一日"
              aria-label="後一日"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDateChange(todayYmd())}
              disabled={isToday}
              className={cn(
                'px-2 py-1 rounded border text-xs transition-colors cursor-pointer',
                isToday
                  ? 'border-border/40 text-muted-foreground/40 cursor-not-allowed'
                  : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
              )}
              title="跳到今日"
            >
              今日
            </button>
          </>
        )}
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
    </div>
  );
}
