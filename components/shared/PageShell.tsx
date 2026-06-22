'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NavigationProgress from '@/components/NavigationProgress';
import {
  Moon, Sun,
  Briefcase,
  Activity,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageShellProps {
  children: React.ReactNode;
  /** Slot for page-specific header content (e.g. StockSelector on chart page) */
  headerSlot?: React.ReactNode;
  /** Use full-viewport mode (no scroll on main). For chart/daytrade pages. */
  fullViewport?: boolean;
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PageShell({ children, headerSlot, fullViewport, className }: PageShellProps) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    const base = href.split('?')[0];
    // /agents 不要在子路徑 /agents/pool 上亮（避免父子同時 active）
    if (base === '/agents' && pathname.startsWith('/agents/pool')) return false;
    return pathname.startsWith(base);
  };

  return (
    <div className={cn(
      'flex flex-col bg-background text-foreground',
      fullViewport ? 'h-screen overflow-hidden' : 'min-h-screen',
    )}>
      <NavigationProgress />
      {/* Skip to content */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-sky-600 focus:text-white focus:rounded-lg focus:text-sm">
        跳到主要內容
      </a>

      {/* ── Top Navigation ── */}
      <header role="banner" className="shrink-0 border-b border-border bg-background px-3 sticky top-0 z-50">
        <div className="h-12 flex items-center gap-2">

          {/* Header slot (e.g. StockSelector) */}
          {headerSlot && (
            <div className="shrink-0">{headerSlot}</div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* 輔助導覽（桌機 + 行動都顯示）— 2026-06-21 移除「全部頁面」側邊選單後唯一的 header 入口
              整合進首頁原則：所有「日常看股」功能在首頁 TodayBriefing + DecisionPanel + 右側 tab
              nav 只留「編輯持倉」和「系統健康」兩個必要管理入口
              其餘舊頁路由保留、可手打 URL (today/growth/risk/sizer/watchlist/journal/realtime) */}
          <nav aria-label="輔助導覽" className="flex items-center gap-0.5">
            {([
              { href: '/portfolio', label: '持倉',     icon: Briefcase },
              { href: '/health',    label: '系統健康',  icon: Activity },
            ] as const).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={label}
                className={cn(
                  'p-2 rounded-md transition-colors',
                  isActive(href)
                    ? 'text-sky-400 bg-sky-500/10'
                    : 'text-muted-foreground hover:text-foreground/80 hover:bg-secondary',
                )}
              >
                <Icon className="w-4 h-4" />
              </Link>
            ))}

            {/* Divider */}
            <span className="w-px h-5 bg-border mx-1" />

            {/* Theme Toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切換主題"
              className="text-muted-foreground hover:text-foreground/80 w-8 h-8"
            >
              <Sun className="w-4 h-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute w-4 h-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>
          </nav>
        </div>
      </header>

      {/* ── Page Content ── */}
      <main id="main-content" role="main" className={cn('flex-1', fullViewport && 'overflow-hidden', className)}>
        {children}
      </main>
    </div>
  );
}
