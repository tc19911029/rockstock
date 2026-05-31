'use client';

/**
 * V2 走圖頁 — 乾淨版
 *
 * 左側：K 線圖（大）+ 播放控制
 * 右側：2 個 tab（條件 / 訊號）
 *
 * 移除的東西：
 * - OHLCV bar 的 MA/BB/指標切換按鈕 → 預設全開
 * - 籌碼 tab → 移到掃描頁
 * - 問老師 tab → 移除
 * - 底部回測面板 → 移到掃描頁
 * - 趨勢狀態欄 → 整合進條件 tab
 */

import { Suspense, useEffect, useCallback, useState, useRef, useMemo } from 'react';
import nextDynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useReplayStore } from '@/store/replayStore';
import { findBuyPoints, prevBuyPointIndex, nextBuyPointIndex } from '@/lib/analysis/findBuyPoints';
import { detectTrend } from '@/lib/analysis/trendAnalysis';
import StockSelector from '@/components/StockSelector';
import { PageShell, EmptyState, BackButton, StockChartView } from '@/components/shared';
import { DecisionPanel } from '@/components/decision/DecisionPanel';
import { TodayBriefing } from '@/components/today/TodayBriefing';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import SignalSummaryCard from '@/components/SignalSummaryCard';
import { useV12HistoricalMarkers } from '@/lib/hooks/useV12HistoricalMarkers';
import { useBlowoffMarkers } from '@/lib/hooks/useBlowoffMarkers';
import { useLockedPattern } from '@/lib/hooks/useLockedPattern';
import SixConditionsPanel from '@/components/SixConditionsPanel';
import BuyMethodConditionsPanel from '@/components/BuyMethodConditionsPanel';
import { SanSeConditionsPanel } from '@/components/cn-sanse/SanSeConditionsPanel';
import { SanSeSignalsPanel } from '@/components/cn-sanse/SanSeSignalsPanel';
import type { ConditionReport } from '@/lib/cn-sanse/conditions';
import ChipDetailPanel from '@/components/ChipDetailPanel';
import { FundamentalSidebarPanel } from '@/components/FundamentalSidebarPanel';
import CnChipPanel from '@/components/cn/CnChipPanel';
import CnFundamentalPanel from '@/components/cn/CnFundamentalPanel';
import { ErrorBoundary, SectionBoundary } from '@/components/ErrorBoundary';
import BottomPanel from '@/components/BottomPanel';
import { ScanPanelVertical } from '@/features/scan';
import { DataHealthBadge } from '@/features/scan/components/DataHealthBadge';
import type { SelectedStock } from '@/features/scan';
import type { SanSeChartPayload } from '@/components/cn-sanse/SanSeChart';
import { YoutubeStocksPanel } from '@/components/youtube/YoutubeStocksPanel';
import { CandidatesPoolPanel } from '@/components/CandidatesPoolPanel';
import { FundamentalRevaluationPanel } from '@/components/FundamentalRevaluationPanel';
import { MultiAgentTopPanel } from '@/components/MultiAgentTopPanel';
import { lastBusinessDayYmd } from '@/lib/dateDefaults';
import { getABCDisplayStructure } from '@/lib/analysis/abcBreakoutEntry';
import { useBacktestStore } from '@/store/backtestStore';
import { useSettingsStore } from '@/store/settingsStore';
import { ChevronDown, Search } from 'lucide-react';
import { toast } from 'sonner';
import ChartToolbar from '@/components/ChartToolbar';

// Mobile fullscreen 仍直接使用 CandleChart / IndicatorCharts（StockChartView 抽出範圍只到 desktop 主視窗）
const CandleChart = nextDynamic(() => import('@/components/CandleChart'), {
  ssr: false,
  loading: () => (
    <div className="w-full bg-card flex items-center justify-center" style={{ height: 460 }}>
      <span className="text-muted-foreground text-sm animate-pulse">載入K線圖中...</span>
    </div>
  ),
});

const IndicatorCharts = nextDynamic(() => import('@/components/IndicatorCharts'), { ssr: false });

type SideTab = 'conditions' | 'signals' | 'chip' | 'fundamental';

/** 根據 activeBuyMethod 切換渲染：A 走六條件，其他走買法條件面板。
 *  v11 G/H/I 自動轉 v12 J/L/K（用戶 0512 決議只留 v12） */
function ConditionsPanelSwitch() {
  const method = useBacktestStore(s => s.activeBuyMethod);
  if (method === 'A') return <SixConditionsPanel />;
  // R 機械軌純排名，無 detector 條件可顯示 — 簡單說明即可
  if (method === 'R') {
    return (
      <div className="p-3 text-[11px] text-muted-foreground space-y-1">
        <div className="font-semibold text-cyan-300/80">機械軌（R · 乖離率）</div>
        <div>純排名策略，不過六條件、不過戒律、不過 Step 0 大盤過濾。</div>
        <div>做多取成交額前 500 中 MA20 乖離率最負 top 10；做空取最正 top 10。</div>
      </div>
    );
  }
  const v12Method = method === 'G' ? 'J' : method === 'H' ? 'L' : method === 'I' ? 'K' : method;
  return <BuyMethodConditionsPanel method={v12Method} />;
}

// Next 16 client component + useSearchParams 需 Suspense 包(否則 build 失敗)
// dev mode 可能出現 hydration mismatch(Recoverable Error),不擋使用 — Next 16 quirk
export default function HomePageWrapper() {
  return <Suspense fallback={null}><HomePage /></Suspense>;
}

