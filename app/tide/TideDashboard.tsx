'use client';

import {
  BarChart3,
  Bell,
  BellRing,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Crown,
  Gift,
  GripVertical,
  Home,
  Layers3,
  ListFilter,
  LogOut,
  Mail,
  Moon,
  Pause,
  Play,
  Plus,
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
  Waves,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { TideProSnapshot } from '@/lib/tide/proData';
import type { SectorRankingFile } from '@/lib/themes/sectorRanking';
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
type ViewMode = 'bubble' | 'watch' | 'ranking';
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
  volume?: number;
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

async function shareOrCopy(title: string, text: string, url: string): Promise<'shared' | 'copied' | 'cancelled'> {
  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
      return 'shared';
    }
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    await navigator.clipboard?.writeText(url);
    return 'copied';
  }
}

export default function TideDashboard({
  initialDate,
  initialUniverse,
  initialThemes,
  proSnapshot,
}: {
  initialDate: string;
  initialUniverse: SectorRankingFile['universe'] | null;
  initialThemes: ThemeRank[];
  proSnapshot: TideProSnapshot | null;
}) {
  const [themes, setThemes] = useState(initialThemes);
  const [dataDate, setDataDate] = useState(initialDate);
  const [universeMeta, setUniverseMeta] = useState(initialUniverse);
  const [view, setView] = useState<ViewMode>('bubble');
  const [period, setPeriod] = useState<Period>(5);
  const [category, setCategory] = useState<FlowCategory>('all');
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<StockRef | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<ThemeRank | null>(null);
  const [watchlist, setWatchlist] = useState<StockRef[]>([]);
  const [watchFolders, setWatchFolders] = useState<string[]>([]);
  const [activeWatchFolder, setActiveWatchFolder] = useState('');
  const [watchFolderByCode, setWatchFolderByCode] = useState<Record<string, string>>({});
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
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
  const [chartHelpOpen, setChartHelpOpen] = useState(false);
  const [watchManageOpen, setWatchManageOpen] = useState(false);
  const [watchEditing, setWatchEditing] = useState(false);
  const [watchSort, setWatchSort] = useState<'manual' | 'code' | 'change'>('manual');
  const [watchWidth, setWatchWidth] = useState(310);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [textSize, setTextSize] = useState<TextSize>('small');
  const [riseColor, setRiseColor] = useState<RiseColor>('tw');
  const [haptics, setHaptics] = useState(true);
  const [notifications, setNotifications] = useState({ push: false, morning: true, close: true, poll: true, offers: true });
  const [hiddenThemes, setHiddenThemes] = useState<string[]>([]);
  const [pollVote, setPollVote] = useState<'bull' | 'bear' | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayIndex, setReplayIndex] = useState(Math.max(0, (proSnapshot?.historyDates.length ?? 1) - 1));
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<0.5 | 1 | 2>(1);
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
    const storedWatchlist = readStoredStocks('tide-clone-watchlist');
    setWatchlist(storedWatchlist);
    setAlerts(readStoredStocks('tide-clone-alerts'));
    try {
      const folders = JSON.parse(localStorage.getItem('tide-clone-watch-folders') ?? '[]');
      const folderMap = JSON.parse(localStorage.getItem('tide-clone-watch-folder-map') ?? '{}');
      const normalizedFolders = Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string' && folder.trim().length > 0) : [];
      const fallbackFolders = normalizedFolders.length > 0 ? normalizedFolders : storedWatchlist.length > 0 ? ['我的自選'] : [];
      const normalizedMap = folderMap && typeof folderMap === 'object' ? folderMap as Record<string, string> : {};
      if (fallbackFolders.length > 0) {
        for (const stock of storedWatchlist) if (!normalizedMap[stock.code]) normalizedMap[stock.code] = fallbackFolders[0];
      }
      setWatchFolders(fallbackFolders);
      setActiveWatchFolder(fallbackFolders[0] ?? '');
      setWatchFolderByCode(normalizedMap);
    } catch { /* 保留無資料夾狀態。 */ }
    const storedTheme = localStorage.getItem('tide-clone-theme');
    if (storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system') setThemeMode(storedTheme);
    const storedTextSize = localStorage.getItem('tide-clone-text-size');
    if (storedTextSize === 'small' || storedTextSize === 'medium' || storedTextSize === 'large') setTextSize(storedTextSize);
    const storedRiseColor = localStorage.getItem('tide-clone-rise-color');
    if (storedRiseColor === 'tw' || storedRiseColor === 'us') setRiseColor(storedRiseColor);
    const storedHaptics = localStorage.getItem('tide-clone-haptics');
    if (storedHaptics === '0' || storedHaptics === '1') setHaptics(storedHaptics === '1');
    const storedWatchWidth = Number(localStorage.getItem('tide-clone-watch-width'));
    if (Number.isFinite(storedWatchWidth) && storedWatchWidth >= 240 && storedWatchWidth <= 460) setWatchWidth(storedWatchWidth);
    try {
      const storedNotifications = JSON.parse(localStorage.getItem('tide-clone-notifications') ?? 'null');
      if (storedNotifications && typeof storedNotifications === 'object') setNotifications((current) => ({ ...current, ...storedNotifications }));
    } catch { /* 保留預設通知設定。 */ }
    try {
      const storedHiddenThemes = JSON.parse(localStorage.getItem('tide-clone-hidden-themes') ?? '[]');
      if (Array.isArray(storedHiddenThemes)) setHiddenThemes(storedHiddenThemes.filter((theme): theme is string => typeof theme === 'string'));
    } catch { /* 保留全部板塊顯示。 */ }
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

  const persistWatchFolders = useCallback((folders: string[], folderMap: Record<string, string>) => {
    localStorage.setItem('tide-clone-watch-folders', JSON.stringify(folders));
    localStorage.setItem('tide-clone-watch-folder-map', JSON.stringify(folderMap));
  }, []);

  const createWatchFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) return;
    if (watchFolders.some((folder) => folder === name)) { setToast('已經有同名資料夾'); return; }
    const nextFolders = [...watchFolders, name];
    setWatchFolders(nextFolders);
    setActiveWatchFolder(name);
    setFolderCreateOpen(false);
    setNewFolderName('');
    persistWatchFolders(nextFolders, watchFolderByCode);
    setToast(`已新增「${name}」資料夾`);
  }, [newFolderName, persistWatchFolders, watchFolderByCode, watchFolders]);

  const addWatch = useCallback((stock: StockRef) => {
    setWatchlist((current) => {
      if (current.some((item) => item.code === stock.code)) return current;
      const next = [...current, stock];
      const folder = activeWatchFolder || watchFolders[0] || '我的自選';
      const nextFolders = watchFolders.length > 0 ? watchFolders : [folder];
      const nextFolderMap = { ...watchFolderByCode, [stock.code]: folder };
      if (watchFolders.length === 0) setWatchFolders(nextFolders);
      if (!activeWatchFolder) setActiveWatchFolder(folder);
      setWatchFolderByCode(nextFolderMap);
      persistStocks('tide-clone-watchlist', next);
      persistWatchFolders(nextFolders, nextFolderMap);
      setToast(`已將 ${stock.name} 加入觀察清單`);
      return next;
    });
  }, [activeWatchFolder, persistStocks, persistWatchFolders, watchFolderByCode, watchFolders]);

  const toggleWatch = useCallback((stock: StockRef) => {
    setWatchlist((current) => {
      const exists = current.some((item) => item.code === stock.code);
      const next = exists ? current.filter((item) => item.code !== stock.code) : [...current, stock];
      const folder = activeWatchFolder || watchFolders[0] || '我的自選';
      const nextFolders = !exists && watchFolders.length === 0 ? [folder] : watchFolders;
      const nextFolderMap = { ...watchFolderByCode };
      if (exists) delete nextFolderMap[stock.code];
      else nextFolderMap[stock.code] = folder;
      if (!exists && watchFolders.length === 0) setWatchFolders(nextFolders);
      if (!exists && !activeWatchFolder) setActiveWatchFolder(folder);
      setWatchFolderByCode(nextFolderMap);
      persistStocks('tide-clone-watchlist', next);
      persistWatchFolders(nextFolders, nextFolderMap);
      setToast(exists ? `已將 ${stock.name} 移出觀察清單` : `已將 ${stock.name} 加入觀察清單`);
      return next;
    });
  }, [activeWatchFolder, persistStocks, persistWatchFolders, watchFolderByCode, watchFolders]);

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

  const changePushNotification = useCallback(async (checked: boolean) => {
    if (!checked) { changeNotification('push', false); return; }
    if (!('Notification' in window)) { setToast('這個瀏覽器不支援推播通知'); return; }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission !== 'granted') { changeNotification('push', false); setToast('尚未取得通知權限，請到瀏覽器設定開啟'); return; }
    changeNotification('push', true);
    setToast('推播通知已開啟');
  }, [changeNotification]);

  const shareDashboard = useCallback(async (label = 'Tide 台股資金潮汐') => {
    const result = await shareOrCopy(label, '查看今天台股法人資金流向', location.href);
    if (result === 'copied') setToast('連結已複製');
  }, []);

  const changeHiddenThemes = useCallback((next: string[]) => {
    setHiddenThemes(next);
    localStorage.setItem('tide-clone-hidden-themes', JSON.stringify(next));
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

  const watchThemes = useMemo<ThemeRank[]>(() => watchlist.reduce<ThemeRank[]>((items, stock) => {
    const sourceTheme = themes.find((theme) => theme.members.some((member) => member.code === stock.code));
    const member = sourceTheme?.members.find((item) => item.code === stock.code);
    if (!member) return items;
    items.push({
      theme: `${stock.code} ${stock.name}`,
      stockCount: 1,
      avgD1: member.d1,
      avgD5: member.d5,
      avgD20: member.d20,
      avgD60: member.d60,
      avgVolRatio: null,
      breadth: (member.d1 ?? 0) > 0 ? 1 : 0,
      instNet5: member.instNet5,
      instAmt5: member.instAmt?.[PERIOD_INDEX[5]] ?? null,
      stage: sourceTheme?.stage ?? '',
      topStock: member.d1 == null ? null : { code: member.code, name: member.name, d1: member.d1 },
      members: [member],
    });
    return items;
  }, []), [themes, watchlist]);

  const visibleUniverse = (view === 'watch' ? watchThemes : themes).filter((theme) => !hiddenThemes.includes(theme.theme));
  const categoryCounts = useMemo(() => {
    const counts = { flood: 0, rotation: 0, watch: 0, ebb: 0 };
    for (const item of visibleUniverse) counts[flowCategory(item)] += 1;
    return counts;
  }, [visibleUniverse]);
  const watchMetrics = useMemo(() => {
    const metrics = new Map<string, ThemeMember>();
    for (const theme of themes) {
      for (const member of theme.members) if (!metrics.has(member.code)) metrics.set(member.code, member);
    }
    return metrics;
  }, [themes]);
  const sortedWatchlist = useMemo(() => [...watchlist].sort((left, right) => {
    if (watchSort === 'manual') return 0;
    if (watchSort === 'code') return left.code.localeCompare(right.code, 'zh-Hant', { numeric: true });
    return (watchMetrics.get(right.code)?.d1 ?? Number.NEGATIVE_INFINITY) - (watchMetrics.get(left.code)?.d1 ?? Number.NEGATIVE_INFINITY);
  }), [watchMetrics, watchSort, watchlist]);
  const folderWatchlist = useMemo(() => activeWatchFolder ? sortedWatchlist.filter((stock) => watchFolderByCode[stock.code] === activeWatchFolder) : sortedWatchlist, [activeWatchFolder, sortedWatchlist, watchFolderByCode]);

  const topThemes = useMemo(() => [...themes].sort((a, b) => themeMoney(b, 5) - themeMoney(a, 5)), [themes]);
  const filteredThemes = useMemo(() => {
    const items = category === 'all' ? visibleUniverse : visibleUniverse.filter((item) => flowCategory(item) === category);
    const sorted = [...items].sort((a, b) => Math.abs(themeMoney(b, period)) - Math.abs(themeMoney(a, period)));
    if (showAll || view === 'watch') return sorted;
    if (category !== 'all') return sorted.slice(0, 15);
    const quota: Record<Exclude<FlowCategory, 'all'>, number> = { flood: 4, rotation: 4, watch: 3, ebb: 4 };
    return (Object.keys(quota) as Array<Exclude<FlowCategory, 'all'>>).flatMap((flow) => sorted.filter((item) => flowCategory(item) === flow).slice(0, quota[flow]));
  }, [category, period, showAll, view, visibleUniverse]);

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
    }, 900 / replaySpeed);
    return () => window.clearInterval(timer);
  }, [replayDates.length, replayPlaying, replaySpeed]);

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
          setUniverseMeta(payload.universe ?? null);
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
    setUniverseMeta(initialUniverse);
  }, [initialDate, initialThemes, initialUniverse, replayDates.length]);

  const openReplay = useCallback(() => {
    setReplayIndex(0);
    setReplayPlaying(replayDates.length > 1);
    setReplayOpen(true);
  }, [replayDates.length]);

  const startWatchResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const startX = event.clientX;
    const startWidth = watchWidth;
    const onMove = (moveEvent: PointerEvent) => setWatchWidth(Math.max(240, Math.min(460, startWidth + startX - moveEvent.clientX)));
    const onUp = (upEvent: PointerEvent) => {
      const next = Math.max(240, Math.min(460, startWidth + startX - upEvent.clientX));
      setWatchWidth(next);
      localStorage.setItem('tide-clone-watch-width', String(next));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [watchWidth]);

  const marketMembers = themes.flatMap((theme) => theme.members).filter((member) => member.d1 != null);
  const marketChange = marketMembers.length > 0
    ? marketMembers.reduce((sum, member) => sum + (member.d1 ?? 0), 0) / marketMembers.length
    : 0;
  const bullishPct = Math.round((marketMembers.filter((member) => (member.d1 ?? 0) > 0).length / Math.max(1, marketMembers.length)) * 100);

  return (
    <div className={styles.app} data-theme={resolvedTheme} data-text-size={textSize} data-rise-color={riseColor}>
      <div className={styles.marketStrip}>
        <span>全市場等權 <b className={marketChange >= 0 ? styles.up : styles.down}>{formatPct(marketChange)}</b></span>
        <span className={styles.stripDivider}>｜</span>
        <span>資料日期 {dataDate || '—'}</span>
        <Link className={styles.planLink} href="/tide/pricing">方案</Link>
        <span className={styles.updateNote}>⏳ 今日資料約 18:30 前更新</span>
        <span className={styles.sourceNote}>
          分類：TWSE／TPEx 官方產業
          {universeMeta && !universeMeta.pointInTime ? `（歷史回放沿用 ${universeMeta.rosterAsOf} 名單）` : ''}
          ｜僅彙整公開資訊，不構成投資建議
        </span>
      </div>

      <header className={styles.header}>
        <div className={styles.sentiment} aria-label={`明日多方 ${bullishPct}%`}>
          <button className={pollVote === 'bull' ? styles.pollSelected : ''} onClick={() => setPollOpen(true)}>多 {bullishPct}%</button>
          <div><i style={{ width: `${bullishPct}%` }} /></div>
          <button className={pollVote === 'bear' ? styles.pollSelected : ''} onClick={() => setPollOpen(true)}>{100 - bullishPct}% 空</button>
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
          <button className={styles.iconButton} onClick={() => void shareDashboard()} aria-label="分享 Tide"><Share2 size={16} /></button>
          <button className={styles.iconButton} onClick={() => { setAlertTab('watch'); setAlertsOpen(true); }} aria-label="籌碼異動提醒">
            <BellRing size={16} />{alerts.length > 0 && <span className={styles.countBadge}>{alerts.length}</span>}
          </button>
          <button className={styles.iconButton} onClick={() => changeTheme(themeMode === 'light' ? 'dark' : 'light')} aria-label="切換明暗主題">
            {themeMode === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button className={styles.iconButton} onClick={() => setSettingsOpen(true)} aria-label="設定"><Settings size={16} /></button>
          <button className={styles.loginButton} onClick={() => signedIn ? setPerformanceOpen(true) : setLoginOpen(true)}><UserRound size={15} /> {signedIn ? '我的' : '登入'}</button>
        </nav>
      </header>

      {highlightsOpen && (
        <section className={styles.highlights} aria-label="今日盤面重點">
          <header><b>今日重點（{dataDate.slice(5).replace('-', '/')}）</b><button onClick={() => setHighlightsOpen(false)} aria-label="收起今日重點"><X size={16} /></button></header>
          <div className={styles.moodSummary}><span>今日情緒 <b>{bullishPct}</b> {bullishPct >= 55 ? '樂觀' : bullishPct <= 40 ? '保守' : '中性'}</span><small>樂觀</small><i><em style={{ left: `${Math.max(4, Math.min(96, bullishPct))}%` }} /></i><small>恐慌</small></div>
          <p>法人買最多：{topThemes.slice(0, 3).map((item) => `${item.theme} ${formatMoney(themeMoney(item, 1))}`).join('、')}</p>
          <p>回顧：近 5 日法人買最多的 3 個板塊，平均 {formatPct(topThemes.slice(0, 3).reduce((sum, item) => sum + themeReturn(item, 5), 0) / 3)}（最佳 {topThemes[0]?.theme ?? '—'} {formatPct(topThemes[0] ? themeReturn(topThemes[0], 5) : 0)}）</p>
          <p>大戶異常：{(proSnapshot?.intensityLeaders ?? []).slice(0, 2).map((stock) => `${stock.name} ${stock.total >= 0 ? '被買' : '被倒'} ${formatMoney(Math.abs(stock.totalValue ?? 0))}`).join('　') || '目前沒有顯著異常'}</p>
          <button className={styles.shareBrief} onClick={() => void shareDashboard('Tide 今日盤面')}><Share2 size={15} /> 分享今日盤面</button>
        </section>
      )}

      <div className={styles.workspace} style={{ '--watch-width': `${watchWidth}px` } as CSSProperties}>
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
                {view === 'bubble' ? '板塊泡泡圖' : view === 'watch' ? '自選股' : '板塊排行榜'}
                <ChevronDown size={14} />
              </button>
              {viewMenuOpen && (
                <div className={styles.viewMenu} role="menu">
                  <button role="menuitem" aria-current={view === 'watch'} onClick={() => { setView('watch'); setViewMenuOpen(false); setCategory('all'); }}><Home size={15} /> 自選股</button>
                  <button role="menuitem" aria-current={view === 'bubble'} onClick={() => { setView('bubble'); setViewMenuOpen(false); }}><Layers3 size={15} /> 板塊泡泡圖</button>
                  <button role="menuitem" aria-current={view === 'ranking'} onClick={() => { setView('ranking'); setViewMenuOpen(false); }}><ListFilter size={15} /> 板塊排行榜</button>
                </div>
              )}
            </div>
            {view === 'bubble' ? (
              <>
                <button className={styles.showAllButton} onClick={() => setShowAll(!showAll)}>{showAll ? '只看熱門 15' : `顯示全部 ${themes.length} 個`}</button>
                <span className={styles.chartHint}>越右＝近 5 日買越多・越上＝買的速度在加快・圈越大＝近 20 日金額越大 ｜ 滾輪縮放 · 拖曳移動</span>
                <button className={`${styles.helpButton} ${chartHelpOpen ? styles.toolbarActive : ''}`} aria-label="怎麼看這張圖" onClick={() => setChartHelpOpen((open) => !open)}><CircleHelp size={15} /></button>
                <button className={`${styles.replayButton} ${replayOpen ? styles.toolbarActive : ''}`} onClick={openReplay}><Play size={14} /> 回放</button>
              </>
            ) : view === 'watch' ? <><button className={styles.helpButton} aria-label="怎麼看這張圖" onClick={() => setChartHelpOpen((open) => !open)}><CircleHelp size={15} /></button><button className={styles.replayButton} onClick={openReplay}><Play size={14} /> 回放</button></> : null}
            {chartHelpOpen && view === 'bubble' && <aside className={styles.chartHelpPopover}><b>怎麼看這張圖</b><ul><li>越右＝近 5 日法人買越多；越左＝賣越多</li><li>越上＝力道在加速；越下＝在放緩</li><li>所以右上角＝買最多、還在加速</li><li>泡泡大小＝近 20 日買賣總額，只是規模、不分好壞</li><li>每顆泡泡都標著板塊名；熱門板塊會顯示金額</li><li>板塊太多時，可切成只看熱門或顯示全部</li></ul><p>在「自選股」挑幾個板塊，圖上就只亮你選的；長線＝主角走過的路。</p></aside>}
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

          {view === 'watch' && (watchThemes.length > 0 ? <BubbleView themes={filteredThemes} period={period} selectedTheme={selectedTheme} onCloseTheme={() => setSelectedTheme(null)} onSelectStock={setSelected} onSelectTheme={setSelectedTheme} /> : <div className={styles.watchModeEmpty}><span>還沒有自選股</span><button onClick={() => setWatchSearchOpen(true)}><Plus size={16} /> 到「自選」加入個股</button><p>加進資料夾後，這裡就會畫出你的個股泡泡</p><div className={styles.chartBrand}><Waves size={30} /><span>tide-tw.app</span></div></div>)}

          {view === 'ranking' && <RankingView themes={themes} period={period} setPeriod={setPeriod} snapshot={proSnapshot} marketChange={marketChange} onSelect={setSelected} />}
        </section>

        <aside className={styles.watchPanel} id="tide-watchlist">
          <button className={styles.watchResizer} role="separator" aria-orientation="vertical" aria-label="調整自選清單寬度" aria-valuemin={240} aria-valuemax={460} aria-valuenow={watchWidth} onPointerDown={startWatchResize} onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = Math.max(240, Math.min(460, watchWidth + (event.key === 'ArrowLeft' ? 10 : -10)));
            setWatchWidth(next);
            localStorage.setItem('tide-clone-watch-width', String(next));
          }}><GripVertical size={13} /></button>
          <div className={styles.watchHeader}>
            <div><span>觀察清單</span>{watchlist.length > 0 && <small>{watchlist.length} 檔</small>}</div>
            <div>
              <button aria-expanded={watchSearchOpen} onClick={() => { setWatchSearchOpen((open) => !open); setWatchQuery(''); setWatchManageOpen(false); }}><Plus size={14} /> 添加</button>
              <button aria-label="更多操作" aria-expanded={watchManageOpen} onClick={() => setWatchManageOpen((open) => !open)}>⋯</button>
              <button aria-label="新增自選資料夾" aria-expanded={folderCreateOpen} onClick={() => { setFolderCreateOpen((open) => !open); setWatchManageOpen(false); setWatchSearchOpen(false); }}><Plus size={14} /></button>
            </div>
          </div>
          {folderCreateOpen && <form className={styles.folderCreate} onSubmit={(event) => { event.preventDefault(); createWatchFolder(); }}>
            <input autoFocus value={newFolderName} onChange={(event) => setNewFolderName(event.target.value.slice(0, 20))} placeholder="資料夾名稱" aria-label="資料夾名稱" />
            <button type="submit" disabled={!newFolderName.trim()}>建立</button>
            <button type="button" onClick={() => { setFolderCreateOpen(false); setNewFolderName(''); }} aria-label="取消新增資料夾"><X size={14} /></button>
          </form>}
          {watchFolders.length > 0 && <nav className={styles.folderTabs} aria-label="自選資料夾">
            {watchFolders.map((folder) => <button key={folder} className={folder === activeWatchFolder ? styles.folderTabActive : ''} onClick={() => setActiveWatchFolder(folder)}><span>{folder}</span><small>{watchlist.filter((stock) => watchFolderByCode[stock.code] === folder).length}</small></button>)}
          </nav>}
          {watchManageOpen && <div className={styles.watchManageMenu}>
            <div><button onClick={() => { setFolderCreateOpen(true); setWatchManageOpen(false); }}><Plus size={13} /> 新增資料夾</button><button className={watchEditing ? styles.actionActive : ''} onClick={() => setWatchEditing((editing) => !editing)}>編輯</button></div>
            <span>排序（同項再點＝升／降）</span>
            <div><button className={watchSort === 'code' ? styles.actionActive : ''} onClick={() => setWatchSort('code')}>依代碼</button><button className={watchSort === 'change' ? styles.actionActive : ''} onClick={() => setWatchSort('change')}>依當日漲幅</button><button className={watchSort === 'manual' ? styles.actionActive : ''} onClick={() => setWatchSort('manual')}>手動順序 ✓</button></div>
          </div>}
          {watchSearchOpen && (
            <div className={styles.watchSearchPopover}>
              <label><Search size={14} /><input autoFocus value={watchQuery} onChange={(event) => setWatchQuery(event.target.value)} placeholder="股票代碼 / 名稱" aria-label="股票代碼 / 名稱" /><button onClick={() => { setWatchSearchOpen(false); setWatchQuery(''); }} aria-label="關閉股票搜尋"><X size={14} /></button></label>
              <div>
                {watchQuery && watchSearchResults.map((stock) => (
                  <button key={stock.code} onClick={() => { addWatch(stock); setWatchSearchOpen(false); setWatchQuery(''); }}>
                    <span><b>{stock.code}</b><small>{stock.name}</small></span><em>{stock.theme ?? '個股'}</em><Plus size={14} />
                  </button>
                ))}
                {watchQuery && watchSearchResults.length === 0 && <p>找不到符合的股票</p>}
              </div>
            </div>
          )}
          {watchlist.length === 0 ? (
            <div className={styles.emptyWatch}>
              <b>尚無清單</b>
              <p>點右上 ＋ 新增大分類清單，或「＋ 添加」直接搜尋個股</p>
              <span>還沒有自選股？這幾檔今天法人買最多，點 ＋ 一鍵追蹤</span>
              {(proSnapshot?.netLeaders ?? []).slice(0, 5).map((stock) => (
                <button key={stock.symbol} onClick={() => addWatch({ code: stock.symbol, name: stock.name })}>
                  <span><b>{stock.symbol}</b> {stock.name}</span><em>{formatMoney(stock.totalValue)}</em><Plus size={14} />
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.watchList}>
              {folderWatchlist.map((stock) => {
                const pro = proSnapshot?.netLeaders.find((item) => item.symbol === stock.code);
                const metric = watchMetrics.get(stock.code);
                return (
                  <button key={stock.code} onClick={() => setSelected(stock)}>
                    <span><b>{stock.code}</b><small>{stock.name}</small></span>
                    <span className={(pro?.total ?? metric?.instNet5 ?? 0) >= 0 ? styles.up : styles.down}>{pro?.totalValue != null ? formatMoney(pro.totalValue) : formatPct(metric?.d1 ?? null)}</span>
                    {alerts.some((item) => item.code === stock.code) && <Bell size={13} />}
                    {watchEditing ? <X size={15} onClick={(event) => { event.stopPropagation(); toggleWatch(stock); }} /> : <ChevronRight size={15} />}
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

      {replayOpen && <ReplayOverlay
        themes={themes}
        date={replayDates[replayIndex] ?? dataDate}
        startDate={replayDates[0] ?? dataDate}
        endDate={replayDates.at(-1) ?? dataDate}
        index={replayIndex}
        max={Math.max(0, replayDates.length - 1)}
        playing={replayPlaying}
        speed={replaySpeed}
        loading={replayLoading}
        onIndex={(next) => { setReplayPlaying(false); setReplayIndex(next); }}
        onPrevious={() => { setReplayPlaying(false); setReplayIndex((current) => Math.max(0, current - 1)); }}
        onNext={() => { setReplayPlaying(false); setReplayIndex((current) => Math.min(Math.max(0, replayDates.length - 1), current + 1)); }}
        onPlay={() => setReplayPlaying((playing) => !playing)}
        onSpeed={() => setReplaySpeed((speed) => speed === 0.5 ? 1 : speed === 1 ? 2 : 0.5)}
        onClose={() => { setReplayOpen(false); resetLatest(); }}
      />}

      {selected && (
        <StockDrawer
          stock={selected}
          onClose={() => setSelected(null)}
          watched={watchlist.some((item) => item.code === selected.code)}
          alerted={alerts.some((item) => item.code === selected.code)}
          onWatch={() => toggleWatch(selected)}
          onAlert={() => toggleAlert(selected)}
        />
      )}

      {pollOpen && <Modal title="你覺得明天大盤會…" onClose={() => setPollOpen(false)}><div className={styles.pollModalBody}><div><button onClick={() => { if (!signedIn) { setPollOpen(false); setLoginOpen(true); setToast('請先登入再投票'); return; } submitVote('bull'); setPollOpen(false); }}><TrendingUp size={22} />看多</button><button onClick={() => { if (!signedIn) { setPollOpen(false); setLoginOpen(true); setToast('請先登入再投票'); return; } submitVote('bear'); setPollOpen(false); }}><TrendingDown size={22} />看空</button></div><p>{signedIn ? '一人一票，結果會記錄在我的戰績' : '登入後即可投票（一人一票，結果更可信）'}</p></div></Modal>}

      {settingsOpen && (
        <Modal title="⚙️ 設定" onClose={() => setSettingsOpen(false)} wide>
          <div className={styles.settingsBody}>
            <label>漲跌顏色</label>
            <div className={styles.optionButtons}>
              <button className={riseColor === 'tw' ? styles.selectedOption : ''} onClick={() => changeRiseColor('tw')}>🇹🇼 紅漲綠跌</button>
              <button className={riseColor === 'us' ? styles.selectedOption : ''} onClick={() => changeRiseColor('us')}>🇺🇸 綠漲紅跌</button>
            </div>
            <label>字幕大小</label>
            <div className={`${styles.optionButtons} ${styles.threeOptions}`}>
              {(['small', 'medium', 'large'] as TextSize[]).map((size) => <button key={size} className={textSize === size ? styles.selectedOption : ''} onClick={() => changeTextSize(size)}>{size === 'small' ? '小' : size === 'medium' ? '中' : '大'}</button>)}
            </div>
            <label>觸覺回饋</label>
            <div className={styles.optionButtons}>
              <button className={haptics ? styles.selectedOption : ''} onClick={() => changeHaptics(true)}>開</button>
              <button className={!haptics ? styles.selectedOption : ''} onClick={() => changeHaptics(false)}>關</button>
            </div>
            <label>畫面主題</label>
            <div className={`${styles.optionButtons} ${styles.threeOptions}`}>
              <button className={themeMode === 'dark' ? styles.selectedOption : ''} onClick={() => changeTheme('dark')}><Moon size={16} /> 暗色</button>
              <button className={themeMode === 'light' ? styles.selectedOption : ''} onClick={() => changeTheme('light')}><Sun size={16} /> 亮色</button>
              <button className={themeMode === 'system' ? styles.selectedOption : ''} onClick={() => changeTheme('system')}><SlidersHorizontal size={16} /> 跟隨系統</button>
            </div>
            <label>通知設定</label>
            <div className={styles.notificationSettings}>
              <SettingToggle label="開啟推播通知（先開這個才收得到）" checked={notifications.push} onChange={(checked) => void changePushNotification(checked)} />
              <SettingToggle label="開盤前重點（08:30）" checked={notifications.morning} onChange={(checked) => changeNotification('morning', checked)} />
              <SettingToggle label="盤後結算（約 19:00）" checked={notifications.close} onChange={(checked) => changeNotification('close', checked)} />
              <SettingToggle label="投票提醒（收盤邀請 / 開盤結果）" checked={notifications.poll} onChange={(checked) => changeNotification('poll', checked)} />
              <SettingToggle label="優惠與活動通知（email）" checked={notifications.offers} onChange={(checked) => changeNotification('offers', checked)} />
            </div>
            <label>官方產業顯示（取消勾選即從圖表隱藏）</label>
            <div className={styles.sectorSettings}>
              {[...themes].sort((left, right) => left.theme.localeCompare(right.theme, 'zh-Hant')).map((theme) => {
                const checked = !hiddenThemes.includes(theme.theme);
                return <label key={theme.theme} className={styles.sectorGroup}>
                  <input type="checkbox" checked={checked} onChange={() => changeHiddenThemes(checked ? [...hiddenThemes, theme.theme] : hiddenThemes.filter((name) => name !== theme.theme))} />
                  <span>{theme.theme}</span><small>{theme.stockCount} 檔</small>
                </label>;
              })}
            </div>
            <label>說明與關於</label>
            <div className={styles.settingsLinks}>
              <button onClick={() => { setSettingsOpen(false); setGuideStep(0); setGuideOpen(true); }}><BookOpen size={15} /> 新手教學</button>
              <Link href="/tide/pricing"><Crown size={15} /> 方案與定價</Link>
              <Link href="/tide/glossary"><CircleHelp size={15} /> 名詞小百科</Link>
              <Link href="/tide/legal"><ShieldCheck size={15} /> 條款・隱私・退款</Link>
              <button onClick={() => { setSettingsOpen(false); setWishOpen(true); }}><Send size={15} /> 許願池</button>
            </div>
            <div className={styles.settingsContact}><b>聯絡我們</b><span>有任何問題、退款或合作需求，歡迎來信</span><a href="mailto:support@tide-tw.app">support@tide-tw.app</a></div>
            <p><b>資料來源與免責</b><br />資料來源為證交所與櫃買中心公開資料。本服務僅彙整公開市場資訊，不提供分析意見或推介建議，亦不構成投資建議。</p>
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

      {toast && <div className={styles.toast} role="status" aria-live="polite"><Check size={15} /> {toast}</div>}
    </div>
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
      cx: Number((470 + (item.x / maxX) * (item.x >= 0 ? 420 : 340)).toFixed(3)),
      cy: Number((360 - (item.y / maxY) * 290).toFixed(3)),
      radius: Number((24 + (item.size / maxSize) * 42).toFixed(3)),
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
        point.cy = Math.max(38 + point.radius, Math.min(700 - point.radius, point.cy));
      }
    }
    return placed.map((point) => ({ ...point, cx: Number(point.cx.toFixed(3)), cy: Number(point.cy.toFixed(3)) }));
  }, [period, themes]);

  return (
    <div className={styles.bubbleView}>
      <div className={styles.chartWrap}>
        <svg viewBox="0 0 1000 760" role="img" aria-label="台股板塊法人資金泡泡圖">
          <defs>
            <pattern id="tide-grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" className={styles.gridLine} fill="none" />
            </pattern>
            <filter id="bubble-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="4" stdDeviation="6" floodOpacity="0.15" />
            </filter>
          </defs>
          <rect x="105" y="28" width="815" height="680" fill="url(#tide-grid)" className={styles.chartBg} />
          <line x1="470" y1="28" x2="470" y2="708" className={styles.axisLine} />
          <line x1="105" y1="360" x2="920" y2="360" className={styles.axisLine} />
          <text x="470" y="728" textAnchor="middle" className={styles.axisLabel}>0</text>
          <text x="110" y="728" textAnchor="middle" className={styles.axisLabel}>−500</text>
          <text x="270" y="728" textAnchor="middle" className={styles.axisLabel}>−100</text>
          <text x="390" y="728" textAnchor="middle" className={styles.axisLabel}>−20</text>
          <text x="620" y="728" textAnchor="middle" className={styles.axisLabel}>+20</text>
          <text x="780" y="728" textAnchor="middle" className={styles.axisLabel}>+100</text>
          <text x="915" y="728" textAnchor="middle" className={styles.axisLabel}>+500</text>
          <text x="91" y="50" textAnchor="end" className={styles.axisLabel}>+50億/天</text>
          <text x="91" y="170" textAnchor="end" className={styles.axisLabel}>+20億/天</text>
          <text x="91" y="364" textAnchor="end" className={styles.axisLabel}>0億/天</text>
          <text x="91" y="560" textAnchor="end" className={styles.axisLabel}>−20億/天</text>
          <text x="91" y="700" textAnchor="end" className={styles.axisLabel}>−50億/天</text>
          <text x="107" y="750" textAnchor="start" className={styles.axisTitle}>← 資金流出（億）</text>
          <text x="917" y="750" textAnchor="end" className={styles.axisTitle}>資金流入（億） →</text>
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

function ReplayOverlay({ themes, date, startDate, endDate, index, max, playing, speed, loading, onIndex, onPrevious, onNext, onPlay, onSpeed, onClose }: {
  themes: ThemeRank[];
  date: string;
  startDate: string;
  endDate: string;
  index: number;
  max: number;
  playing: boolean;
  speed: 0.5 | 1 | 2;
  loading: boolean;
  onIndex: (index: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  onPlay: () => void;
  onSpeed: () => void;
  onClose: () => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedThemes, setSelectedThemes] = useState<string[]>([]);
  const hotThemes = useMemo(() => [...themes].sort((a, b) => Math.abs(themeMoney(b, 5)) - Math.abs(themeMoney(a, 5))).slice(0, 31), [themes]);
  const replayThemes = useMemo(() => selectedThemes.length === 0 ? hotThemes : themes.filter((theme) => selectedThemes.includes(theme.theme)), [hotThemes, selectedThemes, themes]);
  const biggestBuy = [...themes].sort((a, b) => themeMoney(b, 5) - themeMoney(a, 5))[0];
  const biggestSell = [...themes].sort((a, b) => themeMoney(a, 5) - themeMoney(b, 5))[0];
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') onPrevious();
      if (event.key === 'ArrowRight') onNext();
      if (event.key === ' ') { event.preventDefault(); onPlay(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, onNext, onPlay, onPrevious]);
  return <section className={styles.replayOverlay} role="dialog" aria-modal="true" aria-label="板塊資金輪動回放">
    <header>
      <b>板塊資金輪動回放</b>
      <button className={`${styles.helpButton} ${helpOpen ? styles.toolbarActive : ''}`} aria-label="怎麼看這張圖" onClick={() => { setHelpOpen((open) => !open); setFilterOpen(false); }}><CircleHelp size={15} /></button>
      <button className={styles.replaySelectButton} aria-expanded={filterOpen} onClick={() => { setFilterOpen((open) => !open); setHelpOpen(false); }}>選板塊 <ChevronDown size={13} /></button>
      <button className={styles.replayClose} onClick={onClose} aria-label="關閉回放"><X size={18} /></button>
      {helpOpen && <aside className={styles.replayHelp}><b>怎麼看這張圖</b><p>越右代表近 5 日法人買越多，越上代表買進速度加快，圓圈越大代表近 20 日金額越大。</p><small>快捷鍵：空白鍵播放／暫停，← → 切換交易日，Esc 關閉。</small></aside>}
      {filterOpen && <aside className={styles.replayPicker} aria-label="選擇回放板塊">
        <label><Search size={14} /><input autoFocus value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="搜尋板塊…" /></label>
        <div className={styles.replayPickerSummary}><span>已選 <b>{selectedThemes.length}</b> 個官方產業</span><button onClick={() => setSelectedThemes(selectedThemes.length === themes.length ? [] : themes.map((theme) => theme.theme))}>{selectedThemes.length === themes.length ? '清除' : '全選'}</button></div>
        <div>{themes.filter((theme) => !filterQuery || theme.theme.includes(filterQuery)).map((theme) => {
          const checked = selectedThemes.includes(theme.theme);
          return <label key={theme.theme}><input type="checkbox" checked={checked} onChange={() => setSelectedThemes((current) => checked ? current.filter((item) => item !== theme.theme) : [...current, theme.theme])} /><span>{theme.theme}</span><small>{theme.stockCount}</small></label>;
        })}</div>
      </aside>}
    </header>
    <div className={styles.replayChart}><button className={styles.replayFilter} onClick={() => setSelectedThemes([])}>{selectedThemes.length === 0 ? `熱門 ${hotThemes.length}` : `已選 ${replayThemes.length}`}</button><BubbleView themes={replayThemes} period={5} selectedTheme={null} onCloseTheme={() => {}} onSelectStock={() => {}} onSelectTheme={() => {}} />{loading && <span className={styles.replayLoading}>資料讀取中…</span>}</div>
    <div className={styles.replaySummary}><span>近5日買最多 <b className={styles.up}>{biggestBuy?.theme ?? '—'} {formatMoney(biggestBuy ? themeMoney(biggestBuy, 5) : 0)}</b></span><span>近5日賣最多 <b className={styles.down}>{biggestSell?.theme ?? '—'} {formatMoney(biggestSell ? themeMoney(biggestSell, 5) : 0)}</b></span><strong>{date ? `${date.slice(5, 7)}/${date.slice(8)} ` : ''}{date ? new Intl.DateTimeFormat('zh-TW', { weekday: 'short' }).format(new Date(`${date}T12:00:00`)) : ''}</strong></div>
    <div className={styles.replayTimeline}><input type="range" min={0} max={max} value={Math.min(index, max)} onChange={(event) => onIndex(Number(event.target.value))} aria-label="回放進度" /><div><span>{startDate?.slice(5).replace('-', '/')}</span><span>{endDate?.slice(5).replace('-', '/')}</span></div></div>
    <footer><span className={styles.replayBrand}><Waves size={22} /> tide-tw.app</span><div><button onClick={onPrevious} aria-label="上一個交易日">‹</button><button onClick={onPlay} aria-label={playing ? '暫停' : '播放'}>{playing ? <Pause size={17} /> : <Play size={17} />}</button><button onClick={onNext} aria-label="下一個交易日">›</button></div><button className={styles.speedButton} onClick={onSpeed} aria-label="播放速度">{speed}x</button></footer>
  </section>;
}

function RankingView({ themes, period, setPeriod, snapshot, marketChange, onSelect }: { themes: ThemeRank[]; period: Period; setPeriod: (period: Period) => void; snapshot: TideProSnapshot | null; marketChange: number; onSelect: (stock: StockRef) => void }) {
  const [lens, setLens] = useState<'flow' | 'breadth' | 'contrarian' | 'anomaly' | 'dual'>('flow');
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [dualMode, setDualMode] = useState<'sameBuy' | 'sameSell' | 'streakBuy' | 'streakSell'>('sameBuy');
  const rows = useMemo(() => {
    let items = [...themes];
    if (lens === 'contrarian') items = marketChange <= -1 ? items.filter((theme) => themeMoney(theme, 1) > 0) : [];
    items.sort((a, b) => {
      if (lens === 'breadth') return (themeMoney(b, 5) / Math.max(1, 1 + Math.max(0, themeReturn(b, 5)))) - (themeMoney(a, 5) / Math.max(1, 1 + Math.max(0, themeReturn(a, 5))));
      return direction === 'buy' ? themeMoney(b, period) - themeMoney(a, period) : themeMoney(a, period) - themeMoney(b, period);
    });
    return items;
  }, [direction, lens, marketChange, period, themes]);
  const stockRows = useMemo(() => {
    const result = lens === 'anomaly'
      ? (snapshot?.intensityLeaders ?? []).filter((stock) => direction === 'buy' ? stock.total >= 0 : stock.total < 0)
      : lens !== 'dual' ? []
        : dualMode === 'sameBuy' ? snapshot?.simultaneousBuy ?? []
          : dualMode === 'sameSell' ? snapshot?.simultaneousSell ?? []
            : (snapshot?.foreignStreaks ?? []).filter((stock) => dualMode === 'streakBuy' ? stock.streakDirection === 'buy' : stock.streakDirection === 'sell');
    return [...result].sort((left, right) => Math.abs(right.totalValue ?? 0) - Math.abs(left.totalValue ?? 0));
  }, [direction, dualMode, lens, snapshot]);
  const largest = Math.max(1, ...rows.map((theme) => Math.abs(themeMoney(theme, period))));
  const note = lens === 'flow'
    ? `近 ${period} 日法人${direction === 'buy' ? '買' : '賣'}最多的板塊（近 ${period} 個交易日累計，只呈現事實、不構成投資建議）`
    : lens === 'breadth'
      ? '依「近 5 日資金流入高、同期漲幅相對低」排序；僅呈現籌碼與股價的落差，不代表未來漲跌'
      : lens === 'contrarian'
        ? marketChange <= -1 ? `今天大盤 ${formatPct(marketChange)}，以下是逆勢獲法人買超的板塊` : `☀️ 今天大盤 ${formatPct(marketChange)}，沒有顯著下跌，逆勢買超偵測沒有啟動`
        : lens === 'anomaly'
          ? `今天突然被法人${direction === 'buy' ? '大買' : '大賣'}的個股（相對它近 20 日的平常，買賣力道大到異常；只呈現事實、不構成投資建議）`
          : dualMode === 'sameBuy' ? `今天有 ${stockRows.length} 檔外資與投信同日各買超 0.5 億以上` : dualMode === 'sameSell' ? `今天有 ${stockRows.length} 檔外資與投信同日各賣超 0.5 億以上` : `外資連續${dualMode === 'streakBuy' ? '買超' : '賣超'} 3 天以上的個股`;
  return (
    <div className={styles.themeRanking}>
      <div className={styles.rankingFilters}>
        <div className={styles.rankingLenses}>
          {([
            ['flow', '法人動向'], ['breadth', '買多漲少'], ['contrarian', '逆勢買超'], ['anomaly', '個股異常'], ['dual', '外資投信'],
          ] as const).map(([key, label]) => <button key={key} className={lens === key ? styles.rankingActive : ''} onClick={() => setLens(key)}>{label}</button>)}
        </div>
        {lens === 'dual' ? <div className={styles.rankingSegments}><div>{([['sameBuy', '同買'], ['sameSell', '同賣'], ['streakBuy', '連買'], ['streakSell', '連賣']] as const).map(([key, label]) => <button key={key} className={dualMode === key ? styles.rankingActive : ''} onClick={() => setDualMode(key)}>{label}</button>)}</div></div> : lens === 'flow' ? <div className={styles.rankingSegments}><div><button className={direction === 'buy' ? styles.rankingActive : ''} onClick={() => setDirection('buy')}>買超</button><button className={direction === 'sell' ? styles.rankingActive : ''} onClick={() => setDirection('sell')}>賣超</button></div><div>{([1, 5] as Period[]).map((value) => <button key={value} className={period === value ? styles.rankingActive : ''} onClick={() => setPeriod(value)}>{value === 1 ? '當日' : '5 日'}</button>)}</div></div> : lens === 'anomaly' ? <div className={styles.rankingSegments}><div><button className={direction === 'buy' ? styles.rankingActive : ''} onClick={() => setDirection('buy')}>爆買</button><button className={direction === 'sell' ? styles.rankingActive : ''} onClick={() => setDirection('sell')}>爆賣</button></div></div> : null}
      </div>
      <p className={styles.rankingNote}>{note}</p>
      {(lens === 'anomaly' || lens === 'dual') ? <div className={styles.stockRankingList}>
        {stockRows.map((stock, index) => <button key={stock.symbol} onClick={() => onSelect({ code: stock.symbol, name: stock.name })}><span className={styles.rankingNumber}>{index + 1}</span><span className={styles.rankingTheme}><b><i style={{ background: stock.total >= 0 ? CATEGORY_META.flood.color : CATEGORY_META.ebb.color }} />{stock.name} <small>{stock.symbol}</small></b><small>{lens === 'anomaly' ? `${stock.intensity.toFixed(1)}× 平常力道` : dualMode.startsWith('same') ? `外資 ${formatMoney(stock.foreignValue)} · 投信 ${formatMoney(stock.trustValue)}` : `外資${stock.streakDirection === 'buy' ? '連買' : '連賣'} ${stock.streak} 天`}</small></span><strong className={stock.total >= 0 ? styles.up : styles.down}>{formatMoney(stock.totalValue)}</strong><span className={styles.rankingBar}><i style={{ width: `${Math.min(100, Math.max(5, (stock.intensity ?? 1) * 18))}%` }} /></span></button>)}
        {stockRows.length === 0 && <p className={styles.emptyText}>目前沒有符合條件的個股。</p>}
      </div> : <>
        {lens !== 'contrarian' || rows.length > 0 ? <div className={styles.rankingColumns}><span>5 日漲跌</span><span>{lens === 'flow' ? `${period} 日` : '5 日'}淨買超(億)</span></div> : null}
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
        {rows.length === 0 && <p className={styles.emptyText}>{lens === 'contrarian' ? '大盤跌幅超過 1% 時才會啟動逆勢買超偵測' : '目前沒有符合條件的板塊。'}</p>}
      </div></>}
    </div>
  );
}

function StockDrawer({ stock, onClose, watched, alerted, onWatch, onAlert }: { stock: StockRef; onClose: () => void; watched: boolean; alerted: boolean; onWatch: () => void; onAlert: () => void }) {
  const [data, setData] = useState<StockDetailData>({ chips: [], candles: [], loading: true, error: null });
  const [selectedDate, setSelectedDate] = useState('');
  const [chartPlaying, setChartPlaying] = useState(false);

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
  const selectedDateIndex = data.chips.findIndex((row) => row.date === selectedDate);
  const moveDate = (offset: number) => {
    setChartPlaying(false);
    const next = data.chips[Math.max(0, Math.min(data.chips.length - 1, selectedDateIndex + offset))];
    if (next) setSelectedDate(next.date);
  };

  useEffect(() => {
    if (!chartPlaying || data.chips.length === 0) return;
    const timer = window.setInterval(() => {
      setSelectedDate((current) => {
        const index = data.chips.findIndex((row) => row.date === current);
        if (index >= data.chips.length - 1) { setChartPlaying(false); return current; }
        return data.chips[Math.max(0, index + 1)].date;
      });
    }, 420);
    return () => window.clearInterval(timer);
  }, [chartPlaying, data.chips]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className={styles.drawerBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className={styles.stockDrawer} role="dialog" aria-modal="true" aria-label={`${stock.name} Pro 籌碼詳情`}>
        <header className={styles.drawerHeader}>
          <div><span className={styles.stockCode}>{stock.code}</span><h2>{stock.name}</h2></div>
          <div className={styles.drawerHeaderActions}><div className={styles.drawerDateNav}><button onClick={() => moveDate(-1)} aria-label="前一個交易日">‹</button><select value={selectedDate} onChange={(event) => { setChartPlaying(false); setSelectedDate(event.target.value); }} aria-label="選擇資料日期">{data.chips.slice().reverse().map((row) => <option value={row.date} key={row.date}>{row.date.slice(5).replace('-', '/')}</option>)}</select><button onClick={() => moveDate(1)} aria-label="後一個交易日">›</button><span>Pro</span></div><button onClick={() => navigator.clipboard?.writeText(location.href)} aria-label="分享個股"><Share2 size={17} /></button><button onClick={onClose} aria-label="關閉個股詳情"><X size={18} /></button></div>
        </header>
        {data.loading ? <div className={styles.drawerLoading}><Waves size={28} /><span>正在讀取法人與股價資料…</span></div> : data.error ? <div className={styles.drawerLoading}><CircleHelp size={28} /><span>{data.error}</span></div> : (
          <div className={styles.drawerContent}>
            <div className={styles.namedBadges}>
              {stock.theme && <span>{stock.theme}</span>}
              {detail.badges.map((badge) => <span key={badge}><Sparkles size={13} />{badge}</span>)}
            </div>

            <section className={styles.detailCard}>
              <header><div><h3>近 30 日股價走勢</h3><p>區間 {detail.chartCandles.length > 0 ? `${Math.min(...detail.chartCandles.map((candle) => candle.close)).toFixed(0)} – ${Math.max(...detail.chartCandles.map((candle) => candle.close)).toFixed(0)}` : '—'}　{formatPct(detail.periodChange)}</p></div><button className={styles.miniReplayButton} onClick={() => { if (!chartPlaying && data.chips.length > 0) setSelectedDate(data.chips[Math.max(0, data.chips.length - 30)].date); setChartPlaying((playing) => !playing); }} aria-label={chartPlaying ? '暫停股價回放' : '回放股價'}>{chartPlaying ? <Pause size={12} /> : <Play size={12} />} {chartPlaying ? '暫停' : '回放'}</button></header>
              <StockPriceChart candles={detail.chartCandles} averageCost={detail.averageCost} selectedDate={selectedDate} />
            </section>

            <section className={styles.stockSummary}>
              <div><small>當日漲跌</small><b>{detail.previousClose?.toFixed(2) ?? '—'} → {detail.selectedClose?.toFixed(2) ?? '—'}</b><strong className={detail.dailyChange >= 0 ? styles.up : styles.down}>{formatPct(detail.dailyChange)}</strong></div>
              <div><small>法人當日買賣超</small><b className={detail.latest.total >= 0 ? styles.up : styles.down}>{formatMoney(detail.latest.total * (detail.selectedClose ?? 0) * 1000)}</b></div>
              <div><small>近 5 日買賣超</small><b className={detail.sum5 >= 0 ? styles.up : styles.down}>{formatMoney(detail.sum5 * (detail.selectedClose ?? 0) * 1000)}</b></div>
              <div><small>近 20 日累計</small><b className={detail.sum20 >= 0 ? styles.up : styles.down}>{formatMoney(detail.sum20 * (detail.selectedClose ?? 0) * 1000)}</b></div>
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
              <header><div><h3>法人 20 日均價</h3><p>法人近 20 日買超日的加權平均價位</p></div><span className={styles.costBadge}>{detail.averageCost ? `$${detail.averageCost.toFixed(1)}` : '—'}</span></header>
            </section>

            <section className={styles.detailCard}>
              <header><div><h3>外資停留</h3><p>從所選日期往回連續買賣天數</p></div><strong className={detail.foreignDirection === '買超' ? styles.up : styles.down}>{detail.foreignDirection} {detail.foreignStreak} 天　{detail.intensity.toFixed(1)}× 力道</strong></header>
              <div className={styles.streakTrack}>{Array.from({ length: Math.min(20, Math.max(1, detail.foreignStreak)) }, (_, index) => <i key={index} className={detail.foreignDirection === '買超' ? styles.streakBuy : styles.streakSell} />)}</div>
            </section>

            <section className={styles.historyTable}>
              <h3>個股歷史回看</h3>
              <table><thead><tr><th>日期</th><th>外資</th><th>投信</th><th>自營</th><th>合計</th></tr></thead><tbody>{data.chips.slice(-20).reverse().map((row) => <tr key={row.date} className={row.date === selectedDate ? styles.selectedHistory : ''} onClick={() => setSelectedDate(row.date)}><td>{row.date.slice(5)}</td><td>{formatLots(row.foreign, false)}</td><td>{formatLots(row.trust, false)}</td><td>{formatLots(row.dealer, false)}</td><td className={row.total >= 0 ? styles.up : styles.down}>{formatLots(row.total, false)}</td></tr>)}</tbody></table>
            </section>
          </div>
        )}
        <div className={styles.drawerActions}>
          <button className={alerted ? styles.actionActive : ''} onClick={onAlert}><Bell size={15} />{alerted ? '提醒已開啟' : '籌碼提醒'}</button>
          <button className={watched ? styles.actionActive : ''} onClick={onWatch}>{watched ? <X size={15} /> : <Plus size={15} />}{watched ? '從自選移除' : '加入自選'}</button>
        </div>
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
  const candleIndex = Math.max(0, candles.findIndex((candle) => candle.date === selectedDate));
  const selectedClose = candleMap.get(selectedDate) ?? candles.at(-1)?.close ?? null;
  const previousClose = candles[Math.max(0, candleIndex - 1)]?.close ?? null;
  const dailyChange = selectedClose != null && previousClose ? (selectedClose / previousClose - 1) * 100 : 0;
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
  const chartCandles = candles.filter((candle) => candle.date <= selectedDate).slice(-30);
  const periodChange = chartCandles.length > 1 ? ((chartCandles.at(-1)?.close ?? 0) / chartCandles[0].close - 1) * 100 : 0;
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
    chartCandles,
    selectedClose,
    previousClose,
    dailyChange,
    periodChange,
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
  const maxVolume = Math.max(1, ...candles.map((candle) => candle.volume ?? 0));
  return (
    <svg className={styles.priceChart} viewBox="0 0 580 230" role="img" aria-label="近 30 日股價與成交量走勢">
      <defs><linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3e8f88" stopOpacity=".32" /><stop offset="1" stopColor="#3e8f88" stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3].map((line) => <line key={line} x1="24" x2="556" y1={35 + line * 40} y2={35 + line * 40} className={styles.priceGrid} />)}
      <path d={`${path} L ${x(candles.length - 1)} 165 L 24 165 Z`} fill="url(#price-fill)" />
      <path d={path} className={styles.pricePath} />
      {averageCost != null && <line x1="24" x2="556" y1={y(averageCost)} y2={y(averageCost)} className={styles.costLine} />}
      {selectedIndex >= 0 && <><line x1={x(selectedIndex)} x2={x(selectedIndex)} y1="25" y2="165" className={styles.selectedLine} /><circle cx={x(selectedIndex)} cy={y(candles[selectedIndex].close)} r="4" className={styles.selectedPoint} /></>}
      <text x="24" y="178" className={styles.chartText}>成交量（張）</text>
      {candles.map((candle, index) => <rect key={candle.date} x={x(index) - 4} y={218 - ((candle.volume ?? 0) / maxVolume) * 28} width="8" height={Math.max(2, ((candle.volume ?? 0) / maxVolume) * 28)} className={index > 0 && candle.close < candles[index - 1].close ? styles.volumeDown : styles.volumeUp} />)}
      <text x="24" y="229" className={styles.chartText}>{candles[0].date.slice(5)}</text><text x="556" y="229" textAnchor="end" className={styles.chartText}>{candles.at(-1)?.date.slice(5)}</text>
    </svg>
  );
}

function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`${styles.modal} ${wide ? styles.modalWide : ''}`} role="dialog" aria-modal="true" aria-label={title}>
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
    if (!needle) return [];
    return allStocks.filter((stock) => stock.code.includes(needle) || stock.name.toLowerCase().includes(needle)).slice(0, 10);
  }, [allStocks, query]);
  return (
    <div className={styles.alertSearchWrap}>
      <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="輸入代碼 / 名稱加入監控" aria-label="搜尋監控股票" /></label>
      <div className={styles.alertSearch}>
        {results.map((stock) => {
          const active = alerts.some((item) => item.code === stock.code);
          return <button key={stock.code} onClick={() => onToggle(stock)} className={active ? styles.alertActive : ''}><span>{stock.code} {stock.name}</span>{active ? <Check size={15} /> : <Plus size={15} />}</button>;
        })}
        {query.trim() && results.length === 0 && <p>找不到符合的股票</p>}
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
  if (alerts.length === 0) return <div className={styles.notificationEmpty}><Bell size={24} /><b>還沒有監控任何股票</b><p>先到「監控清單」加入，之後籌碼異動就會收進這裡。</p></div>;
  return (
    <div className={styles.notificationFeed}>
      <div className={styles.alertIntro}><Bell size={20} /><p>{date.slice(5).replace('-', '/')} 監控中；今天盤後若出現異常，會在這裡彙整。</p></div>
      {alerts.slice(0, 6).map((stock) => (
        <article key={stock.code}>
          <span><BellRing size={16} /></span>
          <div><b>{stock.code} {stock.name}</b><p>已加入監控，等待盤後籌碼異動結算。</p></div>
          <time>監控中</time>
        </article>
      ))}
    </div>
  );
}

function LoginModal({ onClose, onLogin }: { onClose: () => void; onLogin: () => void }) {
  return (
    <Modal title="歡迎登入" onClose={onClose}>
      <div className={styles.loginBody}>
        <p>登入後即可追蹤板塊動態<br />與法人資金流向</p>
        <button className={styles.googleButton} onClick={onLogin} title="使用本機示範帳號，不會連線或取得 Google 資料"><b>G</b> 使用 Google 登入</button>
        <Link href="/tide/pricing">查看免費版與 Pro 方案 →</Link>
        <small>本機重建版以示範帳號啟用，不會取得 Google 資料。</small>
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
