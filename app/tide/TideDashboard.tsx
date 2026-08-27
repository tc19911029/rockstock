'use client';

import {
  Bell,
  BellRing,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Gauge,
  Layers3,
  ListFilter,
  Moon,
  Pause,
  Play,
  Plus,
  Radar,
  RotateCcw,
  Search,
  Settings,
  Share2,
  ShieldCheck,
  Sparkles,
  Sun,
  TrendingDown,
  TrendingUp,
  UserRound,
  Waves,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
type ThemeMode = 'light' | 'dark';

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
  flood: { label: '漲潮', hint: '資金加速流入', color: '#e45b61' },
  rotation: { label: '輪動', hint: '資金流入但放緩', color: '#e7a33e' },
  watch: { label: '觀望', hint: '資金流出但放緩', color: '#4aa6a0' },
  ebb: { label: '退潮', hint: '資金加速流出', color: '#5d87c7' },
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
  const speed = (theme.avgD1 ?? 0) - (theme.avgD5 ?? 0) / 5;
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
  const [watchlist, setWatchlist] = useState<StockRef[]>([]);
  const [alerts, setAlerts] = useState<StockRef[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [highlightsOpen, setHighlightsOpen] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>('light');
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

  useEffect(() => {
    setWatchlist(readStoredStocks('tide-clone-watchlist'));
    setAlerts(readStoredStocks('tide-clone-alerts'));
    const storedTheme = localStorage.getItem('tide-clone-theme');
    if (storedTheme === 'dark' || storedTheme === 'light') setThemeMode(storedTheme);
  }, []);

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
    <main className={styles.app} data-theme={themeMode} id="main-content">
      <div className={styles.marketStrip}>
        <span>大盤 <b className={marketChange >= 0 ? styles.up : styles.down}>{formatPct(marketChange)}</b></span>
        <span className={styles.stripDivider}>｜</span>
        <span>資料日期 {dataDate || '—'}</span>
        <span className={styles.proPill}><ShieldCheck size={12} /> Pro 全功能</span>
        <span className={styles.updateNote}>盤後資料約 18:30 前更新</span>
      </div>

      <header className={styles.header}>
        <button className={styles.brand} onClick={() => setView('bubble')} aria-label="回到潮汐泡泡圖">
          <span className={styles.logoMark}><Waves size={20} /></span>
          <span><strong>Tide</strong><small>台股資金潮汐</small></span>
        </button>

        <div className={styles.sentiment} aria-label={`今日多方 ${bullishPct}%`}>
          <span>多 {bullishPct}%</span>
          <div><i style={{ width: `${bullishPct}%` }} /></div>
          <span>{100 - bullishPct}% 空</span>
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
          <button className={styles.iconButton} onClick={() => setAlertsOpen(true)} aria-label="籌碼異動提醒">
            <BellRing size={16} /><span className={styles.countBadge}>{alerts.length}</span>
          </button>
          <button className={styles.iconButton} onClick={() => navigator.clipboard?.writeText(location.href).then(() => setToast('連結已複製'))} aria-label="分享 Tide"><Share2 size={16} /></button>
          <button className={styles.iconButton} onClick={() => changeTheme(themeMode === 'light' ? 'dark' : 'light')} aria-label="切換明暗主題">
            {themeMode === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button className={styles.iconButton} onClick={() => setSettingsOpen(true)} aria-label="設定"><Settings size={16} /></button>
          <button className={styles.loginButton}><UserRound size={15} /> 登入</button>
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

      <section className={styles.categoryBar} aria-label="資金狀態篩選">
        {(Object.keys(CATEGORY_META) as Array<Exclude<FlowCategory, 'all'>>).map((key) => {
          const meta = CATEGORY_META[key];
          return (
            <button key={key} className={category === key ? styles.activeCategory : ''} onClick={() => setCategory(category === key ? 'all' : key)}>
              <span className={styles.categoryDot} style={{ background: meta.color }} />
              <b>{meta.label}</b><strong>{categoryCounts[key]}</strong><small>{meta.hint}</small>
            </button>
          );
        })}
      </section>

      <div className={styles.workspace}>
        <section className={styles.mainPanel}>
          <div className={styles.viewTabs} role="tablist" aria-label="分析功能">
            <button role="tab" aria-selected={view === 'bubble'} onClick={() => setView('bubble')}><Layers3 size={15} /> 板塊泡泡圖</button>
            <button role="tab" aria-selected={view === 'ranking'} onClick={() => setView('ranking')}><ListFilter size={15} /> 完整籌碼排行</button>
            <button role="tab" aria-selected={view === 'dual'} onClick={() => setView('dual')}><TrendingUp size={15} /> 外資投信同買賣</button>
            <button role="tab" aria-selected={view === 'streak'} onClick={() => setView('streak')}><Clock3 size={15} /> 外資連買賣</button>
            <button role="tab" aria-selected={view === 'radar'} onClick={() => setView('radar')}><Radar size={15} /> 籌碼雷達</button>
          </div>

          {view === 'bubble' && (
            <BubbleView
              themes={filteredThemes}
              totalCount={themes.length}
              period={period}
              setPeriod={setPeriod}
              showAll={showAll}
              setShowAll={setShowAll}
              replayOpen={replayOpen}
              setReplayOpen={(value) => {
                if (value) setReplayIndex(0);
                setReplayPlaying(false);
                setReplayOpen(value);
              }}
              onSelectStock={setSelected}
              onSelectTheme={(theme) => {
                const stock = theme.topStock ?? theme.members[0];
                if (stock) setSelected({ code: stock.code, name: stock.name, theme: theme.theme });
              }}
            />
          )}

          {view === 'ranking' && <RankingView themes={themes} period={period} setPeriod={setPeriod} onSelect={setSelected} />}
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

        <aside className={styles.watchPanel}>
          <div className={styles.watchHeader}>
            <div><span>觀察清單</span><small>{watchlist.length} 檔</small></div>
            <button onClick={() => { const first = searchResults[0] ?? allStocks[0]; if (first) addWatch(first); }}><Plus size={14} /> 添加</button>
          </div>
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
        <span>本頁為獨立重建介面，非 tide-tw.app 官方服務；僅做資訊整理，不構成投資建議。</span>
      </footer>

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
        <Modal title="設定" onClose={() => setSettingsOpen(false)}>
          <div className={styles.settingsBody}>
            <label>畫面主題</label>
            <div className={styles.optionButtons}>
              <button className={themeMode === 'light' ? styles.selectedOption : ''} onClick={() => changeTheme('light')}><Sun size={16} /> 亮色</button>
              <button className={themeMode === 'dark' ? styles.selectedOption : ''} onClick={() => changeTheme('dark')}><Moon size={16} /> 暗色</button>
            </div>
            <label>Pro 功能狀態</label>
            <div className={styles.proStatus}><Check size={16} /><span><b>全部啟用</b><small>法人分項、歷史回看、雷達與不限檔監控</small></span></div>
            <label>圖表說明</label>
            <p>越右代表法人買越多，越上代表資金速度加快，圓圈越大代表資金規模越大。顏色同上方四種潮汐狀態。</p>
          </div>
        </Modal>
      )}

      {alertsOpen && (
        <Modal title="籌碼異動提醒" onClose={() => setAlertsOpen(false)} wide>
          <div className={styles.alertBody}>
            <div className={styles.alertIntro}><BellRing size={20} /><p>監控異常大買／大賣、法人連買連賣與土洋同買／對作。Pro 清單不限檔數。</p></div>
            <div className={styles.alertSearch}>
              {allStocks.slice(0, 8).map((stock) => {
                const active = alerts.some((item) => item.code === stock.code);
                return <button key={stock.code} onClick={() => toggleAlert(stock)} className={active ? styles.alertActive : ''}><span>{stock.code} {stock.name}</span>{active ? <Check size={15} /> : <Plus size={15} />}</button>;
              })}
            </div>
            <h3>監控清單</h3>
            {alerts.length === 0 ? <p className={styles.emptyText}>尚未加入監控股票。</p> : alerts.map((stock) => (
              <div key={stock.code} className={styles.alertRow}><span><b>{stock.code}</b> {stock.name}</span><small>異常力道・連買賣・具名徽章</small><button onClick={() => toggleAlert(stock)} aria-label={`移除 ${stock.name}`}><X size={15} /></button></div>
            ))}
          </div>
        </Modal>
      )}

      {toast && <div className={styles.toast}><Check size={15} /> {toast}</div>}
    </main>
  );
}