function HomePage() {
  const {
    initData, visibleCandles, currentSignals, chartMarkers,
    isLoadingStock, allCandles, currentIndex, dataGaps,
    nextCandle, prevCandle, isPlaying, startPlay, stopPlay, metrics,
    loadStock, currentStock, currentInterval,
    signalStrengthMin, setSignalStrengthMin,
    resetReplay, targetDate,
  } = useReplayStore();

  // v12 歷史 markers（M/N/O/P/Q/F）— 在現有 chartMarkers 之上疊加
  const v12Markers = useV12HistoricalMarkers(allCandles, currentStock?.ticker ?? '', true);
  // 分鐘級 K 才會跑 blowoff 偵測（爆量長黑/長紅/末升段/MA5 跌破）
  const blowoffMarkers = useBlowoffMarkers(
    allCandles,
    currentStock?.ticker,
    currentInterval,
    metrics.shares > 0,
  );
  // chartMarkers + v12Markers 由「訊號」toggle 控制；blowoff 在分鐘 K 永遠顯示
  // 因為爆量長黑/末升段是即時警示，不能藏在 toggle 後面（朱書精神：見高就警覺）
  const mergedMarkers = useMemo(
    () => [...chartMarkers, ...v12Markers],
    [chartMarkers, v12Markers],
  );

  // 買點索引（對齊生產掃描規則：六條件+戒律+淘汰法）
  const buyPointIndices = useMemo(
    () => (allCandles.length > 60 ? findBuyPoints(allCandles) : []),
    [allCandles]
  );
  const jumpToBuyPoint = useCallback((direction: 'prev' | 'next') => {
    const finder = direction === 'prev' ? prevBuyPointIndex : nextBuyPointIndex;
    const target = finder(buyPointIndices, currentIndex);
    if (target != null) useReplayStore.getState().jumpToIndex(target);
  }, [buyPointIndices, currentIndex]);
  const canPrevBuyPoint = buyPointIndices.length > 0 && buyPointIndices[0] < currentIndex;
  const canNextBuyPoint = buyPointIndices.length > 0 && buyPointIndices[buyPointIndices.length - 1] > currentIndex;

  const currentTrend = useMemo(
    () => allCandles.length > 0 && currentIndex >= 20 ? detectTrend(allCandles, currentIndex) : null,
    [allCandles, currentIndex],
  );

  // 鎖股觀察紀錄 → 走圖型態 chip 穩定來源（hooks/useLockedPattern）
  const { lockedPattern } = useLockedPattern(currentStock?.ticker);

  useEffect(() => { initData(); }, [initData]);

  // 大盤指數預設：TW→加權指數 ^TWII，CN→上證指數 000001.SS
  const market = useBacktestStore(s => s.market);
  const scanDate = useBacktestStore(s => s.scanDate);
  const getMarketIndex = useCallback(
    (m: 'TW' | 'CN'): { symbol: string; name: string } => m === 'TW'
      ? { symbol: '^TWII', name: '加權指數' }
      : { symbol: '000001.SS', name: '上證指數' },
    [],
  );

  // Handle ?load=SYMBOL&date=YYYY-MM-DD&tab=...&tf=...
  // 用 useSearchParams 監聽 URL 變化（Link 點擊 / router.replace 都會 trigger）
  // 用 lastLoadedRef 防止重複 load 同一檔（避免 hydration race + market-change race）
  const [loadError, setLoadError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const lastLoadedRef = useRef<string>('');
  useEffect(() => {
    const sym = searchParams.get('load') ?? searchParams.get('symbol');
    const date = searchParams.get('date');
    const urlTab = searchParams.get('tab');
    const tfParam = searchParams.get('tf');
    if (urlTab === 'youtube' || urlTab === 'scan' || urlTab === 'fundamental' || urlTab === 'pool' || urlTab === 'agent') {
      setRightTab(urlTab);
      // 套用後立刻把 ?tab= 從 URL 拿掉 — inbound link 進來會切 tab,但 reload 不會再套用,維持 default scan
      // 保留其他 query param(?load / ?date / ?tf)
      const sp = new URLSearchParams(window.location.search);
      sp.delete('tab');
      const qs = sp.toString();
      const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      window.history.replaceState(null, '', newUrl);
    }
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setTabDate(date);
    }
    const validTfs = ['1m', '5m', '15m', '30m', '60m', '1d', '1wk', '1mo'];
    const tf = tfParam && validTfs.includes(tfParam) ? tfParam : '1d';
    if (sym) {
      // dedup：同 sym+tf+date 不重 load（避免 searchParams 變化但內容相同）
      const key = `${sym}|${tf}|${date ?? ''}`;
      if (lastLoadedRef.current === key) return;
      lastLoadedRef.current = key;
      loadStock(sym, tf, undefined, date ?? undefined)
        .then(() => setLoadError(null)) // 成功載入 → 清掉先前冷啟動 race 的失敗 banner
        .catch((e: Error) => {
          const msg = `載入 ${sym} 失敗：${e.message || '請稍後再試'}`;
          setLoadError(msg);
          toast.error(msg);
        });
    } else if (lastLoadedRef.current === '') {
      // 首次 mount 沒帶 ?load → 載大盤指數（覆蓋 initData 的 DEMO 範例）
      lastLoadedRef.current = `_market_${market}`;
      loadStock(getMarketIndex(market).symbol, '1d', '2y').catch(() => {});
    }
  }, [searchParams, loadStock, getMarketIndex, market]);

  // 切換市場時自動切到該市場大盤指數
  // 用 ref 鎖住「上一次的 market」，hydration 把 market 從 'TW' 改成 'CN' 也會 trigger（這正是我們想要的）
  const lastMarketRef = useRef<'TW' | 'CN'>(market);
  useEffect(() => {
    if (lastMarketRef.current === market) return;
    lastMarketRef.current = market;
    const { symbol } = getMarketIndex(market);
    loadStock(symbol, '1d', '2y').catch(() => {});
  }, [market, loadStock, getMarketIndex]);

  // P1-2: remember last tab per interval (declared before handleKey to avoid TDZ errors)
  const [sideTabPerInterval, setSideTabPerInterval] = useState<Record<string, SideTab>>({});
  const sideTab: SideTab = sideTabPerInterval[currentInterval] ?? 'conditions';
  const setSideTab = useCallback(
    (tab: SideTab) => setSideTabPerInterval(prev => ({ ...prev, [currentInterval]: tab })),
    [currentInterval],
  );
  // 副圖（成交量/KD/MACD/籌碼）預設展開：成交量是書本核心訊息（量1.5×/過大量黑K），不該被視窗寬度藏起來
  const [showIndicators, setShowIndicators] = useState(true);
  // 三色資金圖層（陸股）：雙B戰法疊主圖（像 BB）；主力狀態/捕撈季節是副圖（像 MACD/KD）
  const [showShuangB, setShowShuangB] = useState(false);
  // P1-5: keyboard shortcut help overlay
  const [showHelp, setShowHelp] = useState(false);
  // Scanner bottom panel — v12 預設展開讓用戶一進來就看到新功能（14 字母 tabs/Step 0 banner/LockWatch panel/警示徽章）
  const [scannerOpen, setScannerOpen] = useState(true);
  // Stage 7-10：右側 panel tab — 策略掃描 / YouTube 提及 / 候選池 / Multi-Agent
  type RightTab = 'scan' | 'youtube' | 'fundamental' | 'pool' | 'agent';
  const [rightTab, setRightTab] = useState<RightTab>('scan');
  // Stage 16：3 tab 共用 date state（YouTube / Pool / Multi-Agent 都看同一天）
  // 預設「最近工作日」，因為 today 的資料通常還沒跑完
  // （user 仍可手動切日期；URL ?date= 也會 override）
  const [tabDate, setTabDate] = useState(lastBusinessDayYmd);
  // YouTube tab 內點股票 → loadStock + 跳左側 K 線（mobile inline 切全螢幕，避免 hoisting）
  const handleYoutubeSelectStock = useCallback((code: string) => {
    setLoadError(null);
    // YouTube source 都是 TW 股，補 .TW suffix
    const symbol = /\.(TW|TWO|SS|SZ)$/i.test(code) ? code : `${code}.TW`;
    loadStock(symbol, '1d', '2y', tabDate).catch((e: Error) => {
      toast.error(`載入 ${code} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileChartFullscreen(true);
      setScannerOpen(false);
      try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
    }
  }, [loadStock, tabDate]);

  // Pool tab / Multi-Agent tab 點股票 → loadStock（symbol 已是 2330.TW 格式，不必補 suffix）
  // 帶 tabDate 讓 K 線停在當天，user 看的是「該日的條件分析」而非總是最新
  const handlePoolSelectStock = useCallback((symbol: string) => {
    setLoadError(null);
    loadStock(symbol, '1d', '2y', tabDate).catch((e: Error) => {
      toast.error(`載入 ${symbol} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileChartFullscreen(true);
      setScannerOpen(false);
      try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
    }
  }, [loadStock, tabDate]);
  // Multi-Agent tab 共用 Pool 的 callback（symbol 格式相同）
  const handleAgentSelectStock = handlePoolSelectStock;
  // 手機點「走圖」→ 全螢幕 K 線視圖
  const [mobileChartFullscreen, setMobileChartFullscreen] = useState(false);
  const openMobileChart = useCallback(() => {
    setMobileChartFullscreen(true);
    setScannerOpen(false);
    try { window.history.pushState({ chartFullscreen: true }, ''); } catch { /* noop */ }
  }, []);
  const closeMobileChart = useCallback(() => {
    setMobileChartFullscreen(false);
    setScannerOpen(true);
  }, []);
  useEffect(() => {
    if (!mobileChartFullscreen) return;
    const onPop = () => setMobileChartFullscreen(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [mobileChartFullscreen]);

  // Keyboard: ← → Space B S Q
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
    if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); jumpToBuyPoint('next'); }
    else if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); jumpToBuyPoint('prev'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextCandle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevCandle(); }
    else if (e.key === ' ') { e.preventDefault(); if (isPlaying) stopPlay(); else startPlay(); }
    // P2-3: tab switching
    else if (e.key === '1') { e.preventDefault(); setSideTab('conditions'); }
    else if (e.key === '2') { e.preventDefault(); setSideTab('signals'); }
    else if (e.key === '3') { e.preventDefault(); setSideTab('chip'); }
    else if (e.key === '4') { e.preventDefault(); setSideTab('fundamental'); }
    else if (e.key === '5') { e.preventDefault(); setScannerOpen(true); }
    // P2-3: indicator toggle
    else if (e.key === 'i' || e.key === 'I') { e.preventDefault(); setShowIndicators(v => !v); }
    // P1-5: help overlay
    else if (e.key === '?') { e.preventDefault(); setShowHelp(h => !h); }
    // 買賣快捷鍵
    else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      useReplayStore.getState().buyPercent(100);
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      useReplayStore.getState().sellPercent(50);
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      const { metrics } = useReplayStore.getState();
      if (metrics.shares > 0) useReplayStore.getState().sell(metrics.shares);
    }
  }, [nextCandle, prevCandle, isPlaying, startPlay, stopPlay, setSideTab, setScannerOpen, setShowIndicators, setShowHelp, jumpToBuyPoint]);

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  const [hoverCandle, setHoverCandle] = useState<typeof allCandles[0] | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(false);  // 訊號 markers 預設關（M/N/O/P/Q/F 歷史觸發日）— 用戶偏好
  const [showPivots, setShowPivots] = useState(true);     // 頭底標記預設開 — 用戶偏好
  const [showSupportResistance, setShowSupportResistance] = useState(false);
  const [showAscendingTrendline, setShowAscendingTrendline] = useState(false);
  const [showDescendingTrendline, setShowDescendingTrendline] = useState(false);
  const [showAscendingChannel, setShowAscendingChannel] = useState(false);
  const [showDescendingChannel, setShowDescendingChannel] = useState(false);
  const [showConsolidationLines, setShowConsolidationLines] = useState(false);
  const [showNeckline, setShowNeckline] = useState(false);  // 形態頸線 + 目標價 + 結構失效價
  const [showPattern, setShowPattern] = useState(false);    // 形態 ABCDE 關鍵點與連線
  const [maToggles, setMaToggles] = useState({ ma5: true, ma10: true, ma20: true, ma60: true, ma240: false });
  const [showBollinger, setShowBollinger] = useState(false);
  const [indicators, setIndicators] = useState({
    macd: true, kd: true, volume: true, rsi: false,
    foreign: false, trust: false, dealer: false, retail: false,
    h400: false, h1000: false,
    cnMain: false, cnRetail: false,
    mainForce: false, season: false, // 三色資金副圖（陸股）：主力狀態F / 捕撈季節
  });
  // ── 籌碼面資料（TW 法人/大戶 + CN 主力資金） ────────────────────────────────
  // 優化：用 ticker + 「是否需要籌碼」字串 key 當依賴；同一 key 不會 refetch
  const anyTwChipOn = indicators.foreign || indicators.trust || indicators.dealer
    || indicators.retail || indicators.h400 || indicators.h1000;
  const anyCnChipOn = indicators.cnMain || indicators.cnRetail;
  const ticker = currentStock?.ticker ?? '';
  const isTwTicker = /\.(TW|TWO)$/i.test(ticker) || /^\d{4,5}$/.test(ticker);
  const isCnTicker = /\.(SS|SZ)$/i.test(ticker) || /^\d{6}$/.test(ticker);
  // 三色資金（雙B/主力/捕撈）台股+陸股皆可；^TWII 加權指數比照陸股 000001.SS 也可（指數三色為退化值但版面一致）
  const sanseEnabled = isCnTicker || isTwTicker || ticker === '^TWII';
  // 中間「條件/訊號」面板跟著掃描面板選的策略換：
  //   三色 level（CN 自創策略）被選中 → 顯示三色面板；否則 → 書本買法面板（含陸股）。
  // sanseLevel 為單一事實來源（store），由掃描面板「三色(嚴格/中等/寬鬆)」按鈕設定、選任何書本買法時自動清空。
  const sanseLevel = useBacktestStore(s => s.sanseLevel);
  // 三色模式（台股+陸股）：選了 level 且當前股票屬三色可用市場 → 中間條件/訊號改顯示 SanSe 面板
  const showSanseView = sanseEnabled && sanseLevel != null;
  const wantChips = (isTwTicker && anyTwChipOn) || (isCnTicker && anyCnChipOn);
  // 把 fetch trigger 編成單一 string key，dep 比較穩定
  const chipFetchKey = wantChips ? ticker : '';
  const [chips, setChips] = useState<{
    inst: Array<{ date: string; foreign: number; trust: number; dealer: number; total: number }>;
    tdcc: Array<{ date: string; holder400Pct: number; holder1000Pct: number; holderCount?: number }>;
    cnFlow?: Array<{ date: string; mainNet: number; superLargeNet: number; largeNet: number; mediumNet: number; smallNet: number }>;
    divergence?: { type: 'bullish' | 'bearish'; priceChangePct: number; volumeChangePct: number; strength: 0|1|2|3; detail: string } | null;
  } | null>(null);
  const [chipsLoading, setChipsLoading] = useState(false);
  useEffect(() => {
    if (!chipFetchKey) { return; }
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 載入 flag，搭配下方 finally 清除
    setChipsLoading(true);
    fetch(`/api/stock/chips?symbol=${encodeURIComponent(chipFetchKey)}&days=180`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(json => {
        if (json.ok) setChips({
          inst: json.inst ?? [],
          tdcc: json.tdcc ?? [],
          cnFlow: json.cnFlow ?? [],
          divergence: json.divergence ?? null,
        });
      })
      .catch(err => { if (err.name !== 'AbortError') console.warn('[chips] load failed:', err); })
      .finally(() => setChipsLoading(false));
    return () => ctrl.abort();
  }, [chipFetchKey]);
  // 切到別的股 / 關掉所有 chip toggle → 清空 chips（不在主 effect 內，避免抖動）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 切股時清舊 chips
    if (!ticker) setChips(null);
  }, [ticker]);

  // ── 三色資金圖層資料（雙B疊加 + 主力狀態/捕撈季節副圖 + 條件報告）──────────────
  // 陸股走 /cn-sanse、台股走 /tw-sanse（同一份 SanSeChartPayload 形狀）：圖層由各 toggle 控制。
  // conditions 兩市場都寫（三色模式時中間條件/訊號 tab 用，由 showSanseView 控制）。
  // 走圖步進：日K 時帶 asOf=當前可見最後一根日期 → 標記/條件/訊號跟著步進的位置重算（練習器核心）。
  const sanseAsOf = sanseEnabled && currentInterval === '1d' && visibleCandles.length
    ? visibleCandles[visibleCandles.length - 1].date
    : '';
  const sanseFetchKey = sanseEnabled ? `${ticker}@${sanseAsOf}` : '';
  const [sanse, setSanse] = useState<SanSeChartPayload | null>(null);
  const [sanseConditions, setSanseConditions] = useState<ConditionReport | null>(null);
  useEffect(() => {
    if (!sanseEnabled || !ticker) { setSanse(null); setSanseConditions(null); return; }
    const ctrl = new AbortController();
    const base = isCnTicker ? '/api/cn-sanse/chart' : '/api/tw-sanse/chart';
    const url = `${base}/${encodeURIComponent(ticker)}${sanseAsOf ? `?asOf=${sanseAsOf}` : ''}`;
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(j => {
        if (j.ok && j.chart) setSanse(j.chart as SanSeChartPayload);
        // 條件報告兩市場都寫（三色模式時中間條件/訊號 tab 用）
        if (j.ok && j.conditions) setSanseConditions(j.conditions as ConditionReport);
        else setSanseConditions(null);
      })
      .catch(err => { if (err.name !== 'AbortError') console.warn('[sanse] load failed:', err); });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sanseFetchKey]);

  const handleScanSelectStock = useCallback((stock: SelectedStock) => {
    // 點卡片時同步掃描面板市場（避免 market=CN 卻點到 TW 卡片 → 面板/下一次三色 fetch 仍停在 CN）
    if (stock.market && useBacktestStore.getState().market !== stock.market) {
      useBacktestStore.getState().setMarket(stock.market);
    }
    // 優先用該股自帶的掃描日（三色資金帶 cn-sanse 固化日），否則回退書本掃描日 → K 線停在掃描日而非最新
    const fallbackDate = useBacktestStore.getState().scanDate;
    const date = stock.date ?? fallbackDate ?? undefined;
    setLoadError(null);
    // 點三色資金結果 → 自動打開雙B疊加（主圖直接看到雙B線與買賣點）；走圖仍是原本主圖
    if (stock.chartTab === 'shuangb') setShowShuangB(true);
    loadStock(stock.symbol, '1d', '2y', date).catch((e: Error) => {
      toast.error(`載入 ${stock.name} 失敗：${e.message || '請稍後再試'}`);
    });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      openMobileChart();
    }
  }, [loadStock, openMobileChart]);

  // 切換走圖週期（1m/5m/.../1d/1wk/1mo）— ChartToolbar timeframe pills 點擊
  // 重抓會自動 stop/start polling（loadStock 內部會處理），呼叫端不必處理
  const handleIntervalChange = useCallback((newInterval: string) => {
    if (!currentStock) return;
    if (newInterval === currentInterval) return;
    // 去 suffix（store loadStock 內部會自動處理 suffix）
    const symbol = currentStock.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    setLoadError(null);
    useReplayStore.getState().stopPolling();
    loadStock(symbol, newInterval, undefined, targetDate ?? undefined)
      .then(() => useReplayStore.getState().startPolling())
      .catch((e: Error) => {
        toast.error(`切換 ${newInterval} 失敗：${e.message || '請稍後再試'}`);
      });
  }, [currentStock, currentInterval, targetDate, loadStock]);

  // P1-5: 可拖拽分隔條 — K 線圖 vs 副圖指標
  // 預設 0.55（主圖 55% / 副圖 45%，副圖整區較高）；mount 後再從 localStorage 讀取，避免 SSR hydration mismatch
  // key 升 v2：舊的 'chartSplit'（多為 0.65）忽略，讓新預設生效；之後拖曳會寫進 v2
  const [chartSplit, setChartSplit] = useState(0.55);
  useEffect(() => {
    const saved = localStorage.getItem('chartSplit-v2');
    // 接受拖曳範圍內的值（0.2~0.85）；太極端才回新預設
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && parseFloat(saved) >= 0.2 && parseFloat(saved) <= 0.85) setChartSplit(parseFloat(saved));
    else localStorage.removeItem('chartSplit-v2');
  }, []);
  // chartSplit 持久化：mouseup 才寫，避免每次拖動 100+ 次寫盤
  const handleChartSplitCommit = useCallback((split: number) => {
    try { localStorage.setItem('chartSplit-v2', String(split)); } catch {}
  }, []);

  // P3-8: Sound alert when a new signal appears during replay
  const [soundEnabled, _setSoundEnabled] = useState(true);
  const prevSignalCountRef = useRef(0);
  const soundEnabledRef = useRef(true);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  useEffect(() => {
    const prev = prevSignalCountRef.current;
    const curr = currentSignals.length;
    if (isPlaying && curr > prev && soundEnabledRef.current) {
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } catch { /* AudioContext not available */ }
    }
    prevSignalCountRef.current = curr;
  }, [currentSignals, isPlaying]);

  const displayCandle = hoverCandle ?? allCandles[currentIndex];
  const prev = hoverCandle
    ? allCandles[allCandles.findIndex(c => c.date === hoverCandle.date) - 1]
    : allCandles[currentIndex - 1];
  const stopLossPct = useSettingsStore(s => s.stopLossPercent);

  // Stop-loss line
  const currentCandle = allCandles[currentIndex];
  const ma5StopLoss = metrics.shares > 0 ? (currentCandle?.ma5 ?? null) : null;
  const costStopLoss = metrics.shares > 0 && metrics.avgCost > 0 ? metrics.avgCost * (1 - stopLossPct / 100) : null;
  const stopLossPrice = ma5StopLoss != null && costStopLoss != null
    ? Math.max(ma5StopLoss, costStopLoss)
    : (ma5StopLoss ?? costStopLoss ?? undefined);

  const currentDate = allCandles[currentIndex]?.date;

  const SIDE_TABS: Array<{ key: SideTab; label: string }> = [
    { key: 'conditions',  label: '條件' },
    { key: 'signals',     label: '訊號' },
    { key: 'chip',        label: '籌碼' },
    { key: 'fundamental', label: '基本面' },
  ];

  const sidebarTabs = (
    <div className="shrink-0 flex items-center gap-1">
      <div role="tablist" aria-label="分析面板" className="flex flex-1 rounded-lg overflow-hidden border border-border/60 text-xs">
        {SIDE_TABS.map(t => (
          <button key={t.key} role="tab" aria-selected={sideTab === t.key} aria-controls={`panel-${t.key}`}
            onClick={() => setSideTab(t.key)}
            className={`flex-1 py-2 font-medium transition-all ${
              sideTab === t.key ? 'bg-blue-600 text-foreground shadow-[0_0_8px_rgba(37,99,235,0.3)]' : 'bg-secondary/60 text-muted-foreground hover:bg-muted hover:text-foreground/80'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );

  const sidebarContent = (
    <div
      id={`panel-${sideTab}`}
      role="tabpanel"
      className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5"
    >
      {sideTab === 'conditions' && (
        <SectionBoundary section="買法條件">
          {showSanseView ? <SanSeConditionsPanel report={sanseConditions} /> : <ConditionsPanelSwitch />}
        </SectionBoundary>
      )}
      {sideTab === 'signals' && (
        <SectionBoundary section="訊號分析">
          {showSanseView ? <SanSeSignalsPanel report={sanseConditions} /> : <SignalSummaryCard />}
        </SectionBoundary>
      )}
      {sideTab === 'chip' && (
        currentStock ? (
          <SectionBoundary section="籌碼分析">
            {isCnTicker
              ? <CnChipPanel symbol={currentStock.ticker} />
              : <ChipDetailPanel symbol={currentStock.ticker} date={currentDate} />}
          </SectionBoundary>
        ) : (
          <EmptyState
            variant="compact"
            icon="📋"
            title="尚未載入股票"
            description="請先選擇一檔股票以查看籌碼資料"
          />
        )
      )}
      {sideTab === 'fundamental' && (
        currentStock ? (
          <SectionBoundary section="基本面分析">
            {isCnTicker
              ? <CnFundamentalPanel symbol={currentStock.ticker} />
              : <FundamentalSidebarPanel symbol={currentStock.ticker} date={targetDate ?? undefined} />}
          </SectionBoundary>
        ) : (
          <EmptyState
            variant="compact"
            icon="📊"
            title="尚未載入股票"
            description="請先選擇一檔股票以查看基本面分析"
          />
        )
      )}
    </div>
  );

  // 是否顯示深度決策面板：有選股且非大盤指數
  const showDecisionPanel = !!currentStock && !/^\^|^000001\.SS$/.test(currentStock.ticker);

  // 雙B戰法主圖疊加資料（價格線 + 買賣點）— 只有開關開 + 陸股/台股 + 抓到資料才畫
  const shuangBOverlay = showShuangB && sanseEnabled && sanse ? {
    zhineng: sanse.zhineng, zb4: sanse.zb4, zb5: sanse.zb5, duokong: sanse.duokong,
    markers: sanse.mainMarkers,
  } : null;
  // 副圖（主力狀態F / 捕撈季節）資料 — 對齊主圖 candle 由 IndicatorCharts 自行 map
  // 台股無換手率 → xysTiers 為 undefined（4 級彩柱不畫），金叉/動能柱照常
  const sanseZhuli = sanseEnabled && indicators.mainForce ? sanse?.zhuli ?? null : null;
  const sanseXys = sanseEnabled && indicators.season && sanse ? {
    xys0: sanse.xys0, xys1: sanse.xys1, xys2: sanse.xys2,
    subMarkers: sanse.subMarkers, xysTiers: sanse.xysTiers ?? null,
  } : null;

  // ABC 偵測器腳位疊加（除錯/驗證）— 選「ABC 突破」買法(J，舊代號 G)且非三色視圖時，
  // 把 detectABCBreakout 實際選的 A/B/C 腳 + 它的下降切線畫到走圖（用走圖游標 currentIndex 對齊面板）。
  const activeBuyMethod = useBacktestStore(s => s.activeBuyMethod);
  const abcOverlay = useMemo(() => {
    const isAbcMethod = activeBuyMethod === 'J' || activeBuyMethod === 'G';
    if (showSanseView || !isAbcMethod) return null;
    if (!allCandles.length || currentIndex < 0) return null;
    const disp = getABCDisplayStructure(allCandles, currentIndex);
    if (!disp) return null;
    const dateAt = (i: number) => allCandles[i]?.date;
    const mk = (i: number, label: string, position: 'aboveBar' | 'belowBar') => {
      const time = dateAt(i);
      return time ? { time, label, position } : null;
    };
    const markers = [
      mk(disp.legAHighIdx, 'A峰', 'aboveBar'),
      mk(disp.legALowIdx, 'A底', 'belowBar'),
      mk(disp.legBHighIdx, 'B峰', 'aboveBar'),
      mk(disp.legCLowIdx, 'C底', 'belowBar'),
    ].filter((m): m is { time: string; label: string; position: 'aboveBar' | 'belowBar' } => m != null);
    const aTime = dateAt(disp.legAHighIdx);
    const todayTime = dateAt(currentIndex);
    if (!aTime || !todayTime) return null;
    // 切線 2 點（A峰 → 今日延伸值）即 A峰→B峰 連線外推，B峰共線故 2 點足夠
    return {
      markers,
      trendline: [
        { time: aTime, value: disp.legAHigh },
        { time: todayTime, value: disp.trendlineValue },
      ],
      broke: disp.brokeTrendline,
    };
  }, [showSanseView, activeBuyMethod, allCandles, currentIndex]);

  return (
    // fullViewport=false 永遠允許整頁 vertical scroll（避免 ^TWII 時整頁鎖死無法捲動）
    // chart 區填滿到視窗底（header 49px + py-2 8px = 57px 上方位移 → 扣 58px 讓排底貼齊視窗底、今日簡報退到摺疊線下）
    <PageShell fullViewport={false} headerSlot={<StockSelector />}>
      <div className="flex-1 flex flex-col px-3 py-2 gap-3">
        <div className="flex flex-col md:flex-row gap-2 md:h-[calc(100vh-58px)] md:overflow-hidden">

        {/* Left: Chart */}
        <div className="w-full md:flex-1 md:min-w-[480px] flex flex-col min-w-0 min-h-[60vh] md:min-h-0 gap-1.5">
          <StockChartView
            isLoading={isLoadingStock}
            loadingOverlay={
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-card/90">
                <div className="w-3/4 max-w-md space-y-2 mb-4">
                  {/* Skeleton chart lines */}
                  <div className="flex items-end gap-[2px] h-24 justify-center">
                    {Array.from({ length: 30 }).map((_, i) => (
                      <div key={i} className="w-1.5 bg-muted/60 rounded-sm animate-pulse"
                        style={{ height: `${20 + Math.sin(i * 0.4) * 40 + 10}%`, animationDelay: `${i * 30}ms` }} />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-muted-foreground">載入資料中...</p>
                </div>
              </div>
            }
            topAlertSlot={
              <>
                {loadError && (
                  <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-red-900/30 border-b border-red-700/50 text-xs">
                    <span className="text-red-400">{loadError}</span>
                    <button onClick={() => { setLoadError(null); loadStock('2330', '1d', '2y'); }}
                      className="text-sky-400 hover:text-sky-300 underline">重試</button>
                  </div>
                )}
                {dataGaps.length > 0 && currentInterval === '1d' && (
                  <div className="shrink-0 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/30 text-yellow-400 text-xs flex items-center justify-between">
                    <span>
                      資料斷層：{dataGaps.map((g: { fromDate: string; toDate: string; calendarDays: number }) => `${g.fromDate} → ${g.toDate}（${g.calendarDays}天）`).join('、')}
                    </span>
                    <button
                      onClick={() => { if (!currentStock) return; loadStock(currentStock.ticker.replace(/\.(TW|TWO|SS|SZ)$/i, ''), '1d', '2y').catch(() => {}); }}
                      className="text-yellow-300 hover:text-yellow-200 underline ml-2 whitespace-nowrap">
                      重新下載
                    </button>
                  </div>
                )}
              </>
            }
            toolbarSlot={displayCandle && (
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
                currentInterval={currentInterval}
                onIntervalChange={handleIntervalChange}
                maToggles={maToggles}
                onMaToggle={key => setMaToggles(p => ({ ...p, [key]: !p[key] }))}
                showBollinger={showBollinger}
                onBollingerToggle={() => setShowBollinger(v => !v)}
                indicators={indicators}
                onIndicatorToggle={key => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                showShuangB={showShuangB}
                onShuangBToggle={() => setShowShuangB(v => !v)}
                showMarkers={showMarkers}
                onMarkersToggle={() => setShowMarkers(v => !v)}
                signalStrengthMin={signalStrengthMin}
                onSignalStrengthChange={setSignalStrengthMin}
                showPivots={showPivots}
                onPivotsToggle={() => setShowPivots(v => !v)}
                showSupportResistance={showSupportResistance}
                onSupportResistanceToggle={() => setShowSupportResistance(v => !v)}
                showNeckline={showNeckline}
                onNecklineToggle={() => setShowNeckline(v => !v)}
                showPattern={showPattern}
                onPatternToggle={() => setShowPattern(v => !v)}
                showAscendingTrendline={showAscendingTrendline}
                onAscendingTrendlineToggle={() => setShowAscendingTrendline(v => !v)}
                showDescendingTrendline={showDescendingTrendline}
                onDescendingTrendlineToggle={() => setShowDescendingTrendline(v => !v)}
                showAscendingChannel={showAscendingChannel}
                onAscendingChannelToggle={() => setShowAscendingChannel(v => !v)}
                showDescendingChannel={showDescendingChannel}
                onDescendingChannelToggle={() => setShowDescendingChannel(v => !v)}
                showConsolidationLines={showConsolidationLines}
                onConsolidationLinesToggle={() => setShowConsolidationLines(v => !v)}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
                onPrev={prevCandle}
                onNext={nextCandle}
                onReset={resetReplay}
                canPrev={currentIndex > 0 && !isPlaying}
                canNext={currentIndex < allCandles.length - 1 && !isPlaying}
                onPrevBuyPoint={() => jumpToBuyPoint('prev')}
                onNextBuyPoint={() => jumpToBuyPoint('next')}
                canPrevBuyPoint={canPrevBuyPoint && !isPlaying}
                canNextBuyPoint={canNextBuyPoint && !isPlaying}
                ticker={currentStock?.ticker}
                market={market}
                scanDate={scanDate ?? null}
              />
            )}
            chartProps={{
              candles: visibleCandles,
              signals: currentSignals,
              chartMarkers: [...(showMarkers ? mergedMarkers : []), ...blowoffMarkers],
              avgCost: metrics.shares > 0 ? metrics.avgCost : undefined,
              stopLossPrice,
              onCrosshairMove: setHoverCandle,
              onDoubleClick: (candle) => {
                const idx = allCandles.findIndex(c => c.date === candle.date);
                if (idx >= 0) useReplayStore.getState().jumpToIndex(idx);
              },
              maToggles,
              showBollinger,
              showPivots,
              showSupportResistance,
              showAscendingTrendline,
              showDescendingTrendline,
              showAscendingChannel,
              showDescendingChannel,
              showConsolidationLines,
              showNeckline,
              showPattern,
              highlightDate: targetDate ?? undefined,
              lockedPattern,
              shuangB: shuangBOverlay,
              abcOverlay,
            }}
            indicatorProps={{
              candles: visibleCandles,
              hoverCandle,
              indicators,
              ticker: currentStock?.ticker,
              chips,
              chipsLoading,
              sanseZhuli,
              sanseXys,
            }}
            showIndicators={showIndicators}
            onToggleIndicators={() => setShowIndicators(v => !v)}
            chartSplit={chartSplit}
            onChartSplitChange={setChartSplit}
            onChartSplitCommit={handleChartSplitCommit}
          />
        </div>

        {/* Middle: Sidebar */}
        <div className="w-full md:w-64 shrink-0 flex flex-col min-h-0 gap-2">
          {/* Mobile: Sheet drawer */}
          <div className="md:hidden">
            <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
              <SheetTrigger className="flex items-center justify-between w-full px-3 py-2 bg-secondary rounded-lg text-xs text-foreground/80 border border-border">
                <span>分析面板</span>
                <span className={`transition-transform ${mobileSheetOpen ? 'rotate-180' : ''}`}>&#9660;</span>
              </SheetTrigger>
              <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
                <SheetHeader className="px-4 pt-4 pb-2 shrink-0">
                  <SheetTitle className="text-sm">分析面板</SheetTitle>
                </SheetHeader>
                <div className="flex-1 flex flex-col min-h-0 px-3 pb-3 gap-2">
                  {sidebarTabs}
                  {sidebarContent}
                </div>
              </SheetContent>
            </Sheet>
          </div>

          {/* Desktop: inline sidebar */}
          <div id="analysis-sidebar" className="hidden md:flex flex-col min-h-0 gap-2">
            {sidebarTabs}
            {sidebarContent}
          </div>

          {/* 自選股 / 持倉 摺疊面板 */}
          <BottomPanel onSelectHolding={() => setSideTab('signals')} />

          {/* 數據健康度 L1-L4 */}
          <div className="shrink-0 px-2 py-1.5">
            <DataHealthBadge market={useBacktestStore(s => s.market)} forceDown />
          </div>
        </div>

        {/* ── Right: 多源候選 panel（tab：策略掃描 / YouTube 提及） ── */}
        <div className={`shrink-0 flex flex-col min-h-0 border border-border bg-card/80 rounded-lg overflow-hidden transition-all duration-300 ${
          scannerOpen
            ? 'w-full md:w-[600px] min-h-[50vh] md:min-h-0'
            : 'w-full md:w-8 h-10 md:h-auto'
        }`}>
          {scannerOpen ? (
            <>
              {/* Panel header：tab 切換 + close button（mobile 用 icon + 短名，desktop 用完整名）*/}
              <div role="tablist" aria-label="右側資料來源" className="shrink-0 flex items-stretch border-b border-border bg-secondary/30 whitespace-nowrap">
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === 'scan'}
                  onClick={() => setRightTab('scan')}
                  className={`flex items-center gap-1 px-2 md:px-3 py-2 text-xs font-semibold transition-colors ${
                    rightTab === 'scan'
                      ? 'text-foreground border-b-2 border-sky-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="朱老師策略掃描"
                >
                  <Search className="w-3 h-3" />
                  <span className="hidden md:inline">策略掃描</span>
                  <span className="md:hidden">掃描</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === 'youtube'}
                  onClick={() => setRightTab('youtube')}
                  className={`flex items-center gap-1 px-2 md:px-3 py-2 text-xs font-semibold transition-colors ${
                    rightTab === 'youtube'
                      ? 'text-foreground border-b-2 border-purple-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="YouTube 節目提及股票"
                >
                  <span aria-hidden="true">📺</span>
                  <span className="hidden md:inline">YouTube 提及</span>
                  <span className="md:hidden">節目</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === 'fundamental'}
                  onClick={() => setRightTab('fundamental')}
                  className={`flex items-center gap-1 px-2 md:px-3 py-2 text-xs font-semibold transition-colors ${
                    rightTab === 'fundamental'
                      ? 'text-foreground border-b-2 border-orange-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="基本面補漲 Top 20"
                >
                  <span aria-hidden="true">📊</span>
                  <span className="hidden md:inline">基本面補漲</span>
                  <span className="md:hidden">補漲</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === 'pool'}
                  onClick={() => setRightTab('pool')}
                  className={`flex items-center gap-1 px-2 md:px-3 py-2 text-xs font-semibold transition-colors ${
                    rightTab === 'pool'
                      ? 'text-foreground border-b-2 border-emerald-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="多源候選股票池"
                >
                  <span aria-hidden="true">🗂</span>
                  <span>候選池</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === 'agent'}
                  onClick={() => setRightTab('agent')}
                  className={`flex items-center gap-1 px-2 md:px-3 py-2 text-xs font-semibold transition-colors ${
                    rightTab === 'agent'
                      ? 'text-foreground border-b-2 border-amber-500 -mb-px bg-card/60'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="多代理已完成決策"
                >
                  <span aria-hidden="true">🤖</span>
                  <span className="hidden md:inline">多代理</span>
                  <span className="md:hidden">代理</span>
                </button>
                <div className="flex-1" />
                <button onClick={() => setScannerOpen(false)}
                  className="px-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="收起面板"
                >
                  <ChevronDown className="w-3.5 h-3.5 rotate-90" />
                </button>
              </div>

              {/* Tab content */}
              <div className="animate-fade-in flex-1 min-h-0">
                {rightTab === 'scan' && (
                  <ScanPanelVertical onSelectStock={handleScanSelectStock} />
                )}
                {rightTab === 'youtube' && (
                  <YoutubeStocksPanel
                    date={tabDate}
                    onDateChange={setTabDate}
                    onSelectStock={handleYoutubeSelectStock}
                    // 統一以「現在看的股票」為準，4 個 tab 之間 highlight 同步
                    selectedCode={currentStock?.ticker?.replace(/\.(TW|TWO|SS|SZ)$/i, '') ?? null}
                  />
                )}
                {rightTab === 'fundamental' && (
                  <FundamentalRevaluationPanel
                    date={tabDate}
                    onDateChange={setTabDate}
                    onSelectStock={handleYoutubeSelectStock}
                    selectedCode={currentStock?.ticker?.replace(/\.(TW|TWO|SS|SZ)$/i, '') ?? null}
                  />
                )}
                {rightTab === 'pool' && (
                  <CandidatesPoolPanel
                    onSelectStock={handlePoolSelectStock}
                    selectedSymbol={currentStock?.ticker}
                    defaultDate={tabDate}
                    onDateChange={setTabDate}
                  />
                )}
                {rightTab === 'agent' && (
                  <MultiAgentTopPanel
                    onSelectStock={handleAgentSelectStock}
                    selectedSymbol={currentStock?.ticker}
                    defaultDate={tabDate}
                    onDateChange={setTabDate}
                  />
                )}
              </div>
            </>
          ) : (
            /* Collapsed: horizontal bar on mobile, vertical label on desktop */
            <button
              onClick={() => setScannerOpen(true)}
              className="flex-1 flex flex-row md:flex-col items-center justify-center gap-2 hover:bg-muted/50 transition-colors group"
              title="掃描"
            >
              <Search className="w-3.5 h-3.5 text-muted-foreground group-hover:text-blue-400 transition-colors" />
              <span className="text-[10px] text-muted-foreground group-hover:text-foreground transition-colors md:[writing-mode:vertical-rl]">掃描</span>
            </button>
          )}
        </div>

        </div>{/* end 3-col flex */}

        {/* 今日簡報 — 永遠顯示（不限選股） */}
        <TodayBriefing market={market} />

        {/* 深度決策面板（A1：走圖區下方垂直展開）— 選了個股才顯示 */}
        {showDecisionPanel && currentStock && (
          <DecisionPanel symbol={currentStock.ticker} date={targetDate ?? undefined} />
        )}

      </div>
      {/* P1-5: Keyboard shortcut help overlay */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl p-5 w-80 max-w-[90vw]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-foreground">鍵盤快捷鍵</h2>
              <button onClick={() => setShowHelp(false)} aria-label="關閉" className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
            </div>
            <div className="space-y-1 text-xs">
              {([
                ['←  /  →', '前一根 / 下一根 K 棒'],
                ['空白鍵', '播放 / 暫停'],
                ['I', '展開 / 收起副圖指標'],
                ['1', '切換至「條件」面板'],
                ['2', '切換至「訊號」面板'],
                ['3', '切換至「籌碼」面板'],
                ['4', '切換至「基本面」面板'],
                ['5', '展開 / 收起掃描面板'],
                ['B', '買入（全倉）'],
                ['S', '賣出（半倉）'],
                ['Q', '全部賣出'],
                ['?', '顯示 / 關閉本說明'],
              ] as [string, string][]).map(([key, desc]) => (
                <div key={key} className="flex items-center gap-3 py-1 border-b border-border/50 last:border-0">
                  <kbd className="shrink-0 w-24 text-center px-2 py-0.5 rounded bg-secondary text-foreground/80 font-mono text-[10px]">{key}</kbd>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 手機走圖全螢幕視圖 */}
      {mobileChartFullscreen && (
        <div className="md:hidden fixed inset-0 z-[100] bg-background flex flex-col">
          <div className="shrink-0 flex items-center gap-2 px-2 py-2 border-b border-border bg-card">
            <BackButton
              onClick={closeMobileChart}
              label="返回掃描清單"
              className="shrink-0 p-1.5 rounded hover:bg-muted text-foreground"
            />
            <div className="flex-1 min-w-0">
              <StockSelector />
            </div>
          </div>

          {displayCandle && (
            <div className="shrink-0">
              <ChartToolbar
                candle={displayCandle}
                prevCandle={prev}
                isHover={!!hoverCandle}
                stockName={currentStock?.name}
                trend={currentTrend}
                currentInterval={currentInterval}
                onIntervalChange={handleIntervalChange}
                maToggles={maToggles}
                onMaToggle={key => setMaToggles(p => ({ ...p, [key]: !p[key] }))}
                showBollinger={showBollinger}
                onBollingerToggle={() => setShowBollinger(v => !v)}
                indicators={indicators}
                onIndicatorToggle={key => setIndicators(p => ({ ...p, [key]: !p[key] }))}
                showShuangB={showShuangB}
                onShuangBToggle={() => setShowShuangB(v => !v)}
                showMarkers={showMarkers}
                onMarkersToggle={() => setShowMarkers(v => !v)}
                signalStrengthMin={signalStrengthMin}
                onSignalStrengthChange={setSignalStrengthMin}
                showPivots={showPivots}
                onPivotsToggle={() => setShowPivots(v => !v)}
                showSupportResistance={showSupportResistance}
                onSupportResistanceToggle={() => setShowSupportResistance(v => !v)}
                showNeckline={showNeckline}
                onNecklineToggle={() => setShowNeckline(v => !v)}
                showPattern={showPattern}
                onPatternToggle={() => setShowPattern(v => !v)}
                showAscendingTrendline={showAscendingTrendline}
                onAscendingTrendlineToggle={() => setShowAscendingTrendline(v => !v)}
                showDescendingTrendline={showDescendingTrendline}
                onDescendingTrendlineToggle={() => setShowDescendingTrendline(v => !v)}
                showAscendingChannel={showAscendingChannel}
                onAscendingChannelToggle={() => setShowAscendingChannel(v => !v)}
                showDescendingChannel={showDescendingChannel}
                onDescendingChannelToggle={() => setShowDescendingChannel(v => !v)}
                showConsolidationLines={showConsolidationLines}
                onConsolidationLinesToggle={() => setShowConsolidationLines(v => !v)}
                avgCost={metrics.avgCost}
                shares={metrics.shares}
                onPrev={prevCandle}
                onNext={nextCandle}
                onReset={resetReplay}
                canPrev={currentIndex > 0 && !isPlaying}
                canNext={currentIndex < allCandles.length - 1 && !isPlaying}
                onPrevBuyPoint={() => jumpToBuyPoint('prev')}
                onNextBuyPoint={() => jumpToBuyPoint('next')}
                canPrevBuyPoint={canPrevBuyPoint && !isPlaying}
                canNextBuyPoint={canNextBuyPoint && !isPlaying}
                ticker={currentStock?.ticker}
                market={market}
                scanDate={scanDate ?? null}
              />
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col">
            {isLoadingStock ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mr-2" />
                <span className="text-sm text-muted-foreground">載入中…</span>
              </div>
            ) : (
              <>
                <div className="flex-[3] min-h-0">
                  <ErrorBoundary>
                    <CandleChart
                      candles={visibleCandles}
                      signals={currentSignals}
                      chartMarkers={showMarkers ? mergedMarkers : []}
                      avgCost={metrics.shares > 0 ? metrics.avgCost : undefined}
                      stopLossPrice={stopLossPrice}
                      onCrosshairMove={setHoverCandle}
                      fillContainer
                      maToggles={maToggles}
                      showBollinger={showBollinger}
                      showPivots={showPivots}
                      showSupportResistance={showSupportResistance}
                      showAscendingTrendline={showAscendingTrendline}
                      showDescendingTrendline={showDescendingTrendline}
                      showAscendingChannel={showAscendingChannel}
                      showDescendingChannel={showDescendingChannel}
                      showConsolidationLines={showConsolidationLines}
                      showNeckline={showNeckline}
                      showPattern={showPattern}
                      highlightDate={targetDate ?? undefined}
                      lockedPattern={lockedPattern}
                      shuangB={shuangBOverlay}
                      abcOverlay={abcOverlay}
                    />
                  </ErrorBoundary>
                </div>
                {showIndicators && (
                  <div className="flex-[2] min-h-0 border-t border-border">
                    <ErrorBoundary>
                      <IndicatorCharts candles={visibleCandles} hoverCandle={hoverCandle} indicators={indicators} ticker={currentStock?.ticker} chips={chips} chipsLoading={chipsLoading} sanseZhuli={sanseZhuli} sanseXys={sanseXys} />
                    </ErrorBoundary>
                  </div>
                )}
                <button
                  onClick={() => setShowIndicators(v => !v)}
                  className="shrink-0 py-1 text-[10px] text-muted-foreground hover:text-foreground bg-secondary/60 border-t border-border"
                >
                  {showIndicators ? '▼ 收起副圖' : '▲ 展開副圖'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
