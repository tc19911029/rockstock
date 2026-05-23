'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NavigationProgress from '@/components/NavigationProgress';
import {
  Moon, Sun,
  Star, Briefcase, Menu, TrendingUp,
  PlaySquare, Brain, Activity, Settings, FileText, Layers,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { Button } from '@/components/ui/button';
import {
  Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useState } from 'react';

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
  const [mobileOpen, setMobileOpen] = useState(false);

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

          {/* Secondary Nav — desktop icon-only + settings dropdown */}
          <nav aria-label="輔助導覽" className="hidden md:flex items-center gap-0.5">
            {/* Primary tools */}
            {([
              { href: '/watchlist', label: '自選股',   icon: Star },
              { href: '/portfolio', label: '持倉',     icon: Briefcase },
              { href: '/etf',       label: 'ETF追蹤', icon: TrendingUp },
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

            {/* Analysis tools */}
            {([
              { href: '/youtube',      label: 'YouTube 節目分析', icon: PlaySquare },
              { href: '/agents/pool',  label: '候選股票池',       icon: Layers },
              { href: '/agents',       label: '多代理決策中心',   icon: Brain },
              { href: '/health',       label: '資料健康',         icon: Activity },
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

          {/* Mobile Menu */}
          <div className="md:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={<Button variant="ghost" size="icon" aria-label="開啟選單" className="text-muted-foreground w-8 h-8" />}
              >
                <Menu className="w-5 h-5" />
              </SheetTrigger>
              <SheetContent side="right" className="w-64 bg-background border-border">
                <SheetHeader>
                  <SheetTitle className="text-sky-400">
                    選單
                  </SheetTitle>
                </SheetHeader>
                <nav aria-label="行動版導覽" className="flex flex-col gap-4 mt-4 px-2">
                  {/* Mobile: grouped nav */}
                  {([
                    {
                      title: '主要工具',
                      items: [
                        { href: '/watchlist', label: '⭐ 自選股',   icon: Star },
                        { href: '/portfolio', label: '💼 持倉',     icon: Briefcase },
                        { href: '/etf',       label: '📈 ETF 追蹤', icon: TrendingUp },
                      ],
                    },
                    {
                      title: '分析',
                      items: [
                        { href: '/youtube',     label: '📺 YouTube 節目分析', icon: PlaySquare },
                        { href: '/agents/pool', label: '🗂️ 候選股票池',       icon: Layers },
                        { href: '/agents',      label: '🤖 多代理決策中心',   icon: Brain },
                      ],
                    },
                    {
                      title: '系統',
                      items: [
                        { href: '/health',     label: '💚 資料健康',   icon: Activity },
                        { href: '/settings',   label: '⚙️ 設定',       icon: Settings },
                        { href: '/disclaimer', label: '📄 免責聲明',   icon: FileText },
                      ],
                    },
                  ] as const).map((group) => (
                    <div key={group.title} className="flex flex-col gap-1">
                      <div className="px-3 text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
                        {group.title}
                      </div>
                      {group.items.map(({ href, label, icon: Icon }) => (
                        <Link
                          key={href}
                          href={href}
                          onClick={() => setMobileOpen(false)}
                          className={cn(
                            'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                            isActive(href)
                              ? 'bg-sky-500/15 text-sky-400'
                              : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                          )}
                        >
                          <Icon className="w-4 h-4" />
                          {label}
                        </Link>
                      ))}
                    </div>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      {/* ── Page Content ── */}
      <main id="main-content" role="main" className={cn('flex-1', fullViewport && 'overflow-hidden', className)}>
        {children}
      </main>
    </div>
  );
}
