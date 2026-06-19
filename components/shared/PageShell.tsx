'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NavigationProgress from '@/components/NavigationProgress';
import {
  Moon, Sun,
  Briefcase, Menu,
  Activity, Settings, FileText,
  Star, TrendingUp, Newspaper, Radio, Calculator, ShieldAlert, BookOpen, Target,
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

          {/* Secondary Nav — desktop icon-only
              整合進首頁原則：所有「日常看股」功能在首頁 TodayBriefing + DecisionPanel
              nav 只留「編輯持倉」和「系統健康」兩個必要管理入口
              其餘舊頁路由保留、可手打 URL (today/growth/risk/sizer/watchlist/journal/realtime/etf) */}
          <nav aria-label="輔助導覽" className="hidden md:flex items-center gap-0.5">
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

          {/* 完整選單（桌面 + 行動都顯示）— UX1：所有頁收進可發現的選單，不再只能手打 URL */}
          <div>
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={<Button variant="ghost" size="icon" aria-label="開啟選單" title="全部頁面" className="text-muted-foreground hover:text-foreground/80 w-8 h-8" />}
              >
                <Menu className="w-5 h-5" />
              </SheetTrigger>
              <SheetContent side="right" className="w-64 bg-background border-border overflow-y-auto">
                <SheetHeader>
                  <SheetTitle className="text-sky-400">
                    全部頁面
                  </SheetTitle>
                </SheetHeader>
                <nav aria-label="全站導覽" className="flex flex-col gap-4 mt-4 px-2">
                  {([
                    {
                      title: '看股 / 追蹤',
                      items: [
                        { href: '/',          label: '🏠 首頁工作台',   icon: Activity },
                        { href: '/watchlist', label: '⭐ 自選股',       icon: Star },
                        { href: '/sectors',   label: '🔥 題材分類',     icon: TrendingUp },
                        { href: '/etf',       label: '📈 ETF 追蹤',     icon: TrendingUp },
                        { href: '/youtube',   label: '📺 YouTube 提及', icon: Newspaper },
                        { href: '/realtime',  label: '📡 分時監控',     icon: Radio },
                        { href: '/backtest/leaderboard', label: '📊 策略排行榜', icon: TrendingUp },
                      ],
                    },
                    {
                      title: '持倉 / 決策',
                      items: [
                        { href: '/portfolio', label: '💼 持倉',     icon: Briefcase },
                        { href: '/sizer',     label: '🧮 部位試算', icon: Calculator },
                        { href: '/risk',      label: '🛡 風險面板',  icon: ShieldAlert },
                        { href: '/journal',   label: '📓 交易日誌', icon: BookOpen },
                        { href: '/growth',    label: '🎯 成長路徑', icon: Target },
                      ],
                    },
                    {
                      title: '系統',
                      items: [
                        { href: '/health',     label: '💚 系統健康',  icon: Activity },
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
