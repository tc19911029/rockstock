'use client';

import {
  BarChart3,
  Bell,
  BellRing,
  Bot,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Crown,
  Gift,
  Gauge,
  Home,
  Layers3,
  ListFilter,
  LogOut,
  Mail,
  Moon,
  Pause,
  Play,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Send,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserRound,
  Vibrate,
  Waves,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { TideProSnapshot, TideProStock } from '@/lib/tide/proData';
import styles from './tide.module.css';

type ThemeMember = {
  code: string;
  name: string;
  d1: number | null;
  d5: number | null;
  d20: number | null;
  d60: number | null;
  instNet5: number | null;
  instAmt: Array<number | null>;
};

type ThemeRank = {
  theme: string;
  stockCount: number;
  avgD1: number | null;
  avgD5: number | null;
  avgD20: number | null;
  avgD60: number | null;
  avgVolRatio: number | null;
  breadth: number | null;
  instNet5: number | null;
  instAmt5: number | null;
  stage: string;
  topStock: { code: string; name: string; d1: number } | null;
  members: ThemeMember[];
};

type StockRef = { code: string; name: string; theme?: string };
type ViewMode = 'bubble' | 'ranking' | 'dual' | 'streak' | 'radar';
type FlowCategory = 'all' | 'flood' | 'rotation' | 'watch' | 'ebb';
type Period = 1 | 5 | 20;
type ThemeMode = 'light' | 'dark' | 'system';
type TextSize = 'small' | 'medium' | 'large';
type RiseColor = 'tw' | 'us';
type AlertTab = 'watch' | 'notifications';

type ChipDay = {
  date: string;
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
};

type Candle = {
  date: string;
  close: number;
};

type StockDetailData = {
  chips: ChipDay[];
  candles: Candle[];
  loading: boolean;
  error: string | null;
};

const CATEGORY_META: Record<Exclude<FlowCategory, 'all'>, { label: string; hint: string; color: string }> = {
  flood: { label: '漲潮', hint: '資金加速流入', color: '#e7795d' },
  rotation: { label: '輪動', hint: '資金流入但放緩', color: '#e7c361' },
  watch: { label: '觀望', hint: '資金流出但放緩', color: '#85a69d' },
  ebb: { label: '退潮', hint: '資金流出', color: '#68ad9c' },
};

const PERIOD_INDEX: Record<Period, number> = { 1: 0, 5: 4, 20: 6 };

function formatMoney(value: number | null | undefined, compact = true): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (compact && abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(abs >= 1_000_000_000 ? 0 : 1)}億`;
  if (compact && abs >= 10_000) return `${sign}${(abs / 10_000).toFixed(0)}萬`;
  return `${sign}${Math.round(abs).toLocaleString('zh-TW')}`;
}

function formatLots(value: number | null | undefined, fromShares = true): string {
  if (value == null) return '—';
  const rounded = Math.round(fromShares ? value / 1000 : value);
  if (rounded === 0) return '0 張';
  const sign = rounded > 0 ? '+' : '−';
  return `${sign}${Math.abs(rounded).toLocaleString('zh-TW')} 張`;
}

function formatPct(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function flowCategory(theme: ThemeRank): Exclude<FlowCategory, 'all'> {
  const money = theme.instAmt5 ?? 0;
  const speed = themeMoney(theme, 1) - money / 5;
  if (money >= 0 && speed >= 0) return 'flood';
  if (money >= 0) return 'rotation';
  if (speed >= 0) return 'watch';
  return 'ebb';
}

function themeMoney(theme: ThemeRank, period: Period): number {
  if (period === 5) return theme.instAmt5 ?? 0;
  return theme.members.reduce((sum, member) => sum + (member.instAmt?.[PERIOD_INDEX[period]] ?? 0), 0);
}

function themeReturn(theme: ThemeRank, period: Period): number {
  if (period === 1) return theme.avgD1 ?? 0;
  if (period === 5) return theme.avgD5 ?? 0;
  return theme.avgD20 ?? 0;
}

function signedLog(value: number): number {
  return Math.sign(value) * Math.log10(1 + Math.abs(value) / 100_000_000);
}

function uniqueStocks(themes: ThemeRank[], pro: TideProSnapshot | null): StockRef[] {
  const stocks = new Map<string, StockRef>();
  for (const theme of themes) {
    for (const member of theme.members) {
      if (!stocks.has(member.code)) stocks.set(member.code, { code: member.code, name: member.name, theme: theme.theme });
    }
  }
  for (const stock of pro?.netLeaders ?? []) {
    if (!stocks.has(stock.symbol)) stocks.set(stock.symbol, { code: stock.symbol, name: stock.name });
  }
  return [...stocks.values()];
}

function readStoredStocks(key: string): StockRef[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export default function TideDashboard({
  initialDate,
  initialThemes,
  proSnapshot,
}: {
  initialDate: string;
  initialThemes: ThemeRank[];
  proSnapshot: TideProSnapshot | null;
}) {
  const [themes, setThemes] = useState(initialThemes);
  const [dataDate, setDataDate] = useState(initialDate);
  const [view, setView] = useState<ViewMode>('bubble');
  const [period, setPeriod] = useState<Period>(5);
  const [category, setCategory] = useState<FlowCategory>('all');
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<StockRef | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<ThemeRank | null>(null);
  const [watchlist, setWatchlist] = useState<StockRef[]>([]);
  const [watchSearchOpen, setWatchSearchOpen] = useState(false);
  const [watchQuery, setWatchQuery] = useState('');
  const [alerts, setAlerts] = useState<StockRef[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [alertTab, setAlertTab] = useState<AlertTab>('watch');
  const [loginOpen, setLoginOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [wishOpen, setWishOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  const [highlightsOpen, setHighlightsOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [textSize, setTextSize] = useState<TextSize>('small');
  const [riseColor, setRiseColor] = useState<RiseColor>('tw');
  const [haptics, setHaptics] = useState(true);
  const [notifications, setNotifications] = useState({ push: false, morning: true, close: true, poll: true, offers: true });
  const [pollVote, setPollVote] = useState<'bull' | 'bear' | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIndex, setReplayIndex] = useState(Math.max(0, (proSnapshot?.historyDates.length ?? 1) - 1));
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const allStocks = useMemo(() => uniqueStocks(initialThemes, proSnapshot), [initialThemes, proSnapshot]);
  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return allStocks
      .filter((stock) => stock.code.includes(needle) || stock.name.toLowerCase().includes(needle) || stock.theme?.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [allStocks, query]);
  const watchSearchResults = useMemo(() => {
    const needle = watchQuery.trim().toLowerCase();
    const candidates = needle
      ? allStocks.filter((stock) => stock.code.includes(needle) || stock.name.toLowerCase().includes(needle) || stock.theme?.toLowerCase().includes(needle))
      : allStocks;
    return candidates.filter((stock) => !watchlist.some((watched) => watched.code === stock.code)).slice(0, 8);
  }, [allStocks, watchQuery, watchlist]);

  useEffect(() => {
    setWatchlist(readStoredStocks('tide-clone-watchlist'));
    setAlerts(readStoredStocks('tide-clone-alerts'));
    const storedTheme = localStorage.getItem('tide-clone-theme');
    if (storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system') setThemeMode(storedTheme);
    const storedTextSize = localStorage.getItem('tide-clone-text-size');
    if (storedTextSize === 'small' || storedTextSize === 'medium' || storedTextSize === 'large') setTextSize(storedTextSize);
    const storedRiseColor = localStorage.getItem('tide-clone-rise-color');
    if (storedRiseColor === 'tw' || storedRiseColor === 'us') setRiseColor(storedRiseColor);
    const storedHaptics = localStorage.getItem('tide-clone-haptics');
    if (storedHaptics === '0' || storedHaptics === '1') setHaptics(storedHaptics === '1');
    try {
      const storedNotifications = JSON.parse(localStorage.getItem('tide-clone-notifications') ?? 'null');
      if (storedNotifications && typeof storedNotifications === 'object') setNotifications((current) => ({ ...current, ...storedNotifications }));
    } catch { /* 保留預設通知設定。 */ }
    setSignedIn(localStorage.getItem('tide-clone-signed-in') === '1');
    const storedVote = localStorage.getItem('tide-clone-poll-vote');
    if (storedVote === 'bull' || storedVote === 'bear') setPollVote(storedVote);
    if (localStorage.getItem('tide-clone-guide-seen') !== '1') setGuideOpen(true);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setResolvedTheme(themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [themeMode]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const persistStocks = useCallback((key: string, value: StockRef[]) => {
    localStorage.setItem(key, JSON.stringify(value));
  }, []);

  const addWatch = useCallback((stock: StockRef) => {
    setWatchlist((current) => {
      if (current.some((item) => item.code === stock.code)) return current;
      const next = [...current, stock];
      persistStocks('tide-clone-watchlist', next);
      setToast(`已將 ${stock.name} 加入觀察清單`);
      return next;
    });
  }, [persistStocks]);

  const toggleAlert = useCallback((stock: StockRef) => {
    setAlerts((current) => {
      const exists = current.some((item) => item.code === stock.code);
      const next = exists ? current.filter((item) => item.code !== stock.code) : [...current, stock];
      persistStocks('tide-clone-alerts', next);
      setToast(exists ? `已關閉 ${stock.name} 籌碼提醒` : `已開啟 ${stock.name} 籌碼提醒`);
      return next;
    });
  }, [persistStocks]);

  const changeTheme = useCallback((next: ThemeMode) => {
    setThemeMode(next);
    localStorage.setItem('tide-clone-theme', next);
  }, []);

  const changeTextSize = useCallback((next: TextSize) => {
    setTextSize(next);
    localStorage.setItem('tide-clone-text-size', next);
  }, []);

  const changeRiseColor = useCallback((next: RiseColor) => {
    setRiseColor(next);
    localStorage.setItem('tide-clone-rise-color', next);
  }, []);

  const changeHaptics = useCallback((next: boolean) => {
    setHaptics(next);
    localStorage.setItem('tide-clone-haptics', next ? '1' : '0');
    if (next) navigator.vibrate?.(20);
  }, []);

  const changeNotification = useCallback((key: keyof typeof notifications, checked: boolean) => {
    setNotifications((current) => {
      const next = { ...current, [key]: checked };
      localStorage.setItem('tide-clone-notifications', JSON.stringify(next));
      return next;
    });
  }, []);

  const signInDemo = useCallback(() => {
    localStorage.setItem('tide-clone-signed-in', '1');
    setSignedIn(true);
    setLoginOpen(false);
    setToast('已登入本機示範帳號，Pro 功能全部啟用');
  }, []);

  const submitVote = useCallback((vote: 'bull' | 'bear') => {
    setPollVote(vote);
    localStorage.setItem('tide-clone-poll-vote', vote);
    setToast(`已投票：明日看${vote === 'bull' ? '多' : '空'}`);
  }, []);

  const categoryCounts = useMemo(() => {
    const counts = { flood: 0, rotation: 0, watch: 0, ebb: 0 };
    for (const item of themes) counts[flowCategory(item)] += 1;
    return counts;
  }, [themes]);

  const topThemes = useMemo(() => [...themes].sort((a, b) => themeMoney(b, 5) - themeMoney(a, 5)), [themes]);
  const filteredThemes = useMemo(() => {
    const items = category === 'all' ? themes : themes.filter((item) => flowCategory(item) === category);
    const sorted = [...items].sort((a, b) => Math.abs(themeMoney(b, period)) - Math.abs(themeMoney(a, period)));
    return showAll ? sorted : sorted.slice(0, 26);
  }, [category, period, showAll, themes]);

  const replayDates = useMemo(() => proSnapshot?.historyDates ?? [], [proSnapshot?.historyDates]);
  useEffect(() => {
    if (!replayPlaying || replayDates.length === 0) return;
    const timer = window.setInterval(() => {
      setReplayIndex((current) => {
        if (current >= replayDates.length - 1) {
          setReplayPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [replayDates.length, replayPlaying]);

  useEffect(() => {
    if (!replayOpen || replayDates.length === 0) return;
    const date = replayDates[replayIndex];
    if (!date || date === dataDate) return;
    const controller = new AbortController();
    setReplayLoading(true);
    fetch(`/api/themes/ranking?date=${date}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (payload?.themes) {
          setThemes(payload.themes);
          setDataDate(payload.date);
        }
      })
      .finally(() => setReplayLoading(false));
    return () => controller.abort();
  }, [dataDate, replayDates, replayIndex, replayOpen]);

  const resetLatest = useCallback(() => {
    setReplayPlaying(false);
    setReplayIndex(Math.max(0, replayDates.length - 1));
    setThemes(initialThemes);
    setDataDate(initialDate);
  }, [initialDate, initialThemes, replayDates.length]);

  const marketChange = themes.length > 0
    ? themes.reduce((sum, item) => sum + (item.avgD1 ?? 0), 0) / themes.length
    : 0;
  const bullishPct = Math.round((themes.filter((item) => (item.avgD1 ?? 0) > 0).length / Math.max(1, themes.length)) * 100);

  return (
    <main className={styles.app} data-theme={resolvedTheme} data-text-size={textSize} data-rise-color={riseColor} id="main-content">
      <div className={styles.marketStrip}>
        <span>大盤 <b className={marketChange >= 0 ? styles.up : styles.down}>{formatPct(marketChange)}</b></span>
        <span className={styles.stripDivider}>｜</span>
        <span>資料日期 {dataDate || '—'}</span>
        <Link className={styles.planLink} href="/tide/pricing">方案</Link>
        <span className={styles.updateNote}>⏳ 今日資料約 18:30 前更新</span>
        <span className={styles.sourceNote}>資料來源：證交所、櫃買中心公開資料｜僅彙整公開資訊，不構成投資建議</span>
      </div>

      <header className={styles.header}>
        <div className={styles.sentiment} aria-label={`明日多方 ${bullishPct}%`}>
          <button className={pollVote === 'bull' ? styles.pollSelected : ''} onClick={() => submitVote('bull')}>多 {bullishPct}%</button>
          <div><i style={{ width: `${bullishPct}%` }} /></div>
          <button className={pollVote === 'bear' ? styles.pollSelected : ''} onClick={() => submitVote('bear')}>{100 - bullishPct}% 空</button>
        </div>

        <div className={styles.searchWrap}>
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜尋股票或板塊..."
            aria-label="搜尋股票或板塊"
          />
          {query && (
            <button className={styles.clearSearch} onClick={() => setQuery('')} aria-label="清除搜尋"><X size={14} /></button>
          )}
          {searchResults.length > 0 && (
            <div className={styles.searchMenu} role="listbox">
              {searchResults.map((stock) => (
                <button key={stock.code} onClick={() => { setSelected(stock); setQuery(''); }}>
                  <span><b>{stock.code}</b> {stock.name}</span>
                  <small>{stock.theme ?? '個股'}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className={styles.headerActions} aria-label="主要操作">
          <button onClick={() => setHighlightsOpen((value) => !value)}><Sparkles size={15} /> 今日重點</button>
          <button className={styles.iconButton} onClick={() => { setAlertTab('watch'); setAlertsOpen(true); }} aria-label="籌碼異動提醒">
            <BellRing size={16} /><span className={styles.countBadge}>{alerts.length}</span>
          </button>
          <button className={styles.iconButton} onClick={() => navigator.clipboard?.writeText(location.href).then(() => setToast('連結已複製'))} aria-label="分享 Tide"><Share2 size={16} /></button>
          <button className={styles.iconButton} onClick={() => changeTheme(themeMode === 'light' ? 'dark' : 'light')} aria-label="切換明暗主題">
            {themeMode === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button className={styles.iconButton} onClick={() => setSettingsOpen(true)} aria-label="設定"><Settings size={16} /></button>
          <button className={styles.loginButton} onClick={() => signedIn ? setPerformanceOpen(true) : setLoginOpen(true)}><UserRound size={15} /> {signedIn ? '我的' : '登入'}</button>
        </nav>
      </header>

      {highlightsOpen && (
        <section className={styles.highlights} aria-label="今日盤面重點">
          <div className={styles.highlightTitle}>
            <span className={styles.aiIcon}><Bot size={17} /></span>
            <div><b>今日重點（{dataDate.slice(5).replace('-', '/')}）</b><small>AI 盤後摘要</small></div>
          </div>
          <div className={styles.moodGauge}>
            <span>今日情緒</span><b>{bullishPct}</b><em>{bullishPct >= 55 ? '樂觀' : bullishPct <= 40 ? '保守' : '中性'}</em>
          </div>
          <p>
            法人買最多：{topThemes.slice(0, 3).map((item) => `${item.theme} ${formatMoney(themeMoney(item, 5))}`).join('、')}。
            {topThemes[0]?.topStock ? `領漲個股為 ${topThemes[0].topStock.name} ${formatPct(topThemes[0].topStock.d1)}。` : ''}
          </p>
          <button onClick={() => setHighlightsOpen(false)} aria-label="收起今日重點"><X size={16} /></button>
        </section>
      )}

      <div className={styles.workspace}>
        <section className={styles.categoryBar} aria-label="資金狀態篩選">
          {(Object.keys(CATEGORY_META) as Array<Exclude<FlowCategory, 'all'>>).map((key) => {
            const meta = CATEGORY_META[key];
            return (
              <button
                key={key}
                className={category === key ? styles.activeCategory : ''}
                onClick={() => setCategory(category === key ? 'all' : key)}
                aria-pressed={category === key}
                style={{ '--category-color': meta.color } as CSSProperties}
              >
                <b>{meta.label}</b><strong>{categoryCounts[key]}</strong><small>{meta.hint}</small>
              </button>
            );
          })}
        </section>

        <section className={styles.mainPanel}>
          <div className={styles.panelToolbar}>
            <div className={styles.viewMenuWrap}>
              <button
                className={styles.viewMenuButton}
                onClick={() => setViewMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={viewMenuOpen}
              >
                {view === 'bubble' ? '板塊泡泡圖' : view === 'ranking' ? '板塊排行榜' : view === 'dual' ? '外資投信同買賣' : view === 'streak' ? '外資連買賣' : '籌碼雷達'}
                <ChevronDown size={14} />
              </button>
              {viewMenuOpen && (
                <div className={styles.viewMenu} role="menu">
                  <button role="menuitem" onClick={() => { setViewMenuOpen(false); document.getElementById('tide-watchlist')?.scrollIntoView({ behavior: 'smooth' }); }}><Home size={15} /> 自選股</button>
                  <button role="menuitem" aria-current={view === 'bubble'} onClick={() => { setView('bubble'); setViewMenuOpen(false); }}><Layers3 size={15} /> 板塊泡泡圖</button>
                  <button role="menuitem" aria-current={view === 'ranking'} onClick={() => { setView('ranking'); setViewMenuOpen(false); }}><ListFilter size={15} /> 板塊排行榜</button>
                  <span>Pro 籌碼工具</span>
                  <button role="menuitem" aria-current={view === 'dual'} onClick={() => { setView('dual'); setViewMenuOpen(false); }}><TrendingUp size={15} /> 外資投信同買賣</button>
                  <button role="menuitem" aria-current={view === 'streak'} onClick={() => { setView('streak'); setViewMenuOpen(false); }}><Clock3 size={15} /> 外資連買賣</button>
                  <button role="menuitem" aria-current={view === 'radar'} onClick={() => { setView('radar'); setViewMenuOpen(false); }}><Radar size={15} /> 籌碼雷達</button>
                </div>
              )}
            </div>
            {view === 'bubble' ? (
              <>
                <button className={styles.showAllButton} onClick={() => setShowAll(!showAll)}>{showAll ? '精簡顯示' : `顯示全部 ${themes.length} 個`}</button>
                <span className={styles.chartHint}>越右＝近 5 日買越多・越上＝買的速度在加快・圈越大＝近 20 日金額越大</span>
                <button className={styles.helpButton} aria-label="怎麼看這張圖" title="越右法人買越多、越上資金加速、圈越大代表規模"><CircleHelp size={15} /></button>
                <button className={`${styles.replayButton} ${replayOpen ? styles.toolbarActive : ''}`} onClick={() => {
                  if (!replayOpen) setReplayIndex(0);
                  setReplayPlaying(false);
                  setReplayOpen(!replayOpen);
                }}><Play size={14} /> 回放</button>
              </>
            ) : <span className={styles.proToolbarLabel}><ShieldCheck size={13} /> Pro 全功能已啟用</span>}
          </div>

          {view === 'bubble' && (
            <BubbleView
              themes={filteredThemes}
              period={period}
              selectedTheme={selectedTheme}
              onCloseTheme={() => setSelectedTheme(null)}
              onSelectStock={setSelected}
              onSelectTheme={setSelectedTheme}
            />
          )}

          {view === 'ranking' && <RankingView themes={themes} period={period} setPeriod={setPeriod} snapshot={proSnapshot} onSelect={setSelected} />}
          {view === 'dual' && <DualView snapshot={proSnapshot} onSelect={setSelected} />}
          {view === 'streak' && <StreakView snapshot={proSnapshot} onSelect={setSelected} />}
          {view === 'radar' && <RadarView snapshot={proSnapshot} onSelect={setSelected} onAlert={toggleAlert} alerts={alerts} />}

          {replayOpen && (
            <div className={styles.replayBar}>
              <button className={styles.roundButton} onClick={() => setReplayPlaying((value) => !value)} aria-label={replayPlaying ? '暫停回放' : '播放回放'}>
                {replayPlaying ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <span>資金輪動回放</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, replayDates.length - 1)}
                value={replayIndex}
                onChange={(event) => { setReplayPlaying(false); setReplayIndex(Number(event.target.value)); }}
                aria-label="回放日期"
              />
              <b>{replayDates[replayIndex] ?? dataDate}</b>
              {replayLoading && <small>讀取中…</small>}
              <button className={styles.roundButton} onClick={resetLatest} aria-label="回到最新資料"><RotateCcw size={15} /></button>
              <button className={styles.roundButton} onClick={() => setReplayOpen(false)} aria-label="關閉回放"><X size={15} /></button>
            </div>
          )}
        </section>

        <aside className={styles.watchPanel} id="tide-watchlist">
          <div className={styles.watchHeader}>
            <div><span>觀察清單</span>{watchlist.length > 0 && <small>{watchlist.length} 檔</small>}</div>
            <div>
              <button onClick={() => setWatchSearchOpen(true)}><Plus size={14} /> 添加</button>
              <button aria-label="更多操作">⋯</button>
            </div>
          </div>
          {watchSearchOpen && (
            <div className={styles.watchSearchPopover} role="dialog" aria-label="新增自選股">
              <header><b>新增自選股</b><button onClick={() => { setWatchSearchOpen(false); setWatchQuery(''); }} aria-label="關閉新增自選股"><X size={14} /></button></header>
              <label><Search size={14} /><input autoFocus value={watchQuery} onChange={(event) => setWatchQuery(event.target.value)} placeholder="搜尋代碼或名稱" /></label>
              <div>
                {watchSearchResults.map((stock) => (
                  <button key={stock.code} onClick={() => { addWatch(stock); setWatchSearchOpen(false); setWatchQuery(''); }}>
                    <span><b>{stock.code}</b><small>{stock.name}</small></span><em>{stock.theme ?? '個股'}</em><Plus size={14} />
                  </button>
                ))}
                {watchSearchResults.length === 0 && <p>沒有符合的股票</p>}
              </div>
            </div>
          )}
          {watchlist.length === 0 ? (
            <div className={styles.emptyWatch}>
              <Waves size={28} />
              <b>尚無清單</b>
              <p>從搜尋結果或個股詳情加入自選股，資料會保留在這台裝置。</p>
              <span>今日法人買最多</span>
              {topThemes.slice(0, 4).map((theme) => theme.topStock && (
                <button key={`${theme.theme}-${theme.topStock.code}`} onClick={() => addWatch({ code: theme.topStock!.code, name: theme.topStock!.name, theme: theme.theme })}>
                  <span><b>{theme.topStock.code}</b> {theme.topStock.name}</span><em>{formatMoney(theme.instAmt5)}</em><Plus size={14} />
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.watchList}>
              {watchlist.map((stock) => {
                const pro = proSnapshot?.netLeaders.find((item) => item.symbol === stock.code);
                return (
                  <button key={stock.code} onClick={() => setSelected(stock)}>
                    <span><b>{stock.code}</b><small>{stock.name}</small></span>
                    <span className={(pro?.total ?? 0) >= 0 ? styles.up : styles.down}>{formatMoney(pro?.totalValue)}</span>
                    {alerts.some((item) => item.code === stock.code) && <Bell size={13} />}
                    <ChevronRight size={15} />
                  </button>
                );
              })}
            </div>
          )}
          <div className={styles.watchFooter}>
            <button onClick={() => setAlertsOpen(true)}><BellRing size={15} /> 籌碼監控 <b>{alerts.length}</b></button>
            <small>Pro 監控不限檔數</small>
          </div>
        </aside>
      </div>

      <footer className={styles.footer}>
        <span>資料來源：臺灣證券交易所、證券櫃檯買賣中心公開資料。</span>
        <nav aria-label="頁尾連結">
          <Link href="/tide/pricing">方案與定價</Link>
          <Link href="/tide/about">關於本站</Link>
          <Link href="/tide/glossary">名詞小百科</Link>
          <Link href="/tide/legal">條款・隱私・退款</Link>
        </nav>
        <span>本頁為獨立重建介面，非 tide-tw.app 官方服務；僅做資訊整理，不構成投資建議。</span>
      </footer>

      <nav className={styles.mobileNav} aria-label="手機版主要導覽">
        <button onClick={() => setHighlightsOpen(true)}><BarChart3 size={19} /><span>今日</span></button>
        <button className={view === 'bubble' ? styles.mobileNavActive : ''} onClick={() => { setView('bubble'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Layers3 size={19} /><span>泡泡圖</span></button>
        <button className={view === 'ranking' ? styles.mobileNavActive : ''} onClick={() => { setView('ranking'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><ListFilter size={19} /><span>排行</span></button>
        <button onClick={() => document.getElementById('tide-watchlist')?.scrollIntoView({ behavior: 'smooth' })}><Home size={19} /><span>自選</span>{watchlist.length > 0 && <b>{watchlist.length}</b>}</button>
        <button onClick={() => signedIn ? setPerformanceOpen(true) : setLoginOpen(true)}><UserRound size={19} /><span>我的</span></button>
      </nav>

      {selected && (
        <StockDrawer
          stock={selected}
          onClose={() => setSelected(null)}
          watched={watchlist.some((item) => item.code === selected.code)}
          alerted={alerts.some((item) => item.code === selected.code)}
          onWatch={() => addWatch(selected)}
          onAlert={() => toggleAlert(selected)}
        />
      )}

      {settingsOpen && (
        <Modal title="⚙️ 設定" onClose={() => setSettingsOpen(false)} wide>
          <div className={styles.settingsBody}>
            <label>漲跌顏色</label>
            <div className={styles.optionButtons}>
              <button className={riseColor === 'tw' ? styles.selectedOption : ''} onClick={() => changeRiseColor('tw')}><TrendingUp size={16} /> 紅漲綠跌</button>
              <button className={riseColor === 'us' ? styles.selectedOption : ''} onClick={() => changeRiseColor('us')}><TrendingUp size={16} /> 綠漲紅跌</button>
            </div>
            <label>字幕大小</label>
            <div className={`${styles.optionButtons} ${styles.threeOptions}`}>
              {(['small', 'medium', 'large'] as TextSize[]).map((size) => <button key={size} className={textSize === size ? styles.selectedOption : ''} onClick={() => changeTextSize(size)}>{size === 'small' ? '小' : size === 'medium' ? '中' : '大'}</button>)}
            </div>
            <label>觸覺回饋</label>
            <div className={styles.optionButtons}>
              <button className={haptics ? styles.selectedOption : ''} onClick={() => changeHaptics(true)}><Vibrate size={16} /> 開</button>
              <button className={!haptics ? styles.selectedOption : ''} onClick={() => changeHaptics(false)}>關</button>
            </div>
            <label>畫面主題</label>
            <div className={`${styles.optionButtons} ${styles.threeOptions}`}>
              <button className={themeMode === 'light' ? styles.selectedOption : ''} onClick={() => changeTheme('light')}><Sun size={16} /> 亮色</button>
              <button className={themeMode === 'dark' ? styles.selectedOption : ''} onClick={() => changeTheme('dark')}><Moon size={16} /> 暗色</button>
              <button className={themeMode === 'system' ? styles.selectedOption : ''} onClick={() => changeTheme('system')}><SlidersHorizontal size={16} /> 系統</button>
            </div>
            <label>通知設定</label>
            <div className={styles.notificationSettings}>
              <SettingToggle label="開啟推播通知" checked={notifications.push} onChange={(checked) => changeNotification('push', checked)} />
              <SettingToggle label="開盤前重點（08:30）" checked={notifications.morning} onChange={(checked) => changeNotification('morning', checked)} />
              <SettingToggle label="盤後結算（約 19:00）" checked={notifications.close} onChange={(checked) => changeNotification('close', checked)} />
              <SettingToggle label="投票提醒" checked={notifications.poll} onChange={(checked) => changeNotification('poll', checked)} />
              <SettingToggle label="優惠與活動通知" checked={notifications.offers} onChange={(checked) => changeNotification('offers', checked)} />
            </div>
            <label>Pro 功能狀態</label>
            <div className={styles.proStatus}><Check size={16} /><span><b>全部啟用</b><small>法人分項、歷史回看、雷達與不限檔監控</small></span></div>
            <label>說明與關於</label>
            <div className={styles.settingsLinks}>
              <button onClick={() => { setSettingsOpen(false); setGuideStep(0); setGuideOpen(true); }}><BookOpen size={15} /> 新手教學</button>
              <Link href="/tide/pricing"><Crown size={15} /> 方案與定價</Link>
              <Link href="/tide/glossary"><CircleHelp size={15} /> 名詞小百科</Link>
              <Link href="/tide/legal"><ShieldCheck size={15} /> 條款・隱私・退款</Link>
              <button onClick={() => { setSettingsOpen(false); setWishOpen(true); }}><Send size={15} /> 許願池</button>
            </div>
            <p>資料來源為證交所與櫃買中心公開資料。本服務僅彙整公開資訊，不構成投資建議。</p>
          </div>
        </Modal>
      )}

      {alertsOpen && (
        <Modal title="籌碼異動提醒" onClose={() => setAlertsOpen(false)} wide>
          <div className={styles.alertBody}>
            <div className={styles.modalTabs} role="tablist">
              <button role="tab" aria-selected={alertTab === 'watch'} onClick={() => setAlertTab('watch')}>監控清單</button>
              <button role="tab" aria-selected={alertTab === 'notifications'} onClick={() => setAlertTab('notifications')}>通知欄</button>
            </div>
            {alertTab === 'watch' ? <>
              <div className={styles.alertIntro}><BellRing size={20} /><p>盯著你選的股票，出現異常大買／大賣、法人連買連賣或土洋同買／對作時，盤後彙整提醒。Pro 清單不限檔數。</p></div>
              <AlertStockSearch allStocks={allStocks} alerts={alerts} onToggle={toggleAlert} />
              <h3>監控清單</h3>
              {alerts.length === 0 ? <p className={styles.emptyText}>尚未加入監控股票。</p> : alerts.map((stock) => (
                <div key={stock.code} className={styles.alertRow}><span><b>{stock.code}</b> {stock.name}</span><small>異常力道・連買賣・具名徽章</small><button onClick={() => toggleAlert(stock)} aria-label={`移除 ${stock.name}`}><X size={15} /></button></div>
              ))}
            </> : <NotificationFeed alerts={alerts} date={dataDate} />}
          </div>
        </Modal>
      )}

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onLogin={signInDemo} />}
      {inviteOpen && <InviteModal onClose={() => setInviteOpen(false)} onRedeem={() => { setInviteOpen(false); setRedeemOpen(true); }} setToast={setToast} />}
      {redeemOpen && <RedeemModal onClose={() => setRedeemOpen(false)} setToast={setToast} />}
      {performanceOpen && <PerformanceModal onClose={() => setPerformanceOpen(false)} vote={pollVote} onLeaderboard={() => { setPerformanceOpen(false); setLeaderboardOpen(true); }} onInvite={() => { setPerformanceOpen(false); setInviteOpen(true); }} onSignOut={() => { localStorage.removeItem('tide-clone-signed-in'); setSignedIn(false); setPerformanceOpen(false); setToast('已登出示範帳號'); }} />}
      {leaderboardOpen && <LeaderboardModal onClose={() => setLeaderboardOpen(false)} />}
      {guideOpen && <GuideModal step={guideStep} setStep={setGuideStep} onClose={() => { localStorage.setItem('tide-clone-guide-seen', '1'); setGuideOpen(false); }} />}
      {wishOpen && <WishModal onClose={() => setWishOpen(false)} setToast={setToast} />}

      {toast && <div className={styles.toast}><Check size={15} /> {toast}</div>}
    </main>
  );
}

function BubbleView({
  themes,
  period,
  selectedTheme,
  onCloseTheme,
  onSelectStock,
  onSelectTheme,
}: {
  themes: ThemeRank[];
  period: Period;
  selectedTheme: ThemeRank | null;
  onCloseTheme: () => void;
  onSelectStock: (stock: StockRef) => void;
  onSelectTheme: (theme: ThemeRank) => void;
}) {
  const points = useMemo(() => {
    const raw = themes.map((theme) => ({
      theme,
      x: signedLog(themeMoney(theme, period)),
      y: signedLog(themeMoney(theme, 1) - themeMoney(theme, 5) / 5),
      size: Math.log10(1 + Math.abs(themeMoney(theme, 20)) / 100_000_000),
    }));
    const maxX = Math.max(1, ...raw.map((item) => Math.abs(item.x)));
    const maxY = Math.max(1, ...raw.map((item) => Math.abs(item.y)));
    const maxSize = Math.max(1, ...raw.map((item) => item.size));
    const placed = raw.map((item) => ({
      ...item,
      // 固定 SVG 座標精度，避免 Node 與瀏覽器浮點字串最後一位不同造成 hydration mismatch。
      cx: Number((520 + (item.x / maxX) * 390).toFixed(3)),
      cy: Number((250 - (item.y / maxY) * 180).toFixed(3)),
      radius: Number((20 + (item.size / maxSize) * 34).toFixed(3)),
    }));
    // 原站以力導向避免同象限的泡泡完全疊在一起；固定迭代確保 SSR/瀏覽器結果一致。
    for (let pass = 0; pass < 70; pass += 1) {
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const left = placed[i];
          const right = placed[j];
          let dx = right.cx - left.cx;
          let dy = right.cy - left.cy;
          if (dx === 0 && dy === 0) { dx = (j % 3) - 1 || 1; dy = (i % 3) - 1 || -1; }
          const distance = Math.max(1, Math.hypot(dx, dy));
          const minimum = (left.radius + right.radius) * 0.72;
          if (distance >= minimum) continue;
          const shift = (minimum - distance) * 0.28;
          const ux = dx / distance;
          const uy = dy / distance;
          left.cx -= ux * shift;
          left.cy -= uy * shift;
          right.cx += ux * shift;
          right.cy += uy * shift;
        }
      }
      for (const point of placed) {
        point.cx = Math.max(108 + point.radius, Math.min(917 - point.radius, point.cx));
        point.cy = Math.max(31 + point.radius, Math.min(445 - point.radius, point.cy));
      }
    }
    return placed.map((point) => ({ ...point, cx: Number(point.cx.toFixed(3)), cy: Number(point.cy.toFixed(3)) }));
  }, [period, themes]);

  return (
    <div className={styles.bubbleView}>
      <div className={styles.chartWrap}>
        <svg viewBox="0 0 1000 530" role="img" aria-label="台股板塊法人資金泡泡圖">
          <defs>
            <pattern id="tide-grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" className={styles.gridLine} fill="none" />
            </pattern>
            <filter id="bubble-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="4" stdDeviation="6" floodOpacity="0.15" />
            </filter>
          </defs>
          <rect x="105" y="28" width="815" height="420" fill="url(#tide-grid)" className={styles.chartBg} />
          <line x1="520" y1="28" x2="520" y2="448" className={styles.axisLine} />
          <line x1="105" y1="250" x2="920" y2="250" className={styles.axisLine} />
          <text x="520" y="476" textAnchor="middle" className={styles.axisLabel}>0</text>
          <text x="110" y="476" textAnchor="middle" className={styles.axisLabel}>−500</text>
          <text x="270" y="476" textAnchor="middle" className={styles.axisLabel}>−100</text>
          <text x="390" y="476" textAnchor="middle" className={styles.axisLabel}>−20</text>
          <text x="650" y="476" textAnchor="middle" className={styles.axisLabel}>+20</text>
          <text x="790" y="476" textAnchor="middle" className={styles.axisLabel}>+100</text>
          <text x="915" y="476" textAnchor="middle" className={styles.axisLabel}>+500</text>
          <text x="91" y="37" textAnchor="end" className={styles.axisLabel}>+50億/天</text>
          <text x="91" y="128" textAnchor="end" className={styles.axisLabel}>+20億/天</text>
          <text x="91" y="254" textAnchor="end" className={styles.axisLabel}>0億/天</text>
          <text x="91" y="372" textAnchor="end" className={styles.axisLabel}>−20億/天</text>
          <text x="91" y="444" textAnchor="end" className={styles.axisLabel}>−50億/天</text>
          <text x="107" y="507" textAnchor="start" className={styles.axisTitle}>← 資金流出（億）</text>
          <text x="917" y="507" textAnchor="end" className={styles.axisTitle}>資金流入（億） →</text>
          {points.map((point) => {
            const category = flowCategory(point.theme);
            const color = CATEGORY_META[category].color;
            return (
              <g
                key={point.theme.theme}
                className={styles.bubble}
                transform={`translate(${point.cx} ${point.cy})`}
                onClick={() => onSelectTheme(point.theme)}
                role="button"
                tabIndex={0}
                aria-label={`${point.theme.theme}，${formatMoney(themeMoney(point.theme, period))}`}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelectTheme(point.theme); }}
              >
                <circle r={point.radius} fill={color} stroke={color} filter="url(#bubble-shadow)" />
                <text textAnchor="middle" y={-3} className={styles.bubbleName}>{point.theme.theme}</text>
                <text textAnchor="middle" y={14} className={styles.bubbleValue}>{formatMoney(themeMoney(point.theme, period))}</text>
                <title>{`${point.theme.theme}｜法人 ${formatMoney(themeMoney(point.theme, period))}｜漲跌 ${formatPct(themeReturn(point.theme, period))}`}</title>
              </g>
            );
          })}
        </svg>
        <div className={styles.chartBrand} aria-hidden="true"><Waves size={30} /><span>tide-tw.app</span></div>
        {selectedTheme && (
          <section className={styles.themePopover} aria-label={`${selectedTheme.theme} 板塊摘要`}>
            <header>
              <div><b>{selectedTheme.theme}</b><span style={{ color: CATEGORY_META[flowCategory(selectedTheme)].color }}>{CATEGORY_META[flowCategory(selectedTheme)].label}</span></div>
              <button onClick={onCloseTheme} aria-label="關閉板塊摘要"><X size={15} /></button>
            </header>
            <div className={styles.themeMetrics}>
              <span>當日法人淨買超<strong className={themeMoney(selectedTheme, 1) >= 0 ? styles.up : styles.down}>{formatMoney(themeMoney(selectedTheme, 1))}</strong></span>
              <span>近 5 日法人淨買超<strong className={themeMoney(selectedTheme, 5) >= 0 ? styles.up : styles.down}>{formatMoney(themeMoney(selectedTheme, 5))}</strong></span>
              <span>近 20 日累計<strong className={themeMoney(selectedTheme, 20) >= 0 ? styles.up : styles.down}>{formatMoney(themeMoney(selectedTheme, 20))}</strong></span>
              <span>近 5 日漲跌<strong className={themeReturn(selectedTheme, 5) >= 0 ? styles.up : styles.down}>{formatPct(themeReturn(selectedTheme, 5))}</strong></span>
            </div>
            <p>代表股：點選可查看完整 Pro 法人籌碼</p>
            <div className={styles.themeStocks}>
              {selectedTheme.members.slice(0, 8).map((stock) => (
                <button key={stock.code} onClick={() => onSelectStock({ code: stock.code, name: stock.name, theme: selectedTheme.theme })}>
                  <b>{stock.code}</b><span>{stock.name}</span>
                </button>
              ))}
            </div>
            <small>金額以各交易日收盤價估算</small>
          </section>
        )}
      </div>
    </div>
  );
}

function RankingView({ themes, period, setPeriod, snapshot, onSelect }: { themes: ThemeRank[]; period: Period; setPeriod: (period: Period) => void; snapshot: TideProSnapshot | null; onSelect: (stock: StockRef) => void }) {
  const [lens, setLens] = useState<'flow' | 'breadth' | 'contrarian' | 'anomaly' | 'dual'>('flow');
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const dualCodes = useMemo(() => new Set([
    ...(direction === 'buy' ? snapshot?.simultaneousBuy ?? [] : snapshot?.simultaneousSell ?? []),
  ].map((stock) => stock.symbol)), [direction, snapshot]);
  const rows = useMemo(() => {
    let items = [...themes];
    if (lens === 'breadth') items = items.filter((theme) => (theme.breadth ?? 0) >= .55);
    if (lens === 'contrarian') items = items.filter((theme) => themeMoney(theme, period) > 0 && themeReturn(theme, period) < 0);
    if (lens === 'dual') items = items.filter((theme) => theme.members.some((member) => dualCodes.has(member.code)));
    items.sort((a, b) => {
      if (lens === 'breadth') return direction === 'buy' ? (b.breadth ?? 0) - (a.breadth ?? 0) : (a.breadth ?? 1) - (b.breadth ?? 1);
      if (lens === 'anomaly') return Math.abs(themeMoney(b, period)) / Math.max(1, b.stockCount) - Math.abs(themeMoney(a, period)) / Math.max(1, a.stockCount);
      return direction === 'buy' ? themeMoney(b, period) - themeMoney(a, period) : themeMoney(a, period) - themeMoney(b, period);
    });
    return items;
  }, [direction, dualCodes, lens, period, themes]);
  const largest = Math.max(1, ...rows.map((theme) => Math.abs(themeMoney(theme, period))));
  return (
    <div className={styles.themeRanking}>
      <div className={styles.rankingFilters}>
        <div className={styles.rankingLenses}>
          {([
            ['flow', '法人動向'], ['breadth', '買多漲少'], ['contrarian', '逆勢買超'], ['anomaly', '個股異常'], ['dual', '外資投信'],
          ] as const).map(([key, label]) => <button key={key} className={lens === key ? styles.rankingActive : ''} onClick={() => setLens(key)}>{label}</button>)}
        </div>
        <div className={styles.rankingSegments}>
          <div><button className={direction === 'buy' ? styles.rankingActive : ''} onClick={() => setDirection('buy')}>買超</button><button className={direction === 'sell' ? styles.rankingActive : ''} onClick={() => setDirection('sell')}>賣超</button></div>
          <div>{([1, 5] as Period[]).map((value) => <button key={value} className={period === value ? styles.rankingActive : ''} onClick={() => setPeriod(value)}>{value === 1 ? '當日' : '5 日'}</button>)}</div>
        </div>
      </div>
      <p className={styles.rankingNote}>近 {period} 日法人{direction === 'buy' ? '買' : '賣'}最多的板塊（只呈現公開資料事實，不構成投資建議）</p>
      <div className={styles.rankingColumns}><span>{period} 日漲跌</span><span>{period} 日淨買超(億)</span></div>
      <div className={styles.themeRankingList}>
        {rows.map((theme, index) => {
          const amount = themeMoney(theme, period);
          const positiveMembers = theme.members.filter((member) => (member.instAmt?.[PERIOD_INDEX[period]] ?? 0) > 0).length;
          return (
            <button key={theme.theme} onClick={() => {
              const stock = theme.topStock ?? theme.members[0];
              if (stock) onSelect({ code: stock.code, name: stock.name, theme: theme.theme });
            }}>
              <span className={styles.rankingNumber}>{index + 1}</span>
              <span className={styles.rankingTheme}><b><i style={{ background: CATEGORY_META[flowCategory(theme)].color }} />{theme.theme}</b><small>今日 {formatMoney(themeMoney(theme, 1))} · {positiveMembers}/{theme.stockCount} 檔在買 · 主力 {theme.topStock?.name ?? '—'}</small></span>
              <strong className={themeReturn(theme, period) >= 0 ? styles.up : styles.down}>{formatPct(themeReturn(theme, period))}</strong>
              <strong className={amount >= 0 ? styles.up : styles.down}>{formatMoney(amount)}</strong>
              <span className={styles.rankingBar}><i style={{ width: `${Math.max(4, Math.abs(amount) / largest * 100)}%` }} /></span>
            </button>
          );
        })}
        {rows.length === 0 && <p className={styles.emptyText}>目前沒有符合條件的板塊。</p>}
      </div>
    </div>
  );
}

function DualView({ snapshot, onSelect }: { snapshot: TideProSnapshot | null; onSelect: (stock: StockRef) => void }) {
  return (
    <DataSection title="外資投信同買／同賣榜" subtitle="外資與投信今天各自買超或賣超 0.5 億元以上；以官方法人資料乘當日收盤價計算。">
      <div className={styles.splitLists}>
        <ProStockList title="同買" icon={<TrendingUp size={17} />} rows={snapshot?.simultaneousBuy ?? []} onSelect={onSelect} positive />
        <ProStockList title="同賣" icon={<TrendingDown size={17} />} rows={snapshot?.simultaneousSell ?? []} onSelect={onSelect} />
      </div>
    </DataSection>
  );
}

function StreakView({ snapshot, onSelect }: { snapshot: TideProSnapshot | null; onSelect: (stock: StockRef) => void }) {
  return (
    <DataSection title="外資連續買／賣榜" subtitle="從最新交易日往回計算，連續 3 天以上完整列出。">
      <div className={styles.cardGrid}>
        {(snapshot?.foreignStreaks ?? []).map((stock) => (
          <button className={styles.metricCard} key={stock.symbol} onClick={() => onSelect({ code: stock.symbol, name: stock.name })}>
            <div><span><b>{stock.symbol}</b> {stock.name}</span><em className={stock.streakDirection === 'buy' ? styles.up : styles.down}>{stock.streakDirection === 'buy' ? '連買' : '連賣'} {stock.streak} 天</em></div>
            <strong className={stock.foreign >= 0 ? styles.up : styles.down}>{formatMoney(stock.foreignValue)}</strong>
            <small>今日外資 {formatLots(stock.foreign)}</small>
          </button>
        ))}
      </div>
    </DataSection>
  );
}

function RadarView({ snapshot, onSelect, onAlert, alerts }: { snapshot: TideProSnapshot | null; onSelect: (stock: StockRef) => void; onAlert: (stock: StockRef) => void; alerts: StockRef[] }) {
  return (
    <DataSection title="籌碼雷達" subtitle="依力道倍數、多法人同步與連續天數篩選；點鈴鐺即可加入不限檔監控。">
      <div className={styles.radarFilters}><span><Gauge size={15} /> 力道 ≥ 1 倍</span><span><ShieldCheck size={15} /> 具名異動</span><span><Clock3 size={15} /> 歷史 20 日基準</span></div>
      <div className={styles.radarList}>
        {(snapshot?.intensityLeaders ?? []).map((stock, index) => {
          const ref = { code: stock.symbol, name: stock.name };
          const active = alerts.some((item) => item.code === stock.symbol);
          return (
            <div key={stock.symbol}>
              <button onClick={() => onSelect(ref)}><span className={styles.radarRank}>{index + 1}</span><span><b>{stock.symbol} {stock.name}</b><small>{stock.badge ?? '法人力道放大'}</small></span></button>
              <strong className={stock.total >= 0 ? styles.up : styles.down}>{stock.intensity.toFixed(1)}×</strong>
              <em>{formatMoney(stock.totalValue)}</em>
              <button className={active ? styles.alertActiveButton : styles.alertButton} onClick={() => onAlert(ref)} aria-label={`${active ? '關閉' : '開啟'} ${stock.name} 提醒`}><Bell size={15} /></button>
            </div>
          );
        })}
      </div>
    </DataSection>
  );
}

function ProStockList({ title, icon, rows, onSelect, positive = false }: { title: string; icon: React.ReactNode; rows: TideProStock[]; onSelect: (stock: StockRef) => void; positive?: boolean }) {
  return (
    <section className={styles.proList}>
      <h3 className={positive ? styles.up : styles.down}>{icon}{title}<span>{rows.length} 檔</span></h3>
      {rows.length === 0 ? <p className={styles.emptyText}>本日沒有達門檻股票。</p> : rows.map((stock, index) => (
        <button key={stock.symbol} onClick={() => onSelect({ code: stock.symbol, name: stock.name })}>
          <span className={styles.listRank}>{index + 1}</span><span><b>{stock.symbol} {stock.name}</b><small>外資 {formatMoney(stock.foreignValue)}・投信 {formatMoney(stock.trustValue)}</small></span>
          <strong className={positive ? styles.up : styles.down}>{formatMoney(stock.totalValue)}</strong><ChevronRight size={15} />
        </button>
      ))}
    </section>
  );
}

function DataSection({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <div className={styles.dataSection}><header><div><h2>{title}<span>PRO</span></h2><p>{subtitle}</p></div><ShieldCheck size={20} /></header>{children}</div>;
}

function StockDrawer({ stock, onClose, watched, alerted, onWatch, onAlert }: { stock: StockRef; onClose: () => void; watched: boolean; alerted: boolean; onWatch: () => void; onAlert: () => void }) {
  const [data, setData] = useState<StockDetailData>({ chips: [], candles: [], loading: true, error: null });
  const [selectedDate, setSelectedDate] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setData({ chips: [], candles: [], loading: true, error: null });
    Promise.all([
      fetch(`/api/stock/chips?symbol=${encodeURIComponent(stock.code)}.TW&days=120`, { signal: controller.signal }).then((response) => response.ok ? response.json() : Promise.reject(new Error('籌碼資料載入失敗'))),
      fetch(`/api/stock?symbol=${encodeURIComponent(stock.code)}&interval=1d&period=6mo&local=1`, { signal: controller.signal }).then((response) => response.ok ? response.json() : Promise.reject(new Error('股價資料載入失敗'))),
    ]).then(([chipPayload, stockPayload]) => {
      const chips = (chipPayload.inst ?? []) as ChipDay[];
      const candles = (stockPayload.candles ?? []) as Candle[];
      setData({ chips, candles, loading: false, error: null });
      setSelectedDate(chips.at(-1)?.date ?? '');
    }).catch((error) => {
      if (error.name !== 'AbortError') setData({ chips: [], candles: [], loading: false, error: error.message });
    });
    return () => controller.abort();
  }, [stock.code]);

  const detail = useMemo(() => buildStockDetail(data.chips, data.candles, selectedDate), [data.candles, data.chips, selectedDate]);

  return (
    <div className={styles.drawerBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className={styles.stockDrawer} role="dialog" aria-modal="true" aria-label={`${stock.name} Pro 籌碼詳情`}>
        <header className={styles.drawerHeader}>
          <div><span className={styles.stockCode}>{stock.code}</span><h2>{stock.name}</h2>{stock.theme && <small>{stock.theme}</small>}</div>
          <button onClick={onClose} aria-label="關閉個股詳情"><X size={18} /></button>
        </header>
        <div className={styles.drawerActions}>
          <button className={watched ? styles.actionActive : ''} onClick={onWatch}>{watched ? <Check size={15} /> : <Plus size={15} />}{watched ? '已在自選' : '加入自選'}</button>
          <button className={alerted ? styles.actionActive : ''} onClick={onAlert}><Bell size={15} />{alerted ? '提醒已開啟' : '籌碼提醒'}</button>
          <span className={styles.proPill}><ShieldCheck size={12} /> Pro 深度</span>
        </div>
        {data.loading ? <div className={styles.drawerLoading}><Waves size={28} /><span>正在讀取法人與股價資料…</span></div> : data.error ? <div className={styles.drawerLoading}><CircleHelp size={28} /><span>{data.error}</span></div> : (
          <div className={styles.drawerContent}>
            <div className={styles.namedBadges}>
              {detail.badges.map((badge) => <span key={badge}><Sparkles size={13} />{badge}</span>)}
              {detail.badges.length === 0 && <span><ShieldCheck size={13} />一般籌碼變動</span>}
            </div>
            <section className={styles.stockSummary}>
              <div><small>三大法人當日</small><b className={detail.latest.total >= 0 ? styles.up : styles.down}>{formatLots(detail.latest.total, false)}</b></div>
              <div><small>近 5 日</small><b className={detail.sum5 >= 0 ? styles.up : styles.down}>{formatLots(detail.sum5, false)}</b></div>
              <div><small>近 20 日</small><b className={detail.sum20 >= 0 ? styles.up : styles.down}>{formatLots(detail.sum20, false)}</b></div>
              <div><small>力道標</small><b>{detail.intensity.toFixed(1)}×</b></div>
            </section>

            <section className={styles.detailCard}>
              <header><div><h3>法人分項深度</h3><p>當日＋近 5 日／20 日分項</p></div><select value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} aria-label="選擇歷史日期">{data.chips.slice().reverse().map((row) => <option value={row.date} key={row.date}>{row.date}</option>)}</select></header>
              <div className={styles.institutionGrid}>
                <InstitutionCell label="外資" today={detail.latest.foreign} sum5={detail.foreign5} sum20={detail.foreign20} />
                <InstitutionCell label="投信" today={detail.latest.trust} sum5={detail.trust5} sum20={detail.trust20} />
                <InstitutionCell label="自營" today={detail.latest.dealer} sum5={detail.dealer5} sum20={detail.dealer20} />
              </div>
            </section>

            <section className={styles.detailCard}>
              <header><div><h3>近 30 日股價走勢</h3><p>虛線＝法人 20 日買進均價</p></div><span className={styles.costBadge}>均價 {detail.averageCost ? `$${detail.averageCost.toFixed(1)}` : '—'}</span></header>
              <StockPriceChart candles={detail.chartCandles} averageCost={detail.averageCost} selectedDate={selectedDate} />
            </section>

            <section className={styles.detailCard}>
              <header><div><h3>外資停留</h3><p>從所選日期往回連續買賣天數</p></div><strong className={detail.foreignDirection === '買超' ? styles.up : styles.down}>{detail.foreignDirection} {detail.foreignStreak} 天</strong></header>
              <div className={styles.streakTrack}>{Array.from({ length: Math.min(20, Math.max(1, detail.foreignStreak)) }, (_, index) => <i key={index} className={detail.foreignDirection === '買超' ? styles.streakBuy : styles.streakSell} />)}</div>
            </section>

            <section className={styles.historyTable}>
              <h3>個股歷史回看</h3>
              <table><thead><tr><th>日期</th><th>外資</th><th>投信</th><th>自營</th><th>合計</th></tr></thead><tbody>{data.chips.slice(-20).reverse().map((row) => <tr key={row.date} className={row.date === selectedDate ? styles.selectedHistory : ''} onClick={() => setSelectedDate(row.date)}><td>{row.date.slice(5)}</td><td>{formatLots(row.foreign, false)}</td><td>{formatLots(row.trust, false)}</td><td>{formatLots(row.dealer, false)}</td><td className={row.total >= 0 ? styles.up : styles.down}>{formatLots(row.total, false)}</td></tr>)}</tbody></table>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function buildStockDetail(chips: ChipDay[], candles: Candle[], selectedDate: string) {
  const index = Math.max(0, chips.findIndex((row) => row.date === selectedDate));
  const history = chips.slice(0, index + 1);
  const latest = history.at(-1) ?? { date: '', foreign: 0, trust: 0, dealer: 0, total: 0 };
  const sum = (key: keyof Pick<ChipDay, 'foreign' | 'trust' | 'dealer' | 'total'>, days: number) => history.slice(-days).reduce((total, row) => total + row[key], 0);
  const previous = history.slice(-20, -1);
  const baseline = previous.length ? previous.reduce((total, row) => total + Math.abs(row.total), 0) / previous.length : 0;
  const intensity = baseline > 0 ? Math.abs(latest.total) / baseline : 0;
  const foreignDirection = latest.foreign >= 0 ? '買超' as const : '賣超' as const;
  let foreignStreak = 0;
  for (let cursor = history.length - 1; cursor >= 0; cursor -= 1) {
    if ((history[cursor].foreign >= 0) !== (latest.foreign >= 0) || history[cursor].foreign === 0) break;
    foreignStreak += 1;
  }
  const candleMap = new Map(candles.map((candle) => [candle.date, candle.close]));
  let weightedValue = 0;
  let weightedShares = 0;
  for (const row of history.slice(-20)) {
    const close = candleMap.get(row.date);
    if (row.total > 0 && close != null) {
      weightedValue += row.total * close;
      weightedShares += row.total;
    }
  }
  const badges: string[] = [];
  if (latest.foreign > 0 && latest.trust > 0) badges.push('土洋同買');
  if (latest.foreign < 0 && latest.trust < 0) badges.push('土洋同賣');
  if (latest.foreign * latest.trust < 0) badges.push('土洋對作');
  if (intensity >= 2.5) badges.push(latest.total >= 0 ? '異常大買' : '異常大賣');
  return {
    latest,
    sum5: sum('total', 5), sum20: sum('total', 20),
    foreign5: sum('foreign', 5), foreign20: sum('foreign', 20),
    trust5: sum('trust', 5), trust20: sum('trust', 20),
    dealer5: sum('dealer', 5), dealer20: sum('dealer', 20),
    intensity,
    foreignDirection,
    foreignStreak,
    averageCost: weightedShares > 0 ? weightedValue / weightedShares : null,
    chartCandles: candles.filter((candle) => candle.date <= selectedDate).slice(-30),
    badges,
  };
}

function InstitutionCell({ label, today, sum5, sum20 }: { label: string; today: number; sum5: number; sum20: number }) {
  return <div><b>{label}</b><span className={today >= 0 ? styles.up : styles.down}>{formatLots(today, false)}</span><small>5 日 <em className={sum5 >= 0 ? styles.up : styles.down}>{formatLots(sum5, false)}</em></small><small>20 日 <em className={sum20 >= 0 ? styles.up : styles.down}>{formatLots(sum20, false)}</em></small></div>;
}

function StockPriceChart({ candles, averageCost, selectedDate }: { candles: Candle[]; averageCost: number | null; selectedDate: string }) {
  if (candles.length < 2) return <div className={styles.emptyChart}>股價資料不足</div>;
  const values = candles.map((candle) => candle.close).concat(averageCost ?? []);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const x = (index: number) => 24 + (index / (candles.length - 1)) * 532;
  const y = (value: number) => 155 - ((value - min) / range) * 120;
  const path = candles.map((candle, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(candle.close)}`).join(' ');
  const selectedIndex = candles.findIndex((candle) => candle.date === selectedDate);
  return (
    <svg className={styles.priceChart} viewBox="0 0 580 180" role="img" aria-label="近 30 日股價與法人均價走勢">
      <defs><linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3e8f88" stopOpacity=".32" /><stop offset="1" stopColor="#3e8f88" stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3].map((line) => <line key={line} x1="24" x2="556" y1={35 + line * 40} y2={35 + line * 40} className={styles.priceGrid} />)}
      <path d={`${path} L ${x(candles.length - 1)} 165 L 24 165 Z`} fill="url(#price-fill)" />
      <path d={path} className={styles.pricePath} />
      {averageCost != null && <line x1="24" x2="556" y1={y(averageCost)} y2={y(averageCost)} className={styles.costLine} />}
      {selectedIndex >= 0 && <><line x1={x(selectedIndex)} x2={x(selectedIndex)} y1="25" y2="165" className={styles.selectedLine} /><circle cx={x(selectedIndex)} cy={y(candles[selectedIndex].close)} r="4" className={styles.selectedPoint} /></>}
      <text x="24" y="176" className={styles.chartText}>{candles[0].date.slice(5)}</text><text x="556" y="176" textAnchor="end" className={styles.chartText}>{candles.at(-1)?.date.slice(5)}</text>
    </svg>
  );
}

function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`${styles.modal} ${wide ? styles.modalWide : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button onClick={onClose} aria-label={`關閉${title}`}><X size={18} /></button></header>
        {children}
      </section>
    </div>
  );
}

function AlertStockSearch({ allStocks, alerts, onToggle }: { allStocks: StockRef[]; alerts: StockRef[]; onToggle: (stock: StockRef) => void }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allStocks.filter((stock) => !needle || stock.code.includes(needle) || stock.name.toLowerCase().includes(needle)).slice(0, 10);
  }, [allStocks, query]);
  return (
    <div className={styles.alertSearchWrap}>
      <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入代碼 / 名稱加入監控" aria-label="搜尋監控股票" /></label>
      <div className={styles.alertSearch}>
        {results.map((stock) => {
          const active = alerts.some((item) => item.code === stock.code);
          return <button key={stock.code} onClick={() => onToggle(stock)} className={active ? styles.alertActive : ''}><span>{stock.code} {stock.name}</span>{active ? <Check size={15} /> : <Plus size={15} />}</button>;
        })}
      </div>
    </div>
  );
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={styles.settingToggle}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function NotificationFeed({ alerts, date }: { alerts: StockRef[]; date: string }) {
  const rows = alerts.length > 0 ? alerts.slice(0, 6) : [{ code: '2330', name: '台積電' }, { code: '2454', name: '聯發科' }];
  return (
    <div className={styles.notificationFeed}>
      <div className={styles.alertIntro}><Bell size={20} /><p>這裡彙整盤後籌碼提醒。啟用推播後，同一批內容也會送到你的裝置。</p></div>
      {rows.map((stock, index) => (
        <article key={stock.code}>
          <span className={index % 2 === 0 ? styles.up : styles.down}>{index % 2 === 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}</span>
          <div><b>{stock.code} {stock.name}</b><p>{index % 2 === 0 ? '法人買超力道高於近 20 日常態，外資與投信同步買超。' : '外資連續賣超，今日籌碼力道放大。'}</p></div>
          <time>{date.slice(5)}</time>
        </article>
      ))}
    </div>
  );
}

function LoginModal({ onClose, onLogin }: { onClose: () => void; onLogin: () => void }) {
  return (
    <Modal title="歡迎登入" onClose={onClose}>
      <div className={styles.loginBody}>
        <span className={styles.loginWave}><Waves size={28} /></span>
        <h3>追蹤板塊動態與法人資金流向</h3>
        <p>登入後可同步自選、參加多空投票、查看戰績與管理籌碼提醒。</p>
        <button className={styles.googleButton} onClick={onLogin}><b>G</b> 使用 Google 登入（示範）</button>
        <small>此獨立重建版使用本機示範帳號，不會連線或取得你的 Google 資料。</small>
        <Link href="/tide/pricing">查看免費版與 Pro 方案 →</Link>
      </div>
    </Modal>
  );
}

function InviteModal({ onClose, onRedeem, setToast }: { onClose: () => void; onRedeem: () => void; setToast: (message: string) => void }) {
  const code = 'ROCKPRO7';
  const copy = () => navigator.clipboard?.writeText(`${location.origin}/tide?ref=${code}`).then(() => setToast('邀請連結已複製'));
  return (
    <Modal title="邀請好友賺 Pro" onClose={onClose}>
      <div className={styles.inviteBody}>
        <span className={styles.giftIcon}><Gift size={25} /></span>
        <p>把你的邀請碼給朋友，他拿 7 天 Pro，你也能累積 Pro 天數。</p>
        <label>你的專屬邀請碼</label>
        <button className={styles.referralCode} onClick={copy}>{code}<Copy size={16} /></button>
        <button className={styles.primaryButton} onClick={copy}><Copy size={15} /> 複製邀請連結</button>
        <div className={styles.inviteStats}><div><b>0</b><span>已邀請</span></div><div><b>0</b><span>賺到天數</span></div></div>
        <ul><li>朋友使用邀請碼 → 他獲得 7 天 Pro</li><li>朋友累計使用 7 天 → 你獲得 7 天 Pro</li><li>邀請獎勵最高可累計 90 天</li></ul>
        <button className={styles.textButton} onClick={onRedeem}>我有邀請碼</button>
      </div>
    </Modal>
  );
}

function RedeemModal({ onClose, setToast }: { onClose: () => void; setToast: (message: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <Modal title="輸入邀請碼" onClose={onClose}>
      <form className={styles.formBody} onSubmit={(event) => { event.preventDefault(); setToast(code.trim().length === 8 ? '邀請碼已兌換：Pro 功能已全部開啟' : '請輸入 8 碼邀請碼'); if (code.trim().length === 8) onClose(); }}>
        <p>輸入朋友給你的 8 碼邀請碼。這個獨立版的 Pro 已全部開啟，兌換流程僅做互動示範。</p>
        <label htmlFor="referral-code">邀請碼</label>
        <input id="referral-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 8))} placeholder="例：ABCD2345" />
        <button className={styles.primaryButton} type="submit" disabled={code.length !== 8}>兌換</button>
      </form>
    </Modal>
  );
}

function PerformanceModal({ onClose, vote, onLeaderboard, onInvite, onSignOut }: { onClose: () => void; vote: 'bull' | 'bear' | null; onLeaderboard: () => void; onInvite: () => void; onSignOut: () => void }) {
  return (
    <Modal title="我的" onClose={onClose}>
      <div className={styles.accountBody}>
        <div className={styles.memberCard}><span><Crown size={18} /></span><div><b>Pro 全功能會員</b><small>獨立重建版永久啟用</small></div><Check size={18} /></div>
        <h3>我的戰績</h3>
        <div className={styles.scoreGrid}><div><b>{vote ? '100%' : '—'}</b><span>預測準確率</span></div><div><b>{vote ? '1' : '0'}</b><span>連續看盤</span></div><div><b>{vote ? '1' : '0'}</b><span>目前連對</span></div></div>
        <button className={styles.menuButton} onClick={onLeaderboard}><Trophy size={16} /> 猜勝率排行榜 <ChevronRight size={16} /></button>
        <button className={styles.menuButton} onClick={onInvite}><Gift size={16} /> 邀請好友賺 Pro <ChevronRight size={16} /></button>
        <button className={styles.menuButton} onClick={() => navigator.clipboard?.writeText(location.href)}><Share2 size={16} /> 分享我的戰績 <ChevronRight size={16} /></button>
        <button className={`${styles.menuButton} ${styles.dangerButton}`} onClick={onSignOut}><LogOut size={16} /> 登出示範帳號</button>
      </div>
    </Modal>
  );
}

function LeaderboardModal({ onClose }: { onClose: () => void }) {
  const leaders = [['海風投資人', '83%', '48'], ['資金小偵探', '78%', '37'], ['看盤阿明', '75%', '32'], ['Rockstock 使用者', '—', '0']];
  return (
    <Modal title="猜勝率排行榜" onClose={onClose} wide>
      <div className={styles.leaderboardBody}>
        <p>依最近公開投票紀錄排序；下列為本機展示資料。</p>
        {leaders.map((leader, index) => <div key={leader[0]}><span>{index + 1}</span><b>{leader[0]}</b><strong>{leader[1]}</strong><small>{leader[2]} 天</small></div>)}
      </div>
    </Modal>
  );
}

const GUIDE_STEPS = [
  { title: '歡迎使用潮汐', text: '每天收盤後，幫你看懂法人把錢搬去哪個產業，又重押了哪些股票。', icon: <Waves size={34} /> },
  { title: '先看四種潮汐', text: '漲潮代表資金加速流入；輪動、觀望與退潮描述資金方向與速度。', icon: <BarChart3 size={34} /> },
  { title: '泡泡圖三個方向', text: '越右買得越多、越上速度越快、圓越大代表近 20 日金額越大。', icon: <Layers3 size={34} /> },
  { title: '點進個股看 Pro 深度', text: '法人分項、20 日均價、外資停留、力道與歷史回看都已完整啟用。', icon: <Crown size={34} /> },
];

function GuideModal({ step, setStep, onClose }: { step: number; setStep: (step: number) => void; onClose: () => void }) {
  const item = GUIDE_STEPS[step];
  return (
    <Modal title="新手教學" onClose={onClose}>
      <div className={styles.guideBody}>
        <span>{item.icon}</span><h3>{item.title}</h3><p>{item.text}</p>
        <div className={styles.guideDots}>{GUIDE_STEPS.map((_, index) => <i className={index === step ? styles.guideDotActive : ''} key={index} />)}</div>
        <div className={styles.guideActions}><button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>上一步</button><button className={styles.primaryButton} onClick={() => step === GUIDE_STEPS.length - 1 ? onClose() : setStep(step + 1)}>{step === GUIDE_STEPS.length - 1 ? '開始使用' : '下一步'}</button></div>
      </div>
    </Modal>
  );
}

function WishModal({ onClose, setToast }: { onClose: () => void; setToast: (message: string) => void }) {
  const [message, setMessage] = useState('');
  return (
    <Modal title="許願池" onClose={onClose} wide>
      <form className={styles.formBody} onSubmit={(event) => { event.preventDefault(); localStorage.setItem(`tide-clone-wish-${Date.now()}`, message); setToast('已把想法保存在這台裝置'); onClose(); }}>
        <p>想要什麼功能、哪裡用起來卡卡的，都可以告訴我們。</p>
        <label htmlFor="wish-type">類型</label>
        <select id="wish-type"><option>功能許願</option><option>介面 / 操作問題</option><option>資料 / 數字問題</option><option>其他</option></select>
        <label htmlFor="wish-message">你的想法</label>
        <textarea id="wish-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：希望可以追蹤自選股的大戶持股變化…" rows={5} />
        <label htmlFor="wish-email">聯絡方式（選填）</label>
        <input id="wish-email" type="email" placeholder="你的 Email" />
        <button className={styles.primaryButton} type="submit" disabled={!message.trim()}><Mail size={15} /> 送出</button>
      </form>
    </Modal>
  );
}
