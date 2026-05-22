'use client';

/**
 * /youtube 系列頁面共用 header：
 *   - 標題 + 副標
 *   - 日期導覽（← / 今日 / → + 日期 picker）— 只在 date prop 有給時顯示
 *   - tab nav（今日 / 跨日趨勢）
 *   - 右上「← 回 K 線走圖」連結
 *   - optional 操作按鈕（匯出 / refresh time）
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, ArrowLeft, Download } from 'lucide-react';
import { cn } from '@/lib/utils';

interface YoutubeHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  /** Current date (YYYY-MM-DD). 給才會渲染日期導覽 */
  date?: string;
  onDateChange?: (next: string) => void;
  /** 渲染下載 .md 按鈕（傳 date 才生效） */
  showExportButton?: boolean;
  /** 右側額外操作（refreshedAt 文字、其他按鈕等） */
  rightExtra?: React.ReactNode;
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
  { href: '/youtube/trends', label: '跨日趨勢' },
];

export function YoutubeHeader({
  title, subtitle, date, onDateChange, showExportButton, rightExtra,
}: YoutubeHeaderProps) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === '/youtube' ? pathname === '/youtube' : pathname.startsWith(href);

  const isToday = date === todayYmd();

  return (
    <div className="space-y-3 border-b border-border pb-3 mb-4">
      {/* Top row：返回 + 標題 + 右側額外 */}
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="回 K 線走圖主頁"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>K 線走圖</span>
          </Link>
          <span className="text-muted-foreground/40">/</span>
          <h1 className="text-xl font-bold">{title}</h1>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {rightExtra}
        </div>
      </div>

      {/* Subtitle */}
      {subtitle && (
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      )}

      {/* Tabs + Date nav */}
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
                  ? 'bg-blue-600 text-foreground'
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
                className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="前一日"
                aria-label="前一日"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <input
                type="date"
                value={date}
                onChange={e => onDateChange(e.target.value)}
                className="bg-background border border-border rounded px-2 py-1 text-xs text-foreground tabular-nums"
              />
              <span className="text-xs text-muted-foreground tabular-nums min-w-[3.5rem]">
                {fmtDateLabel(date)}
              </span>
              <button
                type="button"
                onClick={() => onDateChange(shiftDate(date, 1))}
                className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
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
                  'px-2 py-1 rounded border text-xs transition-colors',
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
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-blue-700 bg-blue-900/30 text-xs text-blue-300 hover:bg-blue-900/50 transition-colors"
              title="下載 Markdown 報告"
            >
              <Download className="w-3 h-3" />
              <span>匯出</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