function BubbleView({
  themes,
  totalCount,
  period,
  setPeriod,
  showAll,
  setShowAll,
  replayOpen,
  setReplayOpen,
  onSelectTheme,
}: {
  themes: ThemeRank[];
  totalCount: number;
  period: Period;
  setPeriod: (period: Period) => void;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  replayOpen: boolean;
  setReplayOpen: (value: boolean) => void;
  onSelectStock: (stock: StockRef) => void;
  onSelectTheme: (theme: ThemeRank) => void;
}) {
  const points = useMemo(() => {
    const raw = themes.map((theme) => ({
      theme,
      x: signedLog(themeMoney(theme, period)),
      y: (theme.avgD1 ?? 0) - (theme.avgD5 ?? 0) / 5,
      size: Math.log10(1 + Math.abs(themeMoney(theme, 20)) / 100_000_000),
    }));
    const maxX = Math.max(1, ...raw.map((item) => Math.abs(item.x)));
    const maxY = Math.max(1, ...raw.map((item) => Math.abs(item.y)));
    const maxSize = Math.max(1, ...raw.map((item) => item.size));
    return raw.map((item) => ({
      ...item,
      // 固定 SVG 座標精度，避免 Node 與瀏覽器浮點字串最後一位不同造成 hydration mismatch。
      cx: Number((500 + (item.x / maxX) * 410).toFixed(3)),
      cy: Number((260 - (item.y / maxY) * 195).toFixed(3)),
      radius: Number((18 + (item.size / maxSize) * 32).toFixed(3)),
    }));
  }, [period, themes]);

  return (
    <div className={styles.bubbleView}>
      <div className={styles.panelToolbar}>
        <div>
          <b>板塊泡泡圖</b>
          <span>越右＝法人買越多・越上＝買的速度加快・圈越大＝近 20 日金額越大</span>
        </div>
        <div className={styles.toolbarControls}>
          <div className={styles.segmented} aria-label="法人資金週期">
            {([1, 5, 20] as Period[]).map((value) => <button key={value} className={period === value ? styles.segmentActive : ''} onClick={() => setPeriod(value)}>{value} 日</button>)}
          </div>
          <button onClick={() => setShowAll(!showAll)}>{showAll ? '精簡顯示' : `顯示全部 ${totalCount} 個`}</button>
          <button className={replayOpen ? styles.toolbarActive : ''} onClick={() => setReplayOpen(!replayOpen)}><Play size={14} /> 回放</button>
          <button aria-label="泡泡圖說明" title="越右法人買越多、越上資金加速、圈越大代表規模"><CircleHelp size={15} /></button>
        </div>
      </div>
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
          <rect x="55" y="35" width="890" height="445" rx="12" fill="url(#tide-grid)" className={styles.chartBg} />
          <line x1="500" y1="35" x2="500" y2="480" className={styles.axisLine} />
          <line x1="55" y1="260" x2="945" y2="260" className={styles.axisLine} />
          <text x="500" y="510" textAnchor="middle" className={styles.axisLabel}>← 法人資金流出　　近 {period} 日資金方向　　法人資金流入 →</text>
          <text x="22" y="260" textAnchor="middle" transform="rotate(-90 22 260)" className={styles.axisLabel}>資金速度　放緩 ←　→ 加速</text>
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
                <circle r={point.radius} fill={color} filter="url(#bubble-shadow)" />
                <circle r={Math.max(5, point.radius - 5)} fill="none" stroke="rgba(255,255,255,.32)" strokeWidth="1" />
                <text textAnchor="middle" y={-3} className={styles.bubbleName}>{point.theme.theme}</text>
                <text textAnchor="middle" y={14} className={styles.bubbleValue}>{formatMoney(themeMoney(point.theme, period))}</text>
                <title>{`${point.theme.theme}｜法人 ${formatMoney(themeMoney(point.theme, period))}｜漲跌 ${formatPct(themeReturn(point.theme, period))}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className={styles.chartLegend}>
        {(Object.keys(CATEGORY_META) as Array<Exclude<FlowCategory, 'all'>>).map((key) => <span key={key}><i style={{ background: CATEGORY_META[key].color }} />{CATEGORY_META[key].label}</span>)}
        <small>點選泡泡可查看該板塊主力個股的 Pro 籌碼明細</small>
      </div>
    </div>
  );
}

function RankingView({ themes, period, setPeriod, onSelect }: { themes: ThemeRank[]; period: Period; setPeriod: (period: Period) => void; onSelect: (stock: StockRef) => void }) {
  const rows = useMemo(() => {
    const stocks = new Map<string, { stock: StockRef; value: number; d1: number | null; theme: string }>();
    for (const theme of themes) {
      for (const member of theme.members) {
        const value = member.instAmt?.[PERIOD_INDEX[period]] ?? 0;
        const current = stocks.get(member.code);
        if (!current || Math.abs(value) > Math.abs(current.value)) stocks.set(member.code, { stock: { code: member.code, name: member.name, theme: theme.theme }, value, d1: member.d1, theme: theme.theme });
      }
    }
    return [...stocks.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 60);
  }, [period, themes]);
  return (
    <DataSection title="完整籌碼排行" subtitle="不截斷榜單；依法人買賣超金額絕對值排序。">
      <div className={styles.tableToolbar}>
        <div className={styles.segmented}>{([1, 5, 20] as Period[]).map((value) => <button key={value} className={period === value ? styles.segmentActive : ''} onClick={() => setPeriod(value)}>{value} 日</button>)}</div>
        <span>共 {rows.length} 檔</span>
      </div>
      <div className={styles.dataTableWrap}>
        <table className={styles.dataTable}>
          <thead><tr><th>排名</th><th>股票</th><th>主要板塊</th><th>今日漲跌</th><th>法人金額</th><th>方向</th></tr></thead>
          <tbody>{rows.map((row, index) => (
            <tr key={row.stock.code} onClick={() => onSelect(row.stock)}>
              <td>{index + 1}</td><td><b>{row.stock.code}</b> {row.stock.name}</td><td>{row.theme}</td>
              <td className={(row.d1 ?? 0) >= 0 ? styles.up : styles.down}>{formatPct(row.d1)}</td>
              <td className={row.value >= 0 ? styles.up : styles.down}>{formatMoney(row.value, false)}</td>
              <td><span className={row.value >= 0 ? styles.buyChip : styles.sellChip}>{row.value >= 0 ? '買超' : '賣超'}</span></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </DataSection>
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
  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`${styles.modal} ${wide ? styles.modalWide : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button onClick={onClose} aria-label={`關閉${title}`}><X size={18} /></button></header>
        {children}
      </section>
    </div>
  );
}
