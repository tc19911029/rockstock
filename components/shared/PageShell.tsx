'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NavigationProgress from '@/components/NavigationProgress';
import {
  Moon, Sun, Briefcase, Activity,
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

      {/* ── Top Navigation ── */}
      <header role="banner" className="shrink-0 border-b border-border bg-background/95 backdrop-blur px-3 sticky top-0 z-50">
        <div className="min-h-12 w-full flex flex-wrap xl:flex-nowrap items-center gap-x-3">

          {/* Header slot (e.g. StockSelector) */}
          {headerSlot && (
            <div className="order-2 w-full min-w-0 py-1 xl:order-1 xl:w-auto xl:shrink-0 xl:py-0">{headerSlot}</div>
          )}

          {/* 日常工作集中在首頁；只保留必要管理入口，避免把內部路由當產品選單。 */}
          <nav aria-label="輔助導覽" className="order-1 ml-auto hidden xl:flex items-center gap-1">
            {([
              { href: '/portfolio', label: '持倉', icon: Briefcase },
              { href: '/health', label: '系統健康', icon: Activity },
            ] as const).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={label}
                aria-label={label}
                aria-current={isActive(href) ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 items-center gap-1.5 px-2.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  isActive(href)
                    ? 'text-sky-400 bg-sky-500/10'
                    : 'text-muted-foreground hover:text-foreground/80 hover:bg-secondary',
                )}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
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
              className="text-muted-foreground hover:text-foreground/80 w-11 h-11"
            >
              <Sun className="w-4 h-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute w-4 h-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>
          </nav>

          <nav aria-label="行動版輔助導覽" className="order-1 ml-auto flex xl:hidden items-center gap-1">
            {([
              { href: '/portfolio', label: '持倉', icon: Briefcase },
              { href: '/health', label: '系統健康', icon: Activity },
            ] as const).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={isActive(href) ? 'page' : undefined}
                className={cn(
                  'inline-flex size-11 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive(href) ? 'text-sky-400 bg-sky-500/10' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </Link>
            ))}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切換主題"
              className="relative size-11 text-muted-foreground hover:text-foreground"
            >
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>
          </nav>
        </div>
      </header>

      {/* ── Page Content ── */}
      <main id="main-content" tabIndex={-1} className={cn('flex-1 min-w-0 focus:outline-none', fullViewport && 'overflow-hidden', className)}>
        {children}
      </main>
    </div>
  );
}
